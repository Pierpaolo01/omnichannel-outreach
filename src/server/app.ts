import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { planImport } from "../domain/import-plan.ts";
import { isOutreachStatus } from "../domain/outreach-status.ts";
import { parseScraperExport } from "../domain/scraper-export.ts";
import type { ApiError } from "../shared/api.ts";
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

const newCampaignBody = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(200),
  defaultTimezone: z
    .string()
    .trim()
    .refine(isTimeZone, "Use an IANA time zone such as Europe/London.")
    .nullish(),
});

const importBody = z.object({
  businessesCsv: z.string().min(1, "Add the businesses file."),
  peopleCsv: z.string().min(1, "Add the people file."),
});

/** The HTTP interface. Every route is under /api; the web client is served separately. */
export function createApp({ store, now, newId }: AppDependencies): Hono {
  const app = new Hono().basePath("/api");

  app.get("/campaigns", (c) => c.json({ campaigns: store.listCampaigns() }));

  app.post("/campaigns", async (c) => {
    const parsed = newCampaignBody.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const campaign = {
      id: newId(),
      name: parsed.data.name,
      defaultTimezone: parsed.data.defaultTimezone || null,
      createdAt: now(),
    };
    store.createCampaign(campaign);
    return c.json({ campaign }, 201);
  });

  app.get("/campaigns/:id", (c) => {
    const campaign = store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    return c.json({ campaign, imports: store.listImports(campaign.id) });
  });

  app.get("/campaigns/:id/imports", (c) => {
    const campaign = store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    return c.json({ imports: store.listImports(campaign.id) });
  });

  app.post("/campaigns/:id/imports", bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: (c) => tooLarge(c) }), async (c) => {
    const campaign = store.campaign(c.req.param("id"));
    if (!campaign) return notFound(c, "campaign");
    const body = importBody.safeParse(await readJson(c));
    if (!body.success) return invalid(c, body.error);

    const parsed = parseScraperExport(body.data);
    if (!parsed.ok) {
      return c.json<ApiError>(
        {
          error: {
            code: "invalid_export",
            message: "The export could not be imported. Nothing was changed.",
            problems: parsed.problems,
          },
        },
        400,
      );
    }

    const importedAt = now();
    const record = store.importIntoCampaign({
      campaignId: campaign.id,
      importId: newId(),
      importedAt,
      plan: (directory) => planImport({ directory, scraped: parsed.value, now: importedAt, newId }),
    });
    return c.json({ import: record }, 201);
  });

  app.get("/leads", (c) => {
    const status = c.req.query("status") || null;
    if (status !== null && !isOutreachStatus(status)) {
      return c.json<ApiError>({ error: { code: "invalid_query", message: `Unknown outreach status: ${status}` } }, 400);
    }
    const requested = Number(c.req.query("limit") ?? SEARCH_LIMIT_DEFAULT);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;
    return c.json(
      store.searchLeads({ text: c.req.query("q") ?? "", campaignId: c.req.query("campaign") || null, status, limit }),
    );
  });

  app.get("/people/:id", (c) => {
    const person = store.person(c.req.param("id"));
    return person ? c.json(person) : notFound(c, "person");
  });

  app.get("/companies/:id", (c) => {
    const company = store.company(c.req.param("id"));
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
