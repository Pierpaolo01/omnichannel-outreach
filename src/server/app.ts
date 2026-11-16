import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { planImport } from "../domain/import-plan.ts";
import { isOutreachStatus, OUTREACH_STATUSES, type OutreachStatus } from "../domain/outreach-status.ts";
import { LEAD_CONTROLS } from "../domain/sequence/controls.ts";
import { maySend } from "../domain/sequence/attempt.ts";
import { campaignControls, controlsView } from "./engine/controls-view.ts";
import { checkScraperFile, parseScraperExport } from "../domain/scraper-export.ts";
import type { ActivityView, ApiError, CallOutcomeAnswer, CallOutcomeRefusal, Campaign, CompanyRecord, FileCheckResult, PersonRecord, RecordCalls, SmsProviderStatus, TestContactsRefusal, TestRunTab } from "../shared/api.ts";
import { CAMPAIGN_NAME_MAX, DEFINITION_MAX_BYTES, STEP_BODY_MAX, STEP_SUBJECT_MAX } from "../shared/limits.ts";
import { checkApiRequest } from "./guard.ts";
import { invalidBodyMessage, requestObject } from "./request-body.ts";
import { bulkRoutes, type BulkRules } from "./bulk.ts";
import type { OutreachStore } from "./persistence/store.ts";
import { launchCheck } from "../domain/sequence/blockers.ts";
import { definitionProblems, emptyDefinition, liveTracks, type CampaignDefinition } from "../domain/sequence/definition.ts";
import { Engine } from "./engine/engine.ts";
import type { StoredDefinition, StoredNote } from "./engine/engine-store.ts";
import { UnconnectedEmailPort, UnprovisionedSmsPort } from "./engine/ports.ts";
import { accountView, progressView, stepEnvOf } from "./engine/views.ts";
import type { StepEnv } from "../domain/sequence/dispatch.ts";
import { callsView, callTaskView, needsAttentionView, recordCalls, todayView } from "./engine/call-views.ts";
import { DEFAULT_RULES, type Rules } from "./engine/rules.ts";
import { sealReckoning } from "../domain/sequence/progress.ts";
import { editImpactView } from "./engine/edit-impact.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import type { ControlRefusal, EnrollmentRead, CampaignDetail, CampaignMeasures, CampaignListItem, CampaignPauseRead, CampaignSequenceSummary, EditImpactView, RecordControls, RecordLead, SequenceView, ActivityNote, CallOutcomeApi, ColleagueView, NoteAnswer, RecordColleagues } from "../shared/api.ts";
import { beforeLaunchView, copyPreview } from "./before-launch.ts";
import { testRunTab } from "./test-runs.ts";
import { parseTestContacts } from "../domain/test-contacts.ts";
import { activityOf } from "./activity.ts";
import { campaignMeasures, MEASURE_RULES, measuresOf, type MeasureRules } from "./measures.ts";
import { registerEmailProviderRoutes, type EmailProviderSource } from "./instantly/routes.ts";

export interface AppDependencies {
  readonly store: OutreachStore;
  /** Current time as an ISO-8601 string. */
  readonly now: () => string;
  readonly newId: () => string;
  /** The sequence engine. Without one, the app runs an engine with no connected email provider. */
  readonly engine?: Pick<Engine, "launch" | "logCallOutcome" | "controlLead" | "setCampaignPause" | "saveDefinition" | "runTest"> & Partial<Pick<Engine, "transportAvailable">>;
  /** The email provider's own description, for GET /api/email-provider; absent when none is connected. */
  readonly emailProvider?: EmailProviderSource | null;
  /**
   * The SMS provider behind the engine, for GET /api/sms-provider: `none` in the running app, since
   * no SMS provider is provisioned (#28); `test-simulator` only in the test harness's fake.
   */
  readonly smsProvider?: "none" | "test-simulator";
  /** The engine's rules, as the read models use them; the tests' broken engines replace entries (ADR 0003 9.2). */
  readonly rules?: Partial<Rules>;
  /** The bulk rule's parts; the generated bulk runs' broken apps replace one (ADR 0003 "Ticket 18"). */
  readonly bulkRules?: Partial<BulkRules>;
  /** The campaign measures' parts (ticket 22): the generated measure runs' mutations replace one. */
  readonly measureRules?: Partial<MeasureRules>;
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
  /** A phone track's own call skip limit in days (ADR 0003, ticket 14c); the validator checks it. */
  callSkipLimitDays: z.number().optional(),
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
  /** On a running campaign, the digest of the read the user applied from (ticket 19; review bot on 7afa03d). */
  impact: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const impactBody = requestObject({ definition: definitionBody.omit({ save: true, impact: true }) });

/** A definition as stored: a declined path only when the canvas set one; the phone track's fields travel in the same save (ADR 0003 1.1.1). */
function definitionFromBody(fields: Omit<z.infer<typeof definitionBody>, "save" | "impact">): CampaignDefinition {
  return { ...fields, tracks: fields.tracks.map(({ declinedPath, callSkipLimitDays, ...t }) => ({ ...t, ...(declinedPath ? { declinedPath } : {}), ...(callSkipLimitDays !== undefined ? { callSkipLimitDays } : {}) })) };
}

/** The user's zone: the machine's, which a campaign's default zone starts from (ADR 0003 1.1). */
const machineZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const callSettingsBody = requestObject({
  dailyCapacity: z.number().int("The daily call capacity is a whole number.").positive("The daily call capacity is at least 1.").max(1_000),
  userZone: z.string().trim().refine((z) => isTimeZone(z), "Use an IANA time zone such as Europe/London."),
});
// Ticket 17a. Each control carries the client's key for that one action: the same key answers with the first
// answer and applies nothing again, so a retry after a lost answer cannot skip a second step or pause again.
const controlRequestId = z.string().trim().min(1, "Send a request id with each action.").max(200);
// Ticket 17b: what the confirmation was shown on, so a control applies only on it (coordinator's ruling on the verifier's
// B1 at 8a1732a). Optional at this boundary; the screens always send it.
const campaignControlBody = requestObject({
  requestId: controlRequestId,
  expect: z.strictObject({ pausedSince: z.iso.datetime({ offset: true }).nullable() }, { message: "Send the campaign's pause as the confirmation read it." }).optional(),
});
// Ticket 18: a note typed on a record. Its request id names it, so a retry stores it once.
const noteText = z.string().trim().min(1, "Type a note first.").max(10_000, "A note can be at most 10,000 characters.");
const personNoteBody = requestObject({ requestId: z.string().trim().min(1, "Send a request id with each note.").max(200), body: noteText, scope: z.enum(["person", "company"], { message: "Choose who the note is for: person or company." }) });
const companyNoteBody = requestObject({ requestId: z.string().trim().min(1, "Send a request id with each note.").max(200), body: noteText });
const leadControlBody = requestObject({
  requestId: controlRequestId,
  action: z.enum(LEAD_CONTROLS, { message: "Choose one of: pause, resume, skip, stop, resume_from_next_step, move_to_win_back." }),
  expect: z
    .strictObject({ status: z.enum(OUTREACH_STATUSES), preview: z.string().max(500) }, { message: "Send the lead's status and the preview the confirmation showed." })
    .optional(),
});
// Ticket 21: the user's own test contacts, Run test and Stop test (ADR 0003 "Ticket 21").
const testContactsBody = requestObject({ email: z.string().max(320), mobile: z.string().max(40) });
const runTestBody = requestObject({
  requestId: controlRequestId,
  renderAs: z.string().trim().min(1, "Choose the lead the test's copy is written for.").max(200),
  expect: z.strictObject({ definitionVersion: z.number().int().nonnegative() }, { message: "Send the version of the sequence you are looking at." }),
});
const stopTestBody = requestObject({ requestId: controlRequestId });
// Redial and callback are ticket 15's, not interested and its declined path ticket 16's; which outcome each
// goes with is the domain's rule (`logCallOutcome`), refused there with a plain reason.
const outcomeBody = requestObject({
  /**
   * The client's key for this one action: the same key answers with the first result and stores
   * nothing again, so a retry or a double click never logs an outcome or a note twice (verifier B3).
   */
  requestId: z.string().trim().min(1, "Send a request id with each outcome.").max(200),
  outcome: z.enum(["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "not_interested", "callback_requested", "skip_for_now"], {
    message: "Choose one of the outcomes this release offers: no answer, voicemail left, gatekeeper or not reached, wrong or dead number, interested, not interested, callback requested, or skip for now.",
  }),
  /** With not interested: the declined path for this lead, overriding the phone track's (stop, continue or win back). */
  declinedPath: z.enum(["stop", "continue", "win_back"], { message: "A declined path is stop, continue or win_back." }).optional(),
  /** With no answer, voicemail or gatekeeper: move the call onto the user's next day. */
  redial: z.boolean().optional(),
  /** With a callback requested: the date and time the prospect asked for, with its offset (ISO 8601). */
  callbackAt: z.iso.datetime({ offset: true, message: "Give the callback's date and time as an ISO 8601 instant with its offset, such as 2026-11-03T15:00:00+00:00." }).optional(),
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
export function createApp({ store, now, newId, engine: givenEngine, emailProvider, smsProvider = "none", rules: givenRules, bulkRules, measureRules }: AppDependencies): Hono {
  const rules: Rules = { ...DEFAULT_RULES, ...givenRules };
  const engine = givenEngine ?? new Engine({ store: store.engine, port: new UnconnectedEmailPort(), smsPort: new UnprovisionedSmsPort(), now: () => Date.parse(now()), newId });
  const app = new Hono().basePath("/api");
  /**
   * For a route that changes an input the engine's timing reads (an import that may move a lead's or a
   * company's zone, the call settings): every lead with an open call task is first brought up to `at` under
   * the old inputs, in the route's own transaction, and its skip limit sealed there (ADR 0003 2.4, council on
   * 228cd3b). The routes are listed in ADR 0003 and walked by `as-of-the-instant.test.ts`.
   */
  const catchUpAt = (at: number) => ({ now: at, asOf: (s: SubjectState) => sealReckoning(rules.asOfAction(s, at, rules.evaluate), at) });
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
      catchUp: catchUpAt(Date.parse(importedAt)),
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
    // Each row carries the campaign's pause as its own read does (ticket 17b): the list shows the Paused banner too.
    for (const item of await store.listCampaigns()) campaigns.push({ ...item, sequence: await sequenceSummary(item.id), ...(await pauseRead(item.id)) });
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
    const leadCount = await store.leadCount(campaign.id);
    const asOf = now();
    const snapshot = await campaignSnapshot(campaign.id);
    if (!snapshot) return notFound(c, "campaign");
    return c.json<CampaignDetail>({ campaign, imports: await store.listImports(campaign.id), leadCount, sequence: await sequenceSummary(campaign.id), ...snapshot, asOf });
  });

  // Ticket 22: the campaign's outcome measures, every figure a tally of its stored activity, read in one snapshot.
  app.get("/campaigns/:id/measures", async (c) => {
    const measures = await campaignMeasures(store.engine, c.req.param("id"), measureRules);
    if (!measures) return notFound(c, "campaign");
    return c.json<CampaignMeasures>(measures);
  });

  // Ticket 17a: the campaign pause, its date, the count of leads in each status, and the controls allowed now. Ticket 22: all
  // of it, and the campaign's measures, from the store's one snapshot (`measureFacts`), so a screen showing the Paused
  // banner's counts beside the measures shows one instant (verifier B1 on 41028f2).
  const campaignSnapshot = async (campaignId: string): Promise<(CampaignPauseRead & { readonly measures: CampaignMeasures }) | null> => {
    const facts = await (measureRules?.facts ?? MEASURE_RULES.facts)(store.engine, campaignId);
    if (!facts) return null;
    const statusCounts = Object.fromEntries(OUTREACH_STATUSES.map((status) => [status, facts.enrollments.filter((e) => e.status === status).length])) as Record<OutreachStatus, number>;
    return {
      pause: { paused: facts.pausedSince !== null, pausedSince: facts.pausedSince !== null ? new Date(facts.pausedSince).toISOString() : null },
      statusCounts,
      controls: campaignControls({ launchedAt: facts.launchedAt, pausedSince: facts.pausedSince }),
      mayStillSend: facts.mayStillSend,
      userZone: (await store.engine.callSettings()).userZone,
      measures: measuresOf(facts, measureRules),
    };
  };
  const pauseRead = async (campaignId: string): Promise<CampaignPauseRead> => {
    const snapshot = await campaignSnapshot(campaignId);
    if (!snapshot) throw new Error(`no campaign ${campaignId}`);
    return { pause: snapshot.pause, statusCounts: snapshot.statusCounts, controls: snapshot.controls, mayStillSend: snapshot.mayStillSend, userZone: snapshot.userZone };
  };
  const controlRefused = (c: Context, message: string) => c.json<ControlRefusal>({ error: { code: "control_refused", message } }, 409);

  for (const pause of [true, false]) {
    app.post(`/campaigns/:id/${pause ? "pause" : "resume"}`, async (c) => {
      const body = campaignControlBody.safeParse(await readJson(c));
      if (!body.success) return invalid(c, body.error);
      const id = c.req.param("id");
      if (!(await store.campaign(id))) return notFound(c, "campaign");
      const expectation = body.data.expect === undefined ? null : { pausedSince: body.data.expect.pausedSince === null ? null : Date.parse(body.data.expect.pausedSince) };
      const answer = await engine.setCampaignPause(id, pause, body.data.requestId, expectation);
      if (!answer.ok) return controlRefused(c, answer.reason);
      return c.json({ ...(await pauseRead(id)), replayed: answer.replayed });
    });
  }

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
    // Each enrollment's open calls, as of now, by the engine's rules (ticket 15b).
    if (!person) return notFound(c, "person");
    return c.json<PersonRecord & RecordCalls & RecordControls & RecordColleagues>({ ...person, ...(await recordReads(person.enrollments.map((e) => e.id))), colleagueNotes: await colleagueNotes(person.colleagues) });
  });

  app.get("/companies/:id", async (c) => {
    const company = await store.company(c.req.param("id"));
    if (!company) return notFound(c, "company");
    return c.json<CompanyRecord & RecordCalls & RecordControls & RecordColleagues>({ ...company, ...(await recordReads(company.enrollments.map((e) => e.id))), colleagueNotes: await colleagueNotes(company.people) });
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
    const { save, impact, ...fields } = body.data;
    const definition = definitionFromBody(fields);
    const row = await store.engine.campaign(campaign.id);
    const problems = definitionProblems(definition, row?.definition ?? null, { launched: row?.launchedAt != null });
    if (problems.length > 0) return c.json<ApiError>({ error: { code: "invalid_sequence", message: problems.join(" ") } }, 400);
    // Through the engine (ticket 19): a launched campaign's save reconciles its leads in the save's transaction.
    const result = await engine.saveDefinition(campaign.id, definition, now(), save ?? null, impact !== undefined ? { impact } : {});
    const saved = result.outcome;
    if (saved === "missing") return notFound(c, "campaign");
    if (saved === "impact_changed") {
      // One reason whatever changed (council on 93bed86, item 14); `elsewhere` when the stored sequence itself changed.
      const message = result.elsewhere
        ? "This campaign's sequence was changed elsewhere since what this change does was shown, so nothing was applied. Load the saved version, or discard your changes, to carry on."
        : "What this change does changed since it was shown, so nothing was applied. Check what it does now, then apply again.";
      return c.json<ApiError>({ error: { code: "impact_changed", message, elsewhere: result.elsewhere } }, 409);
    }
    if (saved === "invalid") return c.json<ApiError>({ error: { code: "invalid_sequence", message: result.problems.join(" ") } }, 400);
    if (saved === "blocked") {
      return c.json<ApiError>({ error: { code: "blocked", message: `This change was not applied: ${result.check.blockers.map((b) => b.message).join(" ")}` } }, 409);
    }
    if (saved === "superseded") {
      return c.json<ApiError>({ error: { code: "superseded", message: "A later change from this page was already saved." } }, 409);
    }
    if (saved === "replaced") {
      return c.json<ApiError>({ error: { code: "replaced", message: "This page’s change was saved, then the sequence was changed on another page." } }, 409);
    }
    if (saved === "conflict") {
      return c.json<ApiError>({ error: { code: "edit_conflict", message: "This campaign’s sequence was changed elsewhere since this page loaded it, so this change was not saved." } }, 409);
    }
    if (saved === "launched") {
      return c.json<ApiError>({ error: { code: "launched", message: "This campaign is running. Editing a running campaign arrives with a later release." } }, 409);
    }
    return c.json(await sequenceView(campaign.id, campaign.defaultTimezone, result.stored));
  });

  // Ticket 19: what applying a draft would do to a running campaign's leads, read through the engine's own functions.
  app.post("/campaigns/:id/sequence/impact", withinDefinitionLimit, async (c) => {
    const campaign = await store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    const body = impactBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const view = await editImpactView(store.engine, rules, campaign.id, definitionFromBody(body.data.definition), Date.parse(now()));
    return view ? c.json<EditImpactView>(view) : notFound(c, "campaign");
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
    if (!person) return notFound(c, "person");
    return c.json<ActivityView>({
      entries: await activityOf(store, person.enrollments, Date.parse(now()), "person", rules),
      notes: await notesOnRecord({ person: person.id, company: person.company.id }, person.enrollments.map((e) => e.id)),
      userZone: (await store.engine.callSettings()).userZone,
    });
  });

  app.get("/companies/:id/activity", async (c) => {
    const company = await store.company(c.req.param("id"));
    if (!company) return notFound(c, "company");
    return c.json<ActivityView>({
      entries: await activityOf(store, company.enrollments, Date.parse(now()), "company", rules),
      notes: await notesOnRecord({ person: null, company: company.id }, company.enrollments.map((e) => e.id)),
      userZone: (await store.engine.callSettings()).userZone,
    });
  });

  // Ticket 18: notes on a record. The person's own notes and their company's, which show for everyone at the company; a
  // note written with a call outcome shows on that call's entry on its own lead's record, so it is left out there only.
  const notesOnRecord = async (owner: { person: string | null; company: string }, ownCalls: readonly string[]): Promise<ActivityNote[]> => {
    const own = owner.person === null ? [] : await store.engine.notesOf("person", owner.person);
    const shared = await store.engine.notesOf("company", owner.company);
    const onOwnCall = (n: StoredNote) => n.callAttemptId !== null && n.subjectId !== null && ownCalls.includes(n.subjectId);
    return [...own.filter((n) => n.callAttemptId === null), ...shared.filter((n) => !onOwnCall(n))]
      .sort((a, b) => b.atWall - a.atWall)
      .map((n) => ({ id: n.id, scope: n.owner, body: n.body, at: new Date(n.atWall).toISOString() }));
  };

  // Each colleague's last call note, as the call desk's colleagues read it (ticket 18).
  const colleagueNotes = async (people: readonly ColleagueView[]): Promise<RecordColleagues["colleagueNotes"]> => {
    const notes = await store.engine.lastCallNotes(people.flatMap((p) => p.enrollments.map((e) => e.id)));
    return people.map((p) => {
      const last = notes.filter((n) => p.enrollments.some((e) => e.id === n.subjectId)).sort((a, b) => b.atWall - a.atWall)[0];
      return { personId: p.id, lastCallNote: last ? { note: last.note, outcome: last.outcome as CallOutcomeApi, at: new Date(last.atWall).toISOString() } : null };
    });
  };

  const noteAnswer = async (c: Context, owner: { kind: "person" | "company"; id: string }, requestId: string, text: string) => {
    const at = Date.parse(now());
    const id = `record-note:${requestId}`;
    const stored = await store.engine.addNote({ id, owner: owner.kind, ownerId: owner.id, body: text, atWall: at });
    if (stored === "different") return c.json<ApiError>({ error: { code: "note_refused", message: "This request id was already used for another note: send a new one." } }, 409);
    const note = (await store.engine.notesOf(owner.kind, owner.id)).find((n) => n.id === id);
    if (!note) throw new Error(`note ${id} was not stored`);
    return c.json<NoteAnswer>({ note: { id, scope: note.owner, body: note.body, at: new Date(note.atWall).toISOString() }, replayed: stored === "same" }, stored === "added" ? 201 : 200);
  };

  app.post("/people/:id/notes", async (c) => {
    const body = personNoteBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const person = await store.person(c.req.param("id"));
    if (!person) return notFound(c, "person");
    return noteAnswer(c, body.data.scope === "person" ? { kind: "person", id: person.id } : { kind: "company", id: person.company.id }, body.data.requestId, body.data.body);
  });

  app.post("/companies/:id/notes", async (c) => {
    const body = companyNoteBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const company = await store.company(c.req.param("id"));
    if (!company) return notFound(c, "company");
    return noteAnswer(c, { kind: "company", id: company.id }, body.data.requestId, body.data.body);
  });

  // Work handed over and not settled may still be sent (ticket 17a's provider limitation): the screens say so.
  // When each step goes is read with what dispatch knows beyond the lead (ADR 0003 "Reads that say when"): the port's
  // transport, and the dispatch gate while sending is interrupted.
  const transport = (channel: "email" | "sms" | "linkedin", threading: "new_subject" | "continue_thread") => engine.transportAvailable?.(channel, threading) ?? true;
  /**
   * A read with what dispatch knows, computed once with a probe in place of the later days' call room, and again with the
   * room only when some step asked for it (council and verifier on cc9bf55, items 6 and 12): the other leads' open calls are
   * loaded only when a call not yet on the list would go on it on a later day.
   */
  const withEnv = async <T>(at: number, reading: readonly SubjectState[], known: ReadonlyMap<string, SubjectState | null> | undefined, compute: (env: StepEnv) => T | Promise<T>): Promise<T> => {
    const light = await stepEnvOf(store.engine, at, reading, transport, known, false);
    const probe = { asked: false };
    const first = await compute({ ...light, callRoomOn: () => ((probe.asked = true), true) });
    return probe.asked ? compute(await stepEnvOf(store.engine, at, reading, transport, known)) : first;
  };
  // The read is this subject as the engine evaluates it at the read's instant (`previewAsOf`, the rule the controls' preview
  // already reads through: the engine's own `asOfAction`): a track
  // whose start or a step whose due falls between two rounds is read as started or due, never as having no pending step
  // (the P2 seeds of the search on ab6fe8e). Pure: nothing is written; the next round evaluates the same.
  const readOf = (stored: SubjectState, at: number, env: StepEnv): EnrollmentRead => {
    const state = rules.previewAsOf(stored, at, rules.evaluate);
    return { ...progressView(state, at, env, rules.stepWhen), controls: controlsView(state, at, rules, env), mayStillSend: state.work.filter(maySend).length };
  };
  const enrollmentRead = async (id: string): Promise<EnrollmentRead | null> => {
    const at = Date.parse(now());
    const state = await store.engine.subject(id, at);
    return state ? withEnv(at, [state], new Map([[id, state]]), (env) => readOf(state, at, env)) : null;
  };

  // Ticket 17b: each enrollment's read on the record, with its campaign's launch and pause, so each campaign row shows
  // the controls allowed in its status, what each will do, and its sentence. The same read as GET /api/enrollments/:id.
  // Each enrollment is loaded once for the whole record read, at one instant (council on 4fd9ca4, item 6).
  const recordReads = async (enrollmentIds: readonly string[]): Promise<RecordCalls & RecordControls> => {
    const at = Date.parse(now());
    const loaded = new Map<string, SubjectState | null>();
    for (const id of enrollmentIds) loaded.set(id, await store.engine.subject(id, at));
    return { ...(await recordCalls(store, enrollmentIds, at, rules, loaded)), ...(await recordControls(enrollmentIds, loaded, at)) };
  };
  const recordControls = async (enrollmentIds: readonly string[], loaded: ReadonlyMap<string, SubjectState | null>, at: number): Promise<RecordControls> => {
    const states = [...loaded.values()].filter((x): x is SubjectState => x !== null);
    const leads = await withEnv(at, states, loaded, (env) => {
      const out: RecordLead[] = [];
      for (const id of enrollmentIds) {
        const state = loaded.get(id) ?? null;
        if (!state) continue;
        // The campaign's launch and pause as the loaded lead holds them: the same snapshot as its calls and controls, so a
        // pause landing during this read never makes one row both on hold and on today's list (council on 57d874f, item 6).
        const { launchedAt, pausedSince } = state.campaign;
        out.push({ ...readOf(state, at, env), campaignState: { launched: launchedAt !== null, paused: pausedSince !== null, pausedSince: pausedSince === null ? null : new Date(pausedSince).toISOString() } });
      }
      return out;
    });
    return { leads, userZone: (await store.engine.callSettings()).userZone };
  };

  // A test run is a subject but never a lead (ADR 0003 "Ticket 21"): the lead routes do not know it.
  const isTestRun = async (id: string) => (await store.engine.testRun(id)) !== null;

  // Ticket 18: bulk add, pause, resume and stop on Leads, each per-lead effect through the engine's own control.
  // Bulk previews are per-lead previews (council on cc9bf55, item 8): the same read, with what dispatch knows. A request's
  // rows share one environment, since the call room takes each row's own state (`callRoomOn(day, self)`).
  const readAll = async (states: readonly SubjectState[], at: number): Promise<EnrollmentRead[]> => {
    return withEnv(at, states, new Map(states.map((s) => [s.subject.id, s])), (env) => states.map((s) => readOf(s, at, env)));
  };
  bulkRoutes(app, { store, engine, now, newId, readOf: (state, at) => withEnv(at, [state], new Map([[state.subject.id, state]]), (env) => readOf(state, at, env)), readAll, ...(bulkRules ? { rules: bulkRules } : {}) });

  app.get("/enrollments/:id", async (c) => {
    if (await isTestRun(c.req.param("id"))) return notFound(c, "enrollment");
    const read = await enrollmentRead(c.req.param("id"));
    return read ? c.json(read) : notFound(c, "enrollment");
  });

  // Ticket 17a: pause, resume, skip, stop and the two restarts of one lead, judged as of the request's instant.
  app.post("/enrollments/:id/controls", async (c) => {
    const body = leadControlBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const id = c.req.param("id");
    if (!(await store.engine.subject(id, Date.parse(now()))) || (await isTestRun(id))) return notFound(c, "enrollment");
    const answer = await engine.controlLead(id, body.data.action, body.data.requestId, body.data.expect ?? null);
    if (!answer.ok) return controlRefused(c, answer.reason);
    // `effect` is the control's own effect, the read's preview at that instant; `enrollment` is the read after the worker ran (verifier B4).
    return c.json({ effect: answer.effect, enrollment: await enrollmentRead(id), replayed: answer.replayed });
  });

  // -------------------------------------------------------------------------------------------
  // Calls (ticket 14). The user dials on their own phone; nothing here dials.

  app.get("/call-settings", async (c) => c.json(await store.engine.callSettings()));

  app.put("/call-settings", async (c) => {
    const body = callSettingsBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    await store.engine.setCallSettings(body.data, catchUpAt(Date.parse(now())));
    return c.json(await store.engine.callSettings());
  });

  app.get("/today", async (c) => c.json(await todayView(store, Date.parse(now()), rules)));

  // `focus`: the call the user's screen is on. It stays the focus while it is listed.
  app.get("/calls", async (c) => c.json(await callsView(store, Date.parse(now()), { focus: c.req.query("focus") || null, rules })));

  app.get("/call-tasks/:id", async (c) => {
    const view = await callTaskView(store, c.req.param("id"), Date.parse(now()), rules);
    return view ? c.json(view) : notFound(c, "call task");
  });

  app.post("/call-tasks/:id/outcome", async (c) => {
    const body = outcomeBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const id = c.req.param("id");
    const subjectId = await store.engine.callTaskSubject(id);
    if (subjectId === null) return notFound(c, "call task");
    // A test call keeps no note (question Q30): there is no person or company to keep it on.
    if (body.data.note.trim() !== "" && (await isTestRun(subjectId))) return c.json<ApiError>({ error: { code: "invalid_request", message: "A test call keeps no note. Nothing was logged." } }, 400);
    const outcome = await engine.logCallOutcome(id, {
      requestId: body.data.requestId,
      outcome: body.data.outcome,
      redial: body.data.redial ?? false,
      callbackAt: body.data.callbackAt === undefined ? null : Date.parse(body.data.callbackAt),
      declinedPath: body.data.declinedPath ?? null,
      numberId: body.data.numberId ?? null,
      note: body.data.note,
      noteScope: body.data.noteScope,
    });
    if (!outcome.ok) {
      // The refusal carries why the call is off the list, as read now, so the page records it without another read.
      const offList = (await callTaskView(store, id, Date.parse(now()), rules))?.offList ?? null;
      return c.json<CallOutcomeRefusal>({ error: { code: "outcome_refused", message: outcome.reason }, offList }, 409);
    }
    // The answer names the next focus: the queue moves on only now that an outcome is logged.
    const at = Date.parse(now());
    const task = await callTaskView(store, id, at, rules);
    if (!task) return notFound(c, "call task");
    return c.json<CallOutcomeAnswer>({ task, nextFocusTaskId: (await callsView(store, at, { rules })).focusTaskId });
  });

  // -------------------------------------------------------------------------------------------
  // Test runs (ticket 21; ADR 0003 "Ticket 21").

  const testTab = async (id: string) => {
    const at = Date.parse(now());
    const latest = (await store.engine.testRunsOf(id))[0] ?? null;
    const run = latest ? await store.engine.subject(latest.id, at) : null;
    return withEnv(at, run ? [run] : [], run && latest ? new Map([[latest.id, run]]) : undefined, (env) => testRunTab(store, id, at, rules, env));
  };

  app.get("/campaigns/:id/test-runs", async (c) => {
    const tab = await testTab(c.req.param("id"));
    return tab ? c.json<TestRunTab>(tab) : notFound(c, "campaign");
  });

  app.put("/campaigns/:id/test-contacts", async (c) => {
    const body = testContactsBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const parsed = parseTestContacts(body.data);
    if (!parsed.ok) return c.json<TestContactsRefusal>({ error: { code: "invalid_test_contact", message: parsed.message, field: parsed.field } }, 400);
    const saved = await store.engine.saveTestContacts(c.req.param("id"), parsed.contacts);
    if (!saved.ok) return "missing" in saved ? notFound(c, "campaign") : c.json<TestContactsRefusal>({ error: { code: "test_contact_is_a_lead", message: saved.message, field: saved.field } }, 409);
    const tab = await testTab(c.req.param("id"));
    return tab ? c.json<TestRunTab>(tab) : notFound(c, "campaign");
  });

  app.post("/campaigns/:id/test-runs", async (c) => {
    const body = runTestBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const id = c.req.param("id");
    if (!(await store.campaign(id))) return notFound(c, "campaign");
    const answer = await engine.runTest(id, body.data.requestId, body.data.renderAs, body.data.expect.definitionVersion);
    if (!answer.ok) return controlRefused(c, answer.reason);
    const tab = await testTab(id);
    return tab ? c.json<TestRunTab & { readonly replayed: boolean }>({ ...tab, replayed: answer.replayed }) : notFound(c, "campaign");
  });

  app.post("/test-runs/:id/stop", async (c) => {
    const body = stopTestBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);
    const run = await store.engine.testRun(c.req.param("id"));
    if (!run) return notFound(c, "test run");
    const answer = await engine.controlLead(run.id, "stop", body.data.requestId, null);
    if (!answer.ok) return controlRefused(c, answer.reason);
    const tab = await testTab(run.campaignId);
    return tab ? c.json<TestRunTab & { readonly replayed: boolean }>({ ...tab, replayed: answer.replayed }) : notFound(c, "campaign");
  });

  app.get("/needs-attention", async (c) => c.json(await needsAttentionView(store, Date.parse(now()), rules, (channel, threading) => engine.transportAvailable?.(channel, threading) ?? true)));

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
