import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, EnrollmentView } from "../src/shared/api.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { fixture } from "./support.ts";

/**
 * The app over the fake email provider (test/support/fake-email-port.ts), for the screens that
 * need a connected inbox and sent email: the running application has no provider yet and shows
 * "no connected sender". It runs in the test worker on its own port, with the built client and a
 * clock the tests advance. Nothing here reaches a real provider; all data is fictitious.
 */
export const FAKE_INBOX = "outreach@northlight-mail.example";

/** Monday 9 November 2026, 08:00 in London. */
const MONDAY_8 = Date.parse("2026-11-09T08:00:00Z");
const H = 3_600_000;

export interface FakeProviderApp {
  readonly url: string;
  readonly harness: EngineHarness;
  /** Campaign ids by role. */
  readonly running: string;
  readonly ready: string;
  readonly blocked: string;
  /** Record ids of people in the running campaign, by name. */
  readonly person: (name: string) => string;
  readonly company: (name: string) => string;
  readonly enrollment: (name: string) => string;
}

const step = (id: string, fields: Partial<StepDefinition>): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "continue_thread", removed: false, ...fields });

export const COPY = {
  first: step("s1", {
    subject: "Evening bookings at {{company}}",
    body: "Hi {{first_name|there}},\n\nI came across {{company}} while looking at clinics in {{city|your area}}. Online booking stops at 18:00, which is when people with desk jobs go looking.\n\nWorth a 15-minute call next week?\n\nAlex Moreau\nNorthlight Bookings",
    threading: "new_subject",
  }),
  second: step("s2", { waitDays: 2, body: "Hi {{first_name|there}},\n\nA quick follow-up. Happy to send a two-minute video of how evening booking would look for {{company}}.\n\nAlex" }),
};

const definition = (steps: StepDefinition[]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [FAKE_INBOX],
  tracks: [{ id: "email", channel: "email", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps, start: { kind: "entry" }, removed: false }],
});

let started: Promise<FakeProviderApp> | null = null;

/** One app per test worker, seeded once. */
export function fakeProviderApp(): Promise<FakeProviderApp> {
  started ??= start();
  return started;
}

async function start(): Promise<FakeProviderApp> {
  const harness = new EngineHarness({
    start: MONDAY_8,
    accounts: [{ id: FAKE_INBOX, capacity: 30, gapMs: 60_000, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
  });
  const csv = { businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") };
  const create = async (name: string) => (await harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: "Europe/London", ...csv })).body.campaign.id;

  const running = await create("Physio clinics, Bristol");
  const ready = await create("Chiropractors, Bath");
  const blocked = await create("Osteopaths, Cardiff");
  await harness.tick();
  await harness.defineSequence(running, definition([COPY.first, COPY.second]));
  await harness.defineSequence(ready, definition([COPY.first, COPY.second]));
  await harness.defineSequence(blocked, definition([{ ...COPY.first, body: "Hi {{first_name}}, a note for {{company}}." }, step("s2", { waitDays: 3 })]));

  // Tom's address hard-bounces; Daniel replies to his first email.
  harness.fake.bouncing.add("tom@harbourlanephysio.example");
  harness.clock = MONDAY_8 + H;
  await harness.launch(running);
  await harness.advanceTo(MONDAY_8 + 4 * H);
  harness.fake.prospectReplies("daniel@elmstreetchiro.example");
  await harness.advanceTo(MONDAY_8 + 4 * 24 * H);

  const rows = (await harness.request<{ rows: { kind: string; id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", `/api/leads?campaign=${running}&limit=500`)).body.rows;
  const row = (name: string) => {
    const found = rows.find((r) => r.name === name);
    if (!found) throw new Error(`no lead named ${name}`);
    return found;
  };

  const web = new Hono();
  web.all("/api/*", (c) => harness.fetch(c.req.raw));
  web.use("/assets/*", serveStatic({ root: "dist" }));
  web.get("*", serveStatic({ root: "dist", path: "index.html" }));
  const url = await new Promise<string>((resolve) => {
    const server = serve({ fetch: web.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
    server.unref();
  });

  return {
    url,
    harness,
    running,
    ready,
    blocked,
    person: (name) => row(name).id,
    company: (name) => row(name).id,
    enrollment: (name) => row(name).enrollments.find((e) => e.campaign.id === running)?.id ?? "",
  };
}
