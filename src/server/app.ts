import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { planImport } from "../domain/import-plan.ts";
import { isOutreachStatus } from "../domain/outreach-status.ts";
import { checkScraperFile, parseScraperExport } from "../domain/scraper-export.ts";
import type { ApiError, CallOutcomeAnswer, Campaign, FileCheckResult, SmsProviderStatus } from "../shared/api.ts";
import { CAMPAIGN_NAME_MAX, DEFINITION_MAX_BYTES, STEP_BODY_MAX, STEP_SUBJECT_MAX } from "../shared/limits.ts";
import { checkApiRequest } from "./guard.ts";
import { invalidBodyMessage, requestObject } from "./request-body.ts";
import type { OutreachStore } from "./persistence/store.ts";
import { launchCheck } from "../domain/sequence/blockers.ts";
import { definitionProblems, emptyDefinition, liveTracks, type CampaignDefinition } from "../domain/sequence/definition.ts";
import { Engine } from "./engine/engine.ts";
import type { StoredDefinition } from "./engine/engine-store.ts";
import { UnconnectedEmailPort, UnprovisionedSmsPort } from "./engine/ports.ts";
import { accountView, needsAttention, progressView } from "./engine/views.ts";
import { callsView, callTaskView, todayView } from "./engine/call-views.ts";
import { READ_WAIT_MS, TICK_MS, type WorkerProgress } from "./worker.ts";
import { DEFAULT_RULES, type Rules } from "./engine/rules.ts";
import type { CampaignDetail, CampaignListItem, CampaignSequenceSummary, SequenceView } from "../shared/api.ts";
import { beforeLaunchView, copyPreview } from "./before-launch.ts";
import { activityOf } from "./activity.ts";
import { registerEmailProviderRoutes, type EmailProviderSource } from "./instantly/routes.ts";

export interface AppDependencies {
  readonly store: OutreachStore;
  /** Current time as an ISO-8601 string. */
  readonly now: () => string;
  readonly newId: () => string;
  /** The sequence engine. Without one, the app runs an engine with no connected email provider. */
  readonly engine?: Pick<Engine, "launch" | "logCallOutcome" | "nextWakeAt" | "callsPlacedThrough" | "nextCallWakeAt">;
  /**
   * The engine's worker, when one runs (the running app). A clock-driven read the server asked for
   * (`expected`, its own `nextChangeAt`) that the worker has not reached yet waits for its next tick.
   */
  readonly worker?: WorkerProgress;
  /** The email provider's own description, for GET /api/email-provider; absent when none is connected. */
  readonly emailProvider?: EmailProviderSource | null;
  /**
   * The SMS provider behind the engine, for GET /api/sms-provider: `none` in the running app, since
   * no SMS provider is provisioned (#28); `test-simulator` only in the test harness's fake.
   */
  readonly smsProvider?: "none" | "test-simulator";
  /** The engine's rules, as the read models use them; the tests' broken engines replace entries (ADR 0003 9.2). */
  readonly rules?: Partial<Rules>;
}

const windowRule = requestObject({ day: z.number().int().min(0).max(6), start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(24) });
const stepBody = requestObject({
  id: z.string().trim().min(1).max(100),
  waitDays: z.number(),
  subject: z.string().max(STEP_SUBJECT_MAX).default(""),
  body: z.string().max(STEP_BODY_MAX),
  threading: z.enum(["new_subject", "continue_thread"]),
  removed: z.boolean().default(false),
});
const trackBody = requestObject({
  id: z.string().trim().min(1).max(100),
  channel: z.enum(["email", "sms", "call"]),
  branch: z.enum(["main", "win_back"]).default("main"),
  window: z.array(windowRule).max(14),
  steps: z.array(stepBody).max(50),
  start: z.union([requestObject({ kind: z.literal("entry") }), requestObject({ kind: z.literal("after"), trackId: z.string(), delayDays: z.number() })]).default({ kind: "entry" }),
  removed: z.boolean().default(false),
  declinedPath: z.enum(["stop", "continue", "win_back"]).optional(),
});
const definitionBody = requestObject({
  timezone: z.string().trim().min(1),
  callSkipLimitDays: z.number().default(2),
  emailPool: z.array(z.string().min(1).max(200)).max(100),
  smsPool: z.array(z.string().min(1).max(200)).max(100).default([]),
  callScript: z.string().max(20_000).default(""),
  tracks: z.array(trackBody).max(20),
  /** Who wrote the save (ADR 0003 1.1.1): its editing session, its number there, and the revision it last saw. */
  save: requestObject({ session: z.string().min(1).max(100), seq: z.number().int().nonnegative(), base: z.number().int().nonnegative() }).optional(),
});

/** The user's zone: the machine's, which a campaign's default zone starts from (ADR 0003 1.1). */
const machineZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const callSettingsBody = requestObject({
  dailyCapacity: z.number().int("The daily call capacity is a whole number.").positive("The daily call capacity is at least 1.").max(1_000),
  userZone: z.string().trim().refine((z) => isTimeZone(z), "Use an IANA time zone such as Europe/London."),
});
// Not interested, callback and redial arrive with tickets 15 and 16; they are refused here until then.
const outcomeBody = requestObject({
  /**
   * The client's key for this one action: the same key answers with the first result and stores
   * nothing again, so a retry or a double click never logs an outcome or a note twice (verifier B3).
   */
  requestId: z.string().trim().min(1, "Send a request id with each outcome.").max(200),
  outcome: z.enum(["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"], { message: "Choose one of the outcomes this release offers: no answer, voicemail left, gatekeeper or not reached, wrong or dead number, interested, or skip for now." }),
  numberId: z.string().min(1).max(200).nullish(),
  note: z.string().max(10_000).default(""),
  noteScope: z.enum(["person", "company"]).default("person"),
});

const SEARCH_LIMIT_DEFAULT = 100;
const SEARCH_LIMIT_MAX = 500;
const IMPORT_BODY_LIMIT = 50 * 1024 * 1024;

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const fileNames = requestObject({ people: z.string().max(300).nullish(), businesses: z.string().max(300).nullish() })
  .nullish();

/** Both files or neither: a campaign can be created before its first import. */
const scraperFiles = {
  businessesCsv: z.string().min(1, "Add the Businesses file.").optional(),
  peopleCsv: z.string().min(1, "Add the People file.").optional(),
  fileNames,
};

const newCampaignBody = requestObject({
  name: z.string().trim().min(1, "Give the campaign a name.").max(CAMPAIGN_NAME_MAX, `Keep the campaign name to ${CAMPAIGN_NAME_MAX} characters or fewer.`),
  defaultTimezone: z
    .string()
    .trim()
    .refine(isTimeZone, "Use an IANA time zone such as Europe/London.")
    .nullish(),
  ...scraperFiles,
}).refine((b) => (b.businessesCsv === undefined) === (b.peopleCsv === undefined), "Add both the People and Businesses files.");

const importBody = requestObject({
  businessesCsv: z.string().min(1, "Add the Businesses file."),
  peopleCsv: z.string().min(1, "Add the People file."),
  fileNames,
});

const launchBody = requestObject({ definitionVersion: z.number().int().optional() });

const checkBody = requestObject({ businessesCsv: z.string().optional(), peopleCsv: z.string().optional() });

/** The HTTP interface. Every route is under /api; the web client is served separately. */
export function createApp({ store, now, newId, engine: givenEngine, worker, emailProvider, smsProvider = "none", rules: givenRules }: AppDependencies): Hono {
  const rules: Rules = { ...DEFAULT_RULES, ...givenRules };
  const engine = givenEngine ?? new Engine({ store: store.engine, port: new UnconnectedEmailPort(), smsPort: new UnprovisionedSmsPort(), now: () => Date.parse(now()), newId });
  const app = new Hono().basePath("/api");
  app.use(async (c, next) => {
    const verdict = checkApiRequest({
      method: c.req.method,
      host: c.req.header("host") ?? new URL(c.req.url).host,
      origin: c.req.header("origin") ?? null,
      secFetchSite: c.req.header("sec-fetch-site") ?? null,
      contentType: c.req.header("content-type") ?? null,
    });
    if (!verdict.ok) {
      return c.json<ApiError>({ error: { code: verdict.status === 415 ? "unsupported_media_type" : "forbidden", message: verdict.message } }, verdict.status);
    }
    await next();
    return undefined;
  });
  const withinImportLimit = bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: (c) => tooLarge(c) });

  /** Parses, plans and applies one import; with `create`, creates the campaign in the same step. */
  const runImport = async (
    c: Context,
    campaign: { create: Campaign } | { id: string },
    body: { businessesCsv: string; peopleCsv: string; fileNames?: z.infer<typeof fileNames> },
  ) => {
    const parsed = parseScraperExport(body);
    if (!parsed.ok) {
      return c.json<ApiError>(
        {
          error: {
            code: "invalid_export",
            message: "Nothing was imported. Fix the files and choose them again.",
            problems: parsed.problems,
          },
        },
        400,
      );
    }
    if (!(await store.remembersAppliedRows())) {
      return c.json<ApiError>(
        {
          error: {
            code: "database_before_provenance",
            message:
              "This database was created before imports remembered the rows they applied, so importing into it could duplicate people. Nothing was imported. Recreate the database (delete it, or run pnpm seed:dev for development data) and import again.",
          },
        },
        409,
      );
    }
    const importedAt = now();
    const record = await store.importIntoCampaign({
      campaign,
      importId: newId(),
      importedAt,
      fileNames: { people: body.fileNames?.people ?? null, businesses: body.fileNames?.businesses ?? null },
      plan: (directory) => planImport({ directory, scraped: parsed.value, now: importedAt, newId }),
    });
    return c.json({ campaign: await store.campaign(record.campaignId), import: record }, 201);
  };

  /** Whether the campaign has launched and its live main-sequence tracks' channels (ticket 12c). */
  const sequenceSummary = async (campaignId: string): Promise<CampaignSequenceSummary> => {
    const row = await store.engine.campaign(campaignId);
    return {
      launchedAt: row?.launchedAt == null ? null : new Date(row.launchedAt).toISOString(),
      tracks: row?.definition ? liveTracks(row.definition, "main").map((t) => t.channel) : [],
    };
  };

  app.get("/campaigns", async (c) => {
    const campaigns: CampaignListItem[] = [];
    for (const item of await store.listCampaigns()) campaigns.push({ ...item, sequence: await sequenceSummary(item.id) });
    return c.json({ campaigns });
  });

  app.post("/campaigns", withinImportLimit, async (c) => {
    const parsed = newCampaignBody.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const { name, defaultTimezone, businessesCsv, peopleCsv } = parsed.data;
    const campaign: Campaign = { id: newId(), name, defaultTimezone: defaultTimezone || null, createdAt: now() };
    if (businessesCsv !== undefined && peopleCsv !== undefined) {
      return runImport(c, { create: campaign }, { businessesCsv, peopleCsv, fileNames: parsed.data.fileNames });
    }
    await store.createCampaign(campaign);
    return c.json({ campaign }, 201);
  });

  app.get("/campaigns/:id", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    const leadCount = (await store.listCampaigns()).find((item) => item.id === campaign.id)?.leadCount ?? 0;
    return c.json<CampaignDetail>({ campaign, imports: await store.listImports(campaign.id), leadCount, sequence: await sequenceSummary(campaign.id) });
  });

  app.get("/campaigns/:id/imports", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    return c.json({ imports: await store.listImports(campaign.id) });
  });

  app.get("/campaigns/:id/imports/:importId", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    const record = campaign ? await store.importRecord(campaign.id, c.req.param("importId")) : null;
    if (!campaign || !record) return notFound(c, "import");
    return c.json({ campaign, import: record });
  });

  app.post("/campaigns/:id/imports", withinImportLimit, async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    const body = importBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    return runImport(c, { id: campaign.id }, body.data);
  });

  app.post("/scraper-files/check", withinImportLimit, async (c) => {
    const body = checkBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const { businessesCsv, peopleCsv } = body.data;
    const businesses = businessesCsv === undefined ? null : checkScraperFile("businesses", businessesCsv);
    const people = peopleCsv === undefined ? null : checkScraperFile("people", peopleCsv);
    let pair: string | null = null;
    if (businessesCsv !== undefined && peopleCsv !== undefined && businesses?.ok && people?.ok) {
      const both = parseScraperExport({ businessesCsv, peopleCsv });
      pair = both.ok ? null : (both.problems.find((p) => p.file === "pair")?.message ?? null);
    }
    return c.json<FileCheckResult>({ businesses, people, pair });
  });

  app.get("/leads", async (c) => {
    const status = c.req.query("status") || null;
    if (status !== null && !isOutreachStatus(status)) {
      return c.json<ApiError>({ error: { code: "invalid_query", message: `Unknown outreach status: ${status}` } }, 400);
    }
    const requested = Number(c.req.query("limit") ?? SEARCH_LIMIT_DEFAULT);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;
    return c.json(
      await store.searchLeads({
        text: c.req.query("q") ?? "",
        campaignId: c.req.query("campaign") || null,
        companyId: c.req.query("company") || null,
        status,
        limit,
      }),
    );
  });

  app.get("/people/:id", async (c) => {
    const person = await store.person(c.req.param("id"));
    return person ? c.json(person) : notFound(c, "person");
  });

  app.get("/companies/:id", async (c) => {
    const company = await store.company(c.req.param("id"));
    return company ? c.json(company) : notFound(c, "company");
  });

  // -------------------------------------------------------------------------------------------
  // The sequence engine (ADR 0003), ticket 12b.

  /** `written`: the row as the transaction that wrote it left it, so the answer is that write's (PR 41 council, item 4). */
  const sequenceView = async (campaignId: string, defaultZone: string | null, written?: StoredDefinition): Promise<SequenceView | null> => {
    const row = written ?? (await store.engine.campaign(campaignId));
    if (!row) return null;
    const definition = row.definition ?? emptyDefinition(defaultZone ?? machineZone());
    const at = Date.parse(now());
    const { leads, accounts } = await store.engine.launchInputs(campaignId);
    const labels = await store.engine.accountLabels();
    return {
      campaignId,
      definition,
      definitionVersion: row.definitionVersion,
      editedAt: row.definitionEditedAt,
      launchedAt: row.launchedAt === null ? null : new Date(row.launchedAt).toISOString(),
      launch: launchCheck(definition, leads, accounts),
      accounts: (await store.engine.accounts(at)).map((a) => accountView(a, labels[a.id] ?? a.id)),
    };
  };

  app.get("/campaigns/:id/sequence", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    const view = campaign ? await sequenceView(campaign.id, campaign.defaultTimezone) : null;
    return view ? c.json(view) : notFound(c, "campaign");
  });

  const withinDefinitionLimit = bodyLimit({
    maxSize: DEFINITION_MAX_BYTES,
    onError: (c) => c.json<ApiError>({ error: { code: "too_large", message: `The sequence is larger than ${DEFINITION_MAX_BYTES / 1024} KB, so it cannot be saved safely. Shorten the emails.` } }, 413),
  });

  app.put("/campaigns/:id/sequence", withinDefinitionLimit, async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    const body = definitionBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const { save, ...fields } = body.data;
    // A declined path is stored only when the canvas set one; the phone track's fields travel in the same save (ADR 0003 1.1.1).
    const definition: CampaignDefinition = { ...fields, tracks: fields.tracks.map(({ declinedPath, ...t }) => (declinedPath ? { ...t, declinedPath } : t)) };
    const previous = (await store.engine.campaign(campaign.id))?.definition ?? null;
    const problems = definitionProblems(definition, previous);
    if (problems.length > 0) return c.json<ApiError>({ error: { code: "invalid_sequence", message: problems.join(" ") } }, 400);
    const result = await store.engine.saveDefinition(campaign.id, definition, now(), save ?? null);
    const saved = result.outcome;
    if (saved === "missing") return notFound(c, "campaign");
    if (saved === "superseded") {
      return c.json<ApiError>({ error: { code: "superseded", message: "A later change from this page was already saved." } }, 409);
    }
    if (saved === "conflict") {
      return c.json<ApiError>({ error: { code: "edit_conflict", message: "This campaign’s sequence was changed elsewhere since this page loaded it, so this change was not saved." } }, 409);
    }
    if (saved === "launched") {
      return c.json<ApiError>({ error: { code: "launched", message: "This campaign is running. Editing a running campaign arrives with a later release." } }, 409);
    }
    return c.json(await sequenceView(campaign.id, campaign.defaultTimezone, result.stored));
  });

  app.post("/campaigns/:id/launch", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    // Launch takes one option, the revision the page last saw; any other field is refused, like any other.
    const body = launchBody.safeParse((await readJson(c)) ?? {});
    if (!body.success) return invalid(c, body.error);
    const outcome = await engine.launch(campaign.id, body.data.definitionVersion);
    if (!outcome.ok && outcome.reason === "changed") {
      return c.json<ApiError>({ error: { code: "changed_elsewhere", message: "The sequence was changed elsewhere since this page loaded it, so nothing was launched. Load the saved version first." } }, 409);
    }
    if (!outcome.ok) {
      const message =
        outcome.reason === "already_launched" ? "This campaign has already launched."
        : outcome.check?.nothingToLaunch ? "Add a track to launch."
        : outcome.reason === "no_definition" ? "Add a track to launch."
        : `Launch is blocked: ${outcome.check?.blockers.map((b) => b.message).join(" ") ?? ""}`;
      return c.json<ApiError>({ error: { code: outcome.reason === "already_launched" ? "already_launched" : "launch_blocked", message } }, 409);
    }
    return c.json(await sequenceView(campaign.id, campaign.defaultTimezone, "stored" in outcome ? outcome.stored : undefined));
  });

  // The campaign editor's Before launch tab (ticket 12c): read models only.
  const definitionOf = async (campaignId: string, defaultZone: string | null) => {
    const row = await store.engine.campaign(campaignId);
    return row ? { definition: row.definition ?? emptyDefinition(defaultZone ?? machineZone()), launched: row.launchedAt !== null } : null;
  };

  app.get("/campaigns/:id/before-launch", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    const def = campaign ? await definitionOf(campaign.id, campaign.defaultTimezone) : null;
    if (!campaign || !def) return notFound(c, "campaign");
    // `load=0`: coverage and merge fields only, without the load projection (the Sequence and Leads tabs).
    const withLoad = c.req.query("load") !== "0";
    return c.json(await beforeLaunchView(store, campaign.id, def.definition, def.launched || !withLoad, Date.parse(now())));
  });

  app.get("/campaigns/:id/preview/:enrollmentId", async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    const def = campaign ? await definitionOf(campaign.id, campaign.defaultTimezone) : null;
    const preview = campaign && def ? await copyPreview(store, campaign.id, c.req.param("enrollmentId"), def.definition, Date.parse(now())) : null;
    return preview ? c.json(preview) : notFound(c, campaign ? "lead in this campaign" : "campaign");
  });

  // The timeline's campaign activity on a person or company-lead record (ticket 12c).
  app.get("/people/:id/activity", async (c) => {
    const person = await store.person(c.req.param("id"));
    return person ? c.json({ entries: await activityOf(store, person.enrollments, Date.parse(now()), "person") }) : notFound(c, "person");
  });

  app.get("/companies/:id/activity", async (c) => {
    const company = await store.company(c.req.param("id"));
    return company ? c.json({ entries: await activityOf(store, company.enrollments, Date.parse(now()), "company") }) : notFound(c, "company");
  });

  app.get("/enrollments/:id", async (c) => {
    const at = Date.parse(now());
    const state = await store.engine.subject(c.req.param("id"), at);
    return state ? c.json(progressView(state, at)) : notFound(c, "enrollment");
  });

  // -------------------------------------------------------------------------------------------
  // Calls (ticket 14). The user dials on their own phone; nothing here dials.

  app.get("/call-settings", async (c) => c.json(await store.engine.callSettings()));

  app.put("/call-settings", async (c) => {
    const body = callSettingsBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    await store.engine.setCallSettings(body.data);
    return c.json(await store.engine.callSettings());
  });

  /**
   * A read and the worker's placements (ADR 0003 4.4): the completed-placement marker, stored in the
   * transaction that stores the placements, says what the call list covers. A read at the instant the
   * server advertised (`expected`) waits, at most READ_WAIT_MS (3 seconds), for the marker to reach it.
   * A read whose list is behind (a call wake after the marker and at or before now) is marked `behind`
   * and advertises no later than the worker's next tick, so due work is never announced as far off.
   */
  const readWake = async (expected: string | undefined): Promise<{ wake: number | null; behind: boolean }> => {
    const wake = await engine.nextWakeAt();
    const at = expected ? Date.parse(expected) : Number.NaN;
    // The stored marker, written with the placements it vouches for, is the only progress a read trusts.
    if (worker && !Number.isNaN(at) && at <= Date.parse(now())) {
      const until = Date.parse(now()) + READ_WAIT_MS;
      while (((await engine.callsPlacedThrough()) ?? Number.NEGATIVE_INFINITY) < at && Date.parse(now()) < until) await worker.tickEnded(until - Date.parse(now()));
    }
    const t = Date.parse(now());
    const through = await engine.callsPlacedThrough();
    const due = through === null ? t : await engine.nextCallWakeAt(through);
    if (due === null || due > t) return { wake, behind: false };
    const next = worker?.nextTickAt() ?? null;
    const soon = next !== null && next > t ? next : t + TICK_MS;
    return { wake: wake === null ? soon : Math.min(wake, soon), behind: true };
  };

  // `nextChangeAt` includes the engine's next wake: a call can be placed or a track start then (ADR 0003 4.4.1).
  app.get("/today", async (c) => {
    const { wake, behind } = await readWake(c.req.query("expected"));
    return c.json(await todayView(store, Date.parse(now()), rules, wake, behind));
  });

  // `focus`: the call the user's screen is on. It stays the focus while it is listed.
  app.get("/calls", async (c) => {
    const { wake, behind } = await readWake(c.req.query("expected"));
    return c.json(await callsView(store, Date.parse(now()), { focus: c.req.query("focus") || null, rules, nextWake: wake, behind }));
  });

  app.get("/call-tasks/:id", async (c) => {
    const view = await callTaskView(store, c.req.param("id"), Date.parse(now()));
    return view ? c.json(view) : notFound(c, "call task");
  });

  app.post("/call-tasks/:id/outcome", async (c) => {
    const body = outcomeBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const id = c.req.param("id");
    if ((await store.engine.callTaskSubject(id)) === null) return notFound(c, "call task");
    const outcome = await engine.logCallOutcome(id, { requestId: body.data.requestId, outcome: body.data.outcome, numberId: body.data.numberId ?? null, note: body.data.note, noteScope: body.data.noteScope });
    if (!outcome.ok) return c.json<ApiError>({ error: { code: "outcome_refused", message: outcome.reason } }, 409);
    // The answer names the next focus: the queue moves on only now that an outcome is logged.
    const at = Date.parse(now());
    const task = await callTaskView(store, id, at);
    if (!task) return notFound(c, "call task");
    return c.json<CallOutcomeAnswer>({ task, nextFocusTaskId: (await callsView(store, at, { rules })).focusTaskId });
  });

  app.get("/needs-attention", async (c) => c.json(await needsAttention(store.engine, Date.parse(now()))));

  // No SMS provider is provisioned or chosen (#28): the running app reports none, honestly.
  app.get("/sms-provider", async (c) => {
    if (smsProvider === "none") return c.json<SmsProviderStatus>({ provider: "none", message: "No SMS provider is connected, so SMS tracks cannot launch.", numbers: [] });
    const at = Date.parse(now());
    const labels = await store.engine.accountLabels();
    const numbers = (await store.engine.accounts(at)).filter((a) => a.channel === "sms").map((a) => ({ id: a.id, label: labels[a.id] ?? a.id, healthy: a.healthy, capacity: a.capacity, usedToday: a.used }));
    return c.json<SmsProviderStatus>({ provider: "test-simulator", message: "A test simulator, not an SMS provider: nothing is sent to anyone.", numbers });
  });

  registerEmailProviderRoutes(app, { engine: store.engine, provider: emailProvider ?? null, now: () => Date.parse(now()) });

  app.notFound((c) => notFound(c, "route"));
  app.onError((error, c) => {
    console.error(JSON.stringify({ level: "error", event: "request_failed", path: c.req.path, message: error.message }));
    return c.json<ApiError>({ error: { code: "internal", message: "Something went wrong on the server." } }, 500);
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function invalid(c: Context, error: z.ZodError) {
  return c.json<ApiError>({ error: { code: "invalid_request", message: invalidBodyMessage(error) } }, 400);
}

function notFound(c: Context, what: string) {
  return c.json<ApiError>({ error: { code: "not_found", message: `No such ${what}.` } }, 404);
}

function tooLarge(c: Context) {
  return c.json<ApiError>({ error: { code: "too_large", message: "The export is larger than 50 MB." } }, 413);
}
