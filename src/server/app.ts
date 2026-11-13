import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { planImport } from "../domain/import-plan.ts";
import { isOutreachStatus } from "../domain/outreach-status.ts";
import { checkScraperFile, parseScraperExport } from "../domain/scraper-export.ts";
import type { ApiError, Campaign, FileCheckResult } from "../shared/api.ts";
import { CAMPAIGN_NAME_MAX } from "../shared/limits.ts";
import { checkApiRequest } from "./guard.ts";
import type { OutreachStore } from "./persistence/store.ts";

export interface AppDependencies {
  readonly store: OutreachStore;
  /** Current time as an ISO-8601 string. */
  readonly now: () => string;
  readonly newId: () => string;
}

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

const fileNames = z
  .object({ people: z.string().max(300).nullish(), businesses: z.string().max(300).nullish() })
  .nullish();

/** Both files or neither: a campaign can be created before its first import. */
const scraperFiles = {
  businessesCsv: z.string().min(1, "Add the Businesses file.").optional(),
  peopleCsv: z.string().min(1, "Add the People file.").optional(),
  fileNames,
};

const newCampaignBody = z
  .object({
    name: z.string().trim().min(1, "Give the campaign a name.").max(CAMPAIGN_NAME_MAX, `Keep the campaign name to ${CAMPAIGN_NAME_MAX} characters or fewer.`),
    defaultTimezone: z
      .string()
      .trim()
      .refine(isTimeZone, "Use an IANA time zone such as Europe/London.")
      .nullish(),
    ...scraperFiles,
  })
  .refine((b) => (b.businessesCsv === undefined) === (b.peopleCsv === undefined), "Add both the People and Businesses files.");

const importBody = z.object({
  businessesCsv: z.string().min(1, "Add the Businesses file."),
  peopleCsv: z.string().min(1, "Add the People file."),
  fileNames,
});

const checkBody = z.object({ businessesCsv: z.string().optional(), peopleCsv: z.string().optional() });

/** The HTTP interface. Every route is under /api; the web client is served separately. */
export function createApp({ store, now, newId }: AppDependencies): Hono {
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

  app.get("/campaigns", async (c) => c.json({ campaigns: await store.listCampaigns() }));

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
    return c.json({ campaign, imports: await store.listImports(campaign.id) });
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
  const message = error.issues.map((issue) => issue.message).join(" ") || "The request body is not valid.";
  return c.json<ApiError>({ error: { code: "invalid_request", message } }, 400);
}

function notFound(c: Context, what: string) {
  return c.json<ApiError>({ error: { code: "not_found", message: `No such ${what}.` } }, 404);
}

function tooLarge(c: Context) {
  return c.json<ApiError>({ error: { code: "too_large", message: "The export is larger than 50 MB." } }, 413);
}
