import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CallTaskView, CallsView, EnrollmentRead, LeadSearchResult } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, csvOf, person } from "../test/support/export-builder.ts";

/**
 * Ticket 23: the world the acceptance story runs in. The real HTTP application and its SQLite store, on a database file in
 * a scratch folder made for this run, with the engine over the fake email provider and the fake SMS provider, on a clock
 * the test advances. It serves the built client, as the earlier tickets' browser tests do. Nothing reaches a real provider:
 * the inbox and the numbers are simulated. Every company, person, address and number is fictitious (`.example` domains,
 * Ofcom's drama ranges).
 */

export const INBOX = "alex@northlight-mail.example";
/** Two simulated SMS numbers. The fake labels them "Simulated SMS (not a provider)". */
export const NUMBERS = ["+447700900900", "+447700900901"] as const;
/** The user's own test contacts, fictitious: a reserved example domain and a drama-range mobile. */
export const OWN_EMAIL = "alex.own@personal-mail.example";
export const OWN_MOBILE = "+447700900456";

export const MIN = 60_000;
export const H = 60 * MIN;
export const DAY = 24 * H;
/** Monday 9 November 2026, 09:00 in London (GMT, so the same in UTC). */
export const MONDAY_0900 = Date.parse("2026-11-09T09:00:00Z");

/**
 * The fictitious scraper export. Harbour Lane Physio is listed twice in the Businesses file and Ada Reyes twice in the
 * People file, as a scraper run that found them twice: the import merges each into one record. Juniper Pilates Studio has
 * no named decision maker and no main line: it is a company lead reached by its shared inbox only.
 */
const HARBOUR = business({ business_id: "bz-harbour", place_id: "pl-harbour", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960101", phone_original: "0117 496 0101" });
const KESTREL = business({ business_id: "bz-kestrel", place_id: "pl-kestrel", business_name: "Kestrel Dental", city: "Bristol", phone_e164: "+441174960202", phone_original: "0117 496 0202" });
const JUNIPER = business({ business_id: "bz-juniper", place_id: "pl-juniper", business_name: "Juniper Pilates Studio", city: "Bath", general_emails: "hello@juniperpilates.example" });

const dm = (id: string, company: string, name: string, title: string, local: string, mobile: string) =>
  person({ person_id: id, business_id: company, full_name: name, title, email: `${local}@${company === "bz-harbour" ? "harbourlane" : "kestreldental"}.example`, dial_phone: mobile, dial_phone_type: "mobile" });

export const PEOPLE = {
  ada: dm("pp-ada", "bz-harbour", "Ada Reyes", "Clinic director", "ada", "+447700900301"),
  ben: dm("pp-ben", "bz-harbour", "Ben Ortiz", "Practice manager", "ben", "+447700900302"),
  cara: dm("pp-cara", "bz-harbour", "Cara Lin", "Lead physiotherapist", "cara", "+447700900303"),
  hal: dm("pp-hal", "bz-harbour", "Hal Price", "Owner", "hal", "+447700900304"),
  ivy: dm("pp-ivy", "bz-harbour", "Ivy Cole", "Operations lead", "ivy", "+447700900305"),
  dev: dm("pp-dev", "bz-kestrel", "Dev Shah", "Practice owner", "dev", "+447700900306"),
  eve: dm("pp-eve", "bz-kestrel", "Eve Hart", "Clinical director", "eve", "+447700900307"),
  finn: dm("pp-finn", "bz-kestrel", "Finn Wood", "Practice manager", "finn", "+447700900308"),
  gia: dm("pp-gia", "bz-kestrel", "Gia Moss", "Owner", "gia", "+447700900309"),
  jon: dm("pp-jon", "bz-kestrel", "Jon Lake", "Head of patient care", "jon", "+447700900310"),
  kim: dm("pp-kim", "bz-kestrel", "Kim Rowe", "Associate dentist", "kim", "+447700900311"),
};

/** The two files as the user uploads them, with the duplicate rows. */
export function exportFiles(): { businesses: Buffer; people: Buffer } {
  const people = Object.values(PEOPLE);
  const { businessesCsv, peopleCsv } = csvOf({ businesses: [HARBOUR, KESTREL, HARBOUR, JUNIPER], people: [people[0]!, ...people] });
  return { businesses: Buffer.from(businessesCsv), people: Buffer.from(peopleCsv) };
}

/** What the test expects of the import, written down here from the files above, not read from the application. */
export const EXPECTED_IMPORT = {
  decisionMakers: Object.keys(PEOPLE).length,
  companyLeads: 1,
  peopleRows: Object.keys(PEOPLE).length + 1,
  businessRows: 4,
};

export interface AcceptanceWorld {
  readonly url: string;
  readonly harness: EngineHarness;
  readonly dataDir: string;
  /** Record id of a person or company, by name. */
  readonly record: (name: string) => Promise<string>;
  /** A lead (enrollment) id, by name and campaign. */
  readonly lead: (name: string, campaignId: string) => Promise<string>;
  readonly read: (leadId: string) => Promise<EnrollmentRead>;
  readonly calls: () => Promise<CallsView>;
  readonly callTask: (taskId: string) => Promise<CallTaskView>;
  readonly close: () => Promise<void>;
}

/**
 * Makes the scratch folder itself, checks it exists and is empty, and only then opens the database in it: the data folder
 * never comes from a variable that a failed step could leave unset.
 */
export function scratchFolder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outreach-acceptance-"));
  if (!existsSync(dir) || readdirSync(dir).length !== 0 || !dir.startsWith(os.tmpdir())) throw new Error("the scratch data folder was not made as expected");
  return dir;
}

export interface WorldOptions {
  readonly start?: number;
  readonly smsConnected?: boolean;
  /** The inbox's daily capacity and pacing gap (default 60 a day, one a minute). */
  readonly emailCapacity?: number;
  readonly emailGapMs?: number;
  /** Each SMS number's pacing gap (default one a minute). */
  readonly smsGapMs?: number;
}

export async function acceptanceWorld(options: WorldOptions = {}): Promise<AcceptanceWorld> {
  const dataDir = scratchFolder();
  const harness = new EngineHarness({
    start: options.start ?? MONDAY_0900,
    databasePath: path.join(dataDir, "outreach.sqlite"),
    accounts: [{ id: INBOX, capacity: options.emailCapacity ?? 60, gapMs: options.emailGapMs ?? MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    // The numbers start disconnected at the provider unless asked: Before launch then names the SMS track's missing sender.
    sms: { numbers: NUMBERS.map((id) => ({ id, capacity: 60, gapMs: options.smsGapMs ?? MIN, k: 1, healthy: options.smsConnected ?? false, resetZone: "Europe/London" })) },
  });
  await harness.tick();
  const settings = await harness.request("PUT", "/api/call-settings", { dailyCapacity: 30, userZone: "Europe/London" });
  if (settings.status !== 200) throw new Error(`call settings refused: ${JSON.stringify(settings.body)}`);

  const search = async (q: string) => (await harness.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(q)}&limit=500`)).body.rows;
  const record = async (name: string) => {
    const row = (await search(name)).find((r) => r.name === name);
    if (!row) throw new Error(`no record named ${name}`);
    return row.id;
  };
  const lead = async (name: string, campaignId: string) => {
    const row = (await search(name)).find((r) => r.name === name);
    const id = row?.enrollments.find((e) => e.campaign.id === campaignId)?.id;
    if (!id) throw new Error(`no lead for ${name} in ${campaignId}`);
    return id;
  };
  const read = async (leadId: string) => {
    const res = await harness.request<EnrollmentRead>("GET", `/api/enrollments/${leadId}`);
    if (res.status !== 200) throw new Error(`no enrollment ${leadId}`);
    return res.body;
  };
  const calls = async () => (await harness.request<CallsView>("GET", "/api/calls")).body;
  const callTask = async (taskId: string) => (await harness.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;

  const web = new Hono();
  web.all("/api/*", (c) => harness.fetch(c.req.raw));
  web.use("/assets/*", serveStatic({ root: "dist" }));
  web.get("*", serveStatic({ root: "dist", path: "index.html" }));
  const { url, close } = await new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = serve({ fetch: web.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }));
    server.unref();
  });

  return {
    url,
    harness,
    dataDir,
    record,
    lead,
    read,
    calls,
    callTask,
    close: async () => {
      close();
      await harness.store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
