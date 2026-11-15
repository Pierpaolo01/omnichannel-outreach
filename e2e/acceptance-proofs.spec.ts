import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, test, type Page } from "@playwright/test";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, LeadSearchResult, NeedsAttention, TodayView } from "../src/shared/api.ts";
import { FakeEmailPort } from "../test/support/fake-email-port.ts";
import { business, csvOf, person, type ExportRows } from "../test/support/export-builder.ts";
import { acceptanceWorld, DAY, exportFiles, H, INBOX, MIN, NUMBERS, OWN_EMAIL, OWN_MOBILE, PEOPLE, type AcceptanceWorld, type WorldOptions } from "./acceptance-world.ts";

/**
 * Ticket 23: the spec's supporting acceptance cases that the story does not walk through itself, each its own named test
 * through the application's HTTP surface and screens, on the fake providers (e2e/acceptance-world.ts). Each test keeps its
 * own record of what must happen, worked out from the spec's rules and its own inputs, and checks the application and the
 * fake providers' logs against it. Every name, address and number is fictitious.
 */

test.use({ timezoneId: "Europe/London", actionTimeout: 15_000 });

const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const step = (id: string, fields: Partial<StepDefinition>): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false, ...fields });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }, extra: Partial<TrackDefinition> = {}): TrackDefinition => ({ id, channel, branch: "main", window: WEEKDAYS, start, removed: false, steps, ...extra });
const definition = (tracks: TrackDefinition[], extra: Partial<CampaignDefinition> = {}): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [INBOX], smsPool: [...NUMBERS], callScript: "Ask for the clinic director.", tracks, ...extra });

/** The story's canvas, over HTTP: email (2) and SMS (2) and a phone track together, an email a day after the call. */
const STORY = (callSkipLimitDays = 2) =>
  definition(
    [
      track("email", "email", [step("s1", { subject: "Evening bookings at {{company}}", body: "First email for {{company}}." }), step("s2", { waitDays: 2, threading: "continue_thread", body: "Second email for {{company}}." })]),
      track("sms", "sms", [step("m1", { body: "First text for {{company}}." }), step("m2", { waitDays: 2, body: "Second text for {{company}}." })]),
      track("phone", "call", [step("c1", {})]),
      track("after-call", "email", [step("a1", { subject: "Following up on my call", body: "After the call, {{company}}." })], { kind: "after", trackId: "phone", delayDays: 1 }),
    ],
    { callSkipLimitDays },
  );

/** A small fictitious export: one clinic, people with an email and a mobile each unless told otherwise. */
function clinic(names: readonly string[], extra: Partial<Record<string, string>> = {}): ExportRows {
  return {
    businesses: [business({ business_id: "bz-lark", place_id: "pl-lark", business_name: "Lark Street Clinic", city: "Bristol", phone_e164: "+441174960303" })],
    people: names.map((n, i) => person({ person_id: `pp-${i}`, business_id: "bz-lark", full_name: n, email: `${n.split(" ")[0]?.toLowerCase() ?? ""}@larkstreet.example`, dial_phone: `+4477009005${String(i).padStart(2, "0")}`, dial_phone_type: "mobile", ...extra })),
  };
}

const LONDON = "Europe/London";
const hhmm = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
/** London is on GMT from 9 to 30 November 2026, so a London day is a UTC day here. */
const dayOf = (t: number) => Math.floor(t / DAY);
const MONDAY_9 = Date.parse("2026-11-09T09:00:00Z");

let w: AcceptanceWorld | null = null;
test.afterEach(async () => {
  await w?.close();
  w = null;
});

async function world(options: WorldOptions = {}): Promise<AcceptanceWorld> {
  w = await acceptanceWorld({ smsConnected: true, ...options });
  return w;
}

async function campaign(world: AcceptanceWorld, name: string, rows: ExportRows | null, def: CampaignDefinition, launch = true): Promise<string> {
  const files = rows ? csvOf(rows) : { businessesCsv: exportFiles().businesses.toString(), peopleCsv: exportFiles().people.toString() };
  const created = await world.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: LONDON, ...files });
  expect(created.status).toBe(201);
  const id = created.body.campaign.id;
  await world.harness.defineSequence(id, def);
  if (launch) expect((await world.harness.launch(id)).status).toBe(200);
  return id;
}

async function at(page: Page, world: AcceptanceWorld, route: string): Promise<void> {
  await page.clock.setFixedTime(world.harness.clock);
  await page.goto(world.url + route);
}

const deliveries = (world: AcceptanceWorld) => [...world.harness.fake.deliveryLog, ...world.harness.sms.deliveryLog];
const sentTo = (world: AcceptanceWorld, lead: string, body: string) => deliveries(world).filter((d) => d.subjectId === lead && d.rendered.body.startsWith(body));

/** The spec's pacing, as the test's own scheduler: each sender sends what is due, oldest first, one per gap. */
function paced(due: readonly number[], gap: number, after = -Infinity): number[] {
  const out: number[] = [];
  let last = after;
  for (const d of [...due].sort((x, y) => x - y)) {
    const t = Math.max(d, last + gap);
    out.push(t);
    last = t;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Interruption recovery, with the application as a separate process stopped mid-send (items 5 and 13).

test("interruption recovery: the application's process exits after the provider accepts an email and before it is recorded; restarted three hours later on the same database, nothing is sent twice, nothing is skipped, and the missed sends are spread", async ({ page }) => {
  test.setTimeout(120_000);
  const GAP = 10 * MIN;
  const STOP = 3 * H;
  const folder = mkdtempSync(path.join(os.tmpdir(), "outreach-acceptance-process-"));
  const db = path.join(folder, "outreach.sqlite");
  let clock = MONDAY_9;
  // The provider, here in the test's process: it carries on while the application is gone.
  const fake = new FakeEmailPort({ now: () => clock, random: () => 0.5, accounts: [{ id: INBOX, capacity: 48, gapMs: GAP, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["honest"] });
  const providerApp = new Hono();
  providerApp.post("/port/:method", async (c) => {
    const method = c.req.param("method") as "accounts" | "presendCheck" | "handover" | "withdraw" | "observe" | "lookup";
    const args = await c.req.json<unknown[]>();
    try {
      const value: unknown = await (fake[method] as (...a: unknown[]) => Promise<unknown>).apply(fake, args);
      return c.json({ ok: true, value });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  const providerServer = await new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = serve({ fetch: providerApp.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }));
  });

  const processes: ChildProcess[] = [];
  async function start(env: Record<string, string>): Promise<{ url: string; exited: Promise<number | null> }> {
    const child = spawn(process.execPath, ["--import", "./src/server/quiet-sqlite-warning.ts", "e2e/acceptance-process.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, ACCEPTANCE_DB: db, ACCEPTANCE_PROVIDER: providerServer.url, ACCEPTANCE_START: String(clock), ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    processes.push(child);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        const port = /listening (\d+)/.exec(chunk.toString())?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
      });
      child.once("exit", (code) => reject(new Error(`the application exited before listening (${String(code)})`)));
    });
    return { url, exited };
  }
  const api = async <T>(url: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(url + route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** Ticks the application at each instant it or the provider has work, to `target`; false if the process died. */
  async function run(url: string, target: number): Promise<boolean> {
    for (let guard = 0; guard < 10_000; guard++) {
      fake.advance();
      let next: number | null;
      try {
        next = (await api<{ nextWake: number | null }>(url, "POST", "/control/tick", { clock })).body.nextWake;
      } catch {
        return false;
      }
      if (clock >= target) return true;
      clock = Math.min(...[next, fake.nextActivityAt(), target].filter((t): t is number => t !== null && t > clock));
    }
    return true;
  }

  try {
    // The first process: four leads, one email each, one inbox sending one every ten minutes. It dies on its second send.
    const first = await start({ ACCEPTANCE_IDS: "p1", CRASH_AT_EMAIL_HANDOVER: "2" });
    expect((await api(first.url, "PUT", "/api/call-settings", { dailyCapacity: 10, userZone: LONDON })).status).toBe(200);
    const names = ["Pat Oneil", "Nia Cole", "Sam Reed", "Ivo Marsh"];
    const created = await api<{ campaign: Campaign }>(first.url, "POST", "/api/campaigns", { name: "Clinics, Bristol", defaultTimezone: LONDON, ...csvOf(clinic(names, { dial_phone: "", dial_phone_type: "" })) });
    const id = created.body.campaign.id;
    expect((await api(first.url, "PUT", `/api/campaigns/${id}/sequence`, definition([track("email", "email", [step("s1", { subject: "A note for {{company}}", body: "First email for {{company}}." })])], { smsPool: [] }))).status).toBe(200);
    expect((await api(first.url, "POST", `/api/campaigns/${id}/launch`)).status).toBe(200);
    expect(await run(first.url, MONDAY_9 + H)).toBe(false);
    expect(await first.exited).toBe(70);
    const stoppedAt = clock;
    // The provider took the second email before the process died: it is in its log, on the email channel.
    expect(fake.handoverLog).toHaveLength(2);
    const crashed = fake.handoverLog[1];
    expect(crashed?.sender).toBe(INBOX);
    expect(crashed?.at).toBe(stoppedAt);
    expect(stoppedAt).toBe(MONDAY_9 + GAP);

    // Three hours with no application; the provider carries on.
    clock = stoppedAt + STOP;
    fake.advance();
    const restartedAt = clock;
    const second = await start({ ACCEPTANCE_IDS: "p2", ACCEPTANCE_RESTART: "1" });
    expect(await run(second.url, restartedAt + 2 * H)).toBe(true);

    // The test's record: each lead's one email, exactly once (the crashed one included); the two leads whose emails
    // were due and not with the provider when it stopped go one pacing gap apart from the restart.
    const leads = (await api<LeadSearchResult>(second.url, "GET", `/api/leads?campaign=${id}&limit=50`)).body.rows.map((r) => r.enrollments[0]?.id ?? "");
    expect(fake.deliveryLog.map((d) => d.subjectId).sort()).toEqual([...leads].sort());
    expect(fake.deliveryLog.filter((d) => d.key === crashed?.key)).toHaveLength(1);
    const handedBeforeStop = fake.handoverLog.filter((h) => h.at <= stoppedAt).map((h) => h.subjectId);
    const missed = leads.filter((l) => !handedBeforeStop.includes(l));
    expect(missed).toHaveLength(2);
    const after = fake.handoverLog.filter((h) => h.at >= restartedAt && missed.includes(h.subjectId)).map((h) => h.at);
    expect(after).toEqual(paced(missed.map(() => restartedAt), GAP));
    // Today's notice: from the instant the process stopped to the restart, with the count the test worked out.
    const today = (await api<TodayView>(second.url, "GET", "/api/today")).body;
    expect(today.interruption).toEqual({ from: new Date(stoppedAt).toISOString(), to: new Date(restartedAt).toISOString(), rescheduled: missed.length });
    await page.clock.setFixedTime(clock);
    await page.goto(second.url + "/");
    await expect(page.getByTestId("interruption-line")).toHaveText(`Sending was interrupted from ${hhmm(stoppedAt)} to ${hhmm(restartedAt)}; ${missed.length} sends rescheduled.`);
  } finally {
    for (const p of processes) if (p.exitCode === null) p.kill();
    await Promise.all(processes.map((p) => (p.exitCode === null ? new Promise((r) => p.once("exit", r)) : Promise.resolve())));
    providerServer.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Resume after a pause, with a backlog a burst would show (item 1).

test("resume without a burst: everything that fell due while the campaign was paused goes one pacing gap apart per sender after resume, and every later wait moved by the pause", async () => {
  const GAP = 10 * MIN;
  // Launched on Monday at 08:00, before the 09:00 window opens: nothing goes before the pause, whatever the pacing.
  const LAUNCH = MONDAY_9 - H;
  // Four sends may be unsettled at once per sender, so only the pacing gap keeps sends apart: a burst would show.
  const world_ = await world({ start: LAUNCH, emailCapacity: 48, emailGapMs: GAP, smsGapMs: GAP, inFlight: 4 });
  const names = ["Pat Oneil", "Nia Cole", "Sam Reed", "Ivo Marsh"];
  const def = definition([track("email", "email", [step("s1", { subject: "A note", body: "First email for {{company}}." }), step("s2", { waitDays: 1, threading: "continue_thread", body: "Second email for {{company}}." })]), track("sms", "sms", [step("m1", { body: "First text for {{company}}." })])], { smsPool: [NUMBERS[0]] });
  const id = await campaign(world_, "Clinics, Bristol", clinic(names), def);
  const h = world_.harness;
  const PAUSE_AT = LAUNCH + 30 * MIN;
  await h.advanceTo(PAUSE_AT);
  expect(h.fake.handoverLog).toHaveLength(0);
  expect(h.sms.handoverLog).toHaveLength(0);
  expect((await h.request("POST", `/api/campaigns/${id}/pause`, { requestId: "pause-1" })).status).toBe(200);
  // Wednesday 10:00, the window open: every first email and text has long been due.
  const RESUME_AT = Date.parse("2026-11-11T10:00:00Z");
  await h.advanceTo(RESUME_AT);
  expect(h.fake.handoverLog).toHaveLength(0);
  expect((await h.request("POST", `/api/campaigns/${id}/resume`, { requestId: "resume-1" })).status).toBe(200);
  // The worker's own pace after resume: a tick every 15 seconds for an hour, as production runs it. (The harness's
  // advanceTo jumps from one wake to the next and never ticks twice at an instant, which would hide a burst.)
  for (let t = RESUME_AT; t <= RESUME_AT + H; t += 15_000) {
    h.clock = t;
    await h.tick();
  }
  // The record: four emails and four texts were due at the resume. Per sender they go at the resume and one gap after
  // another: four each, never together.
  for (const log of [h.fake.handoverLog, h.sms.handoverLog]) expect(log.map((x) => x.at)).toEqual(paced(names.map(() => RESUME_AT), GAP));
  // The second emails: due at the start of the local day after each first email (Thursday), from 09:00, one gap apart.
  await h.advanceTo(Date.parse("2026-11-12T12:00:00Z"));
  const seconds = h.fake.deliveryLog.filter((d) => d.rendered.body.startsWith("Second email")).map((d) => d.at);
  expect(seconds).toEqual(paced(names.map(() => Date.parse("2026-11-12T09:00:00Z")), GAP));
});

// ---------------------------------------------------------------------------------------------
// Failed and missing tracks release what waits on them (items 4 and 6).

test("a failed track releases what waits on it: a bounced email track and a track whose number was reported invalid each start the track after them a day later; a healthy lead's only after its last step", async () => {
  const world_ = await world();
  const names = ["Xan Bell", "Yara Fox", "Zed Hale"];
  // X's address bounces; Y's mobile is reported invalid after the first text; Z's both work.
  const h = world_.harness;
  h.fake.bouncing.add("xan@larkstreet.example");
  h.sms.invalidAfterSend.add("+447700900501");
  const def = definition([
    track("email", "email", [step("s1", { subject: "A note", body: "First email." }), step("s2", { waitDays: 2, threading: "continue_thread", body: "Second email." })]),
    track("sms", "sms", [step("m1", { body: "First text." }), step("m2", { waitDays: 2, body: "Second text." })]),
    track("after-email", "sms", [step("ae1", { body: "Text after the email track." })], { kind: "after", trackId: "email", delayDays: 1 }),
    track("after-sms", "email", [step("as1", { subject: "After the texts", body: "Email after the SMS track." })], { kind: "after", trackId: "sms", delayDays: 1 }),
  ]);
  const id = await campaign(world_, "Clinics, Bristol", clinic(names), def);
  await h.advanceTo(Date.parse("2026-11-13T17:00:00Z"));
  const lead = async (name: string) => world_.lead(name, id);
  const [x, y, z] = [await lead("Xan Bell"), await lead("Yara Fox"), await lead("Zed Hale")];
  const one = (subject: string, body: string) => {
    const got = sentTo(world_, subject, body);
    expect(got, body).toHaveLength(1);
    return got[0]?.at ?? NaN;
  };
  // The record. A track finishes when its last step goes or when it fails (the fake reports a bounce five minutes after
  // the send and an invalid number two minutes after it); the track after it starts at the start of the local day one
  // day later, and sends when that day's window opens.
  const xBounce = one(x, "First email.") + 5 * MIN;
  expect(sentTo(world_, x, "Second email.")).toHaveLength(0);
  expect(dayOf(one(x, "Text after the email track."))).toBe(dayOf(xBounce) + 1);
  const yInvalid = one(y, "First text.") + 2 * MIN;
  expect(sentTo(world_, y, "Second text.")).toHaveLength(0);
  expect(dayOf(one(y, "Email after the SMS track."))).toBe(dayOf(yInvalid) + 1);
  // Z: the tracks after them wait for the second email and second text (two days on), then a day more.
  expect(dayOf(one(z, "Text after the email track."))).toBe(dayOf(one(z, "Second email.")) + 1);
  expect(dayOf(one(z, "Email after the SMS track."))).toBe(dayOf(one(z, "Second text.")) + 1);
  expect(dayOf(one(z, "Second email."))).toBe(dayOf(one(z, "First email.")) + 2);
});

test("a missing track releases what waits on it, and an open call holds only what is after it: a company lead with no number skips the call; a lead whose call stays open gets its second email and text, not the email after the call", async () => {
  const world_ = await world();
  const h = world_.harness;
  // A skip limit of five days keeps Eve's call open past her second email's day.
  const id = await campaign(world_, "Clinics, Bristol", null, STORY(5));
  const launchedAt = h.clock;
  const juniper = await world_.lead("Juniper Pilates Studio", id);
  const eve = await world_.lead("Eve Hart", id);
  // Wednesday noon: two days after launch.
  await h.advanceTo(Date.parse("2026-11-11T12:00:00Z"));
  const read = await world_.read(juniper);
  expect(read.tracks.find((t) => t.trackId === "phone")?.finishReason).toBe("skipped_missing_channel");
  expect(read.tracks.find((t) => t.trackId === "sms")?.finishReason).toBe("skipped_missing_channel");
  // The record: Juniper's phone track was skipped at launch, so the email after it is due a day later: Tuesday.
  const after = sentTo(world_, juniper, "After the call");
  expect(after).toHaveLength(1);
  expect(dayOf(after[0]?.at ?? NaN)).toBe(dayOf(launchedAt) + 1);
  // Eve's call is still open (nobody worked it); her second email and second text went on Wednesday; the email after the
  // call did not.
  expect((await world_.read(eve)).tracks.find((t) => t.trackId === "phone")?.callTask?.open).toBe(true);
  for (const body of ["Second email", "Second text"]) {
    const got = sentTo(world_, eve, body);
    expect(got, body).toHaveLength(1);
    expect(dayOf(got[0]?.at ?? NaN), body).toBe(dayOf(launchedAt) + 2);
  }
  expect(sentTo(world_, eve, "After the call")).toHaveLength(0);
});

// ---------------------------------------------------------------------------------------------
// Reimport, and one person in two campaigns (item 12).

test("reimport into a running campaign: nobody is enrolled twice or restarted; a new person starts from the first step; a newer email is marked newer", async ({ page }) => {
  const world_ = await world();
  const id = await campaign(world_, "Clinics, Bristol", null, STORY());
  const launchedAt = world_.harness.clock;
  await world_.harness.advanceTo(launchedAt + 3 * H);
  // The earlier leads, by the names in the first file: its 11 people and the studio, its one company lead.
  const earlier = [...Object.values(PEOPLE).map((p) => p["full_name"] ?? ""), "Juniper Pilates Studio"];
  const ids = new Map<string, string>();
  for (const name of earlier) ids.set(name, await world_.lead(name, id));
  // Their progress so far, from the providers' logs: each lead's messages, by step, before the second import.
  const sentBefore = new Map(earlier.map((name) => [name, deliveries(world_).filter((d) => d.subjectId === ids.get(name)).map((d) => d.stepId).sort()]));
  for (const [name, steps] of sentBefore) expect(steps, name).toEqual(name === "Juniper Pilates Studio" ? ["s1"] : ["m1", "s1"]);

  // A later scraper run: the same rows, Ada with a new address, and one new person at Kestrel Dental.
  const people = Object.values(PEOPLE).map((p) => (p["person_id"] === "pp-ada" ? { ...p, email: "ada.reyes@harbourmail.example" } : p));
  const newcomer = person({ person_id: "pp-lia", business_id: "bz-kestrel", full_name: "Lia Grant", title: "Practice manager", email: "lia@kestreldental.example" });
  const files = csvOf({ businesses: [business({ business_id: "bz-harbour", place_id: "pl-harbour", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960101", phone_original: "0117 496 0101" }), business({ business_id: "bz-kestrel", place_id: "pl-kestrel", business_name: "Kestrel Dental", city: "Bristol", phone_e164: "+441174960202", phone_original: "0117 496 0202" }), business({ business_id: "bz-juniper", place_id: "pl-juniper", business_name: "Juniper Pilates Studio", city: "Bath", general_emails: "hello@juniperpilates.example" })], people: [...people, newcomer] });

  await at(page, world_, "/campaigns");
  await page.getByRole("link", { name: "Import again into Clinics, Bristol" }).click();
  await page.getByLabel("People file", { exact: true }).setInputFiles({ name: "people-later.csv", mimeType: "text/csv", buffer: Buffer.from(files.peopleCsv) });
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses-later.csv", mimeType: "text/csv", buffer: Buffer.from(files.businessesCsv) });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Imported again into Clinics, Bristol" })).toBeVisible();
  await expect(page.getByText("No sequence was restarted.", { exact: false })).toBeVisible();
  await expect(page.getByRole("tab", { name: "New 1", exact: true })).toBeVisible();
  // Every earlier lead is still enrolled once, as the same lead: one row each in this campaign, the same lead id.
  for (const name of earlier) {
    const rows = (await world_.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}&q=${encodeURIComponent(name)}&limit=50`)).body.rows.filter((r) => r.name === name);
    expect(rows, name).toHaveLength(1);
    expect(rows[0]?.enrollments.filter((e) => e.campaign.id === id).map((e) => e.id), name).toEqual([ids.get(name)]);
  }
  // Not restarted: no earlier lead gets its first email or text again; two days on, each gets its second email once, on
  // the day two days after its first, as its sequence had it before the import.
  await world_.harness.advanceTo(launchedAt + 2 * DAY + 3 * H);
  for (const name of earlier) {
    const got = deliveries(world_).filter((d) => d.subjectId === ids.get(name));
    expect(got.filter((d) => d.stepId === "s1"), name).toHaveLength(1);
    expect(got.filter((d) => d.stepId === "m1"), name).toHaveLength(name === "Juniper Pilates Studio" ? 0 : 1);
    const second = got.filter((d) => d.stepId === "s2");
    expect(second, name).toHaveLength(1);
    expect(dayOf(second[0]?.at ?? NaN), name).toBe(dayOf(got.find((d) => d.stepId === "s1")?.at ?? NaN) + 2);
  }
  // The newcomer starts at the first step.
  const lia = await world_.lead("Lia Grant", id);
  expect(deliveries(world_).filter((d) => d.subjectId === lia).map((d) => d.stepId)[0]).toBe("s1");
  await at(page, world_, `/leads/people/${await world_.record("Ada Reyes")}`);
  await expect(page.getByText("Email, newer")).toBeVisible();
  await expect(page.getByText("ada.reyes@harbourmail.example")).toBeVisible();
});

test("one person in two campaigns stays independent for email and calls: stopped in one, they keep running in the other", async ({ page }) => {
  const world_ = await world();
  const first = await campaign(world_, "Clinics, Bristol", null, STORY());
  const second = await campaign(world_, "Spring follow-up, Bristol", null, STORY());
  await world_.harness.advanceTo(world_.harness.clock + H);
  await at(page, world_, `/leads/people/${await world_.record("Eve Hart")}`);
  const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Clinics, Bristol" }).first();
  await row.getByRole("button", { name: /^Stop: / }).click();
  await page.getByRole("group").getByRole("button", { name: "Stop" }).click();
  await expect(row.getByText("Stopped manually")).toBeVisible();
  const eveFirst = await world_.lead("Eve Hart", first);
  const eveSecond = await world_.lead("Eve Hart", second);
  const stoppedAt = world_.harness.clock;
  // The same day, inside the skip limit: her call in the first campaign has left the list; in the second it is on it.
  const listedNow = async () => {
    const v = (await world_.harness.request<{ readyNow: { enrollmentId: string }[]; laterToday: { enrollmentId: string }[] }>("GET", "/api/calls")).body;
    return [...v.readyNow, ...v.laterToday].map((c) => c.enrollmentId);
  };
  expect(await listedNow()).not.toContain(eveFirst);
  expect(await listedNow()).toContain(eveSecond);
  await world_.harness.advanceTo(world_.harness.clock + 4 * DAY);
  expect((await world_.read(eveFirst)).status).toBe("stopped_manually");
  expect((await world_.read(eveSecond)).status).not.toBe("stopped_manually");
  expect(deliveries(world_).filter((d) => d.subjectId === eveFirst && d.at > stoppedAt)).toHaveLength(0);
  expect(sentTo(world_, eveSecond, "Second email")).toHaveLength(1);
  expect((await world_.read(await world_.lead("Finn Wood", first))).status).not.toBe("stopped_manually");
});

test("one person in two campaigns over SMS: with two free numbers, the second campaign texts them from the other number; with one number, the second campaign's SMS track waits and Needs attention says why (ADR 0003 4.5, question Q7)", async ({ page }) => {
  const world_ = await world();
  const rows = clinic(["Pat Oneil"]);
  const textOnly = (pool: string[]) => definition([track("sms", "sms", [step("m1", { body: "A text from {{company}}'s campaign." })])], { emailPool: [], smsPool: pool });
  // Two numbers free: each campaign may use both.
  const a = await campaign(world_, "Clinics, Bristol", rows, textOnly([...NUMBERS]));
  const b = await campaign(world_, "Spring follow-up, Bristol", rows, textOnly([...NUMBERS]));
  await world_.harness.advanceTo(world_.harness.clock + H);
  const [pa, pb] = [await world_.lead("Pat Oneil", a), await world_.lead("Pat Oneil", b)];
  const fromA = world_.harness.sms.deliveryLog.filter((d) => d.subjectId === pa);
  const fromB = world_.harness.sms.deliveryLog.filter((d) => d.subjectId === pb);
  expect(fromA).toHaveLength(1);
  expect(fromB).toHaveLength(1);
  expect(fromB[0]?.sender).not.toBe(fromA[0]?.sender);

  // One number only: a third campaign that may use only the number the first campaign's conversation holds, with an
  // email track and a phone track as well.
  const c = await campaign(world_, "Autumn follow-up, Bristol", rows, {
    ...textOnly([fromA[0]?.sender ?? ""]),
    emailPool: [INBOX],
    tracks: [...textOnly([]).tracks, track("email", "email", [step("e1", { subject: "Autumn hours", body: "An email from the autumn campaign." })]), track("phone", "call", [step("c1", {})])],
  });
  const pc = await world_.lead("Pat Oneil", c);
  await world_.harness.advanceTo(world_.harness.clock + 10 * MIN);
  // Its email and its call carry on: the email arrives, the call is on the list.
  expect(world_.harness.fake.deliveryLog.filter((d) => d.subjectId === pc).map((d) => d.rendered.body)).toEqual(["An email from the autumn campaign."]);
  const calls = (await world_.harness.request<{ readyNow: { enrollmentId: string }[]; laterToday: { enrollmentId: string }[] }>("GET", "/api/calls")).body;
  expect([...calls.readyNow, ...calls.laterToday].map((x) => x.enrollmentId)).toContain(pc);
  await world_.harness.advanceTo(world_.harness.clock + DAY);
  // Its SMS track sends nothing: today's behaviour, held (the principal's decision of 15 November 2026 changes it to a
  // skip with the reason shown, in its own pull request).
  expect(world_.harness.sms.deliveryLog.filter((d) => d.subjectId === pc)).toHaveLength(0);
  const needs = (await world_.harness.request<NeedsAttention>("GET", "/api/needs-attention")).body;
  expect(needs.heldTracks.filter((t) => t.enrollmentId === pc).map((t) => t.reason)).toEqual(["sms_conversation_taken"]);
  await at(page, world_, "/");
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("the mobile is in another campaign’s SMS conversation from every number this campaign may use");
});

// ---------------------------------------------------------------------------------------------
// Test runs: on a running campaign, sharing the senders' capacity (item 3), and the test call's stop and continue paths (item 14).

async function saveTestContacts(page: Page, world_: AcceptanceWorld, id: string, renderAs: string) {
  await at(page, world_, `/campaigns/${id}/test-run`);
  await page.getByLabel("Your email").fill(OWN_EMAIL);
  await page.getByLabel("Your mobile, for texts and the test call").fill(OWN_MOBILE);
  await page.getByRole("button", { name: "Save contacts" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByLabel("Copy written for").selectOption({ label: renderAs });
}

test("a test run on a running campaign: it can be run again after launch, and its sends take the inbox's ordinary daily capacity", async ({ page }) => {
  // One inbox of four sends a day; three leads; a two-email sequence.
  const world_ = await world({ emailCapacity: 4 });
  const h = world_.harness;
  const def = definition([track("email", "email", [step("s1", { subject: "A note", body: "First email for {{company}}." }), step("s2", { waitDays: 1, threading: "continue_thread", body: "Second email for {{company}}." })])], { smsPool: [] });
  const id = await campaign(world_, "Clinics, Bristol", clinic(["Pat Oneil", "Nia Cole", "Sam Reed"], { dial_phone: "", dial_phone_type: "" }), def);
  await h.advanceTo(MONDAY_9 + 10 * MIN);
  // The record: three first emails on Monday, one slot left.
  const monday = (t: number) => dayOf(t) === dayOf(MONDAY_9);
  expect(h.fake.deliveryLog.filter((d) => monday(d.at))).toHaveLength(3);

  await saveTestContacts(page, world_, id, "Pat Oneil");
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
  await h.advanceTo(h.clock + 30 * MIN);
  // The test's first email takes Monday's last slot; its second waits, like any send, for the inbox's next day.
  const own = () => h.fake.deliveryLog.filter((d) => d.destination === OWN_EMAIL);
  expect(own().filter((d) => monday(d.at))).toHaveLength(1);
  expect(h.fake.deliveryLog.filter((d) => monday(d.at))).toHaveLength(4);
  await h.advanceTo(Date.parse("2026-11-10T12:00:00Z"));
  expect(own()).toHaveLength(2);
  expect(dayOf(own()[1]?.at ?? NaN)).toBe(dayOf(MONDAY_9) + 1);
  // Never more than four a day from the inbox, test sends included.
  const perDay = new Map<number, number>();
  for (const d of h.fake.deliveryLog) perDay.set(dayOf(d.at), (perDay.get(dayOf(d.at)) ?? 0) + 1);
  for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(4);
});

test("the test call's declined paths: stop ends the test there; continue sends the rest of the other channels and nothing of win back", async ({ page }) => {
  const world_ = await world();
  const h = world_.harness;
  const def = (path: "stop" | "continue") =>
    definition([
      track("email", "email", [step("s1", { subject: "A note", body: "First email for {{company}}." }), step("s2", { waitDays: 1, threading: "continue_thread", body: "Second email for {{company}}." })]),
      track("phone", "call", [step("c1", {})], { kind: "entry" }, { declinedPath: path }),
      { ...track("win-back", "email", [step("w1", { subject: "One more idea", body: "Win-back email for {{company}}." })]), branch: "win_back" },
    ], { smsPool: [] });
  const own = () => h.fake.deliveryLog.filter((d) => d.destination === OWN_EMAIL).map((d) => d.rendered.body.split(" for ")[0]);
  for (const path of ["stop", "continue"] as const) {
    const id = await campaign(world_, `Clinics, ${path}`, clinic(["Pat Oneil"]), def(path), false);
    const before = own().length;
    await saveTestContacts(page, world_, id, "Pat Oneil");
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    // Half a minute in: the first email has gone and the test call is on the list; the second email is a minute away.
    await h.advanceTo(h.clock + 30_000);
    expect(own().slice(before)).toEqual(["First email"]);
    await at(page, world_, "/calls");
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "Not interested", exact: true }).click();
    const radio = page.getByRole("group", { name: /What happens next for/ }).getByRole("radio", { name: path === "stop" ? /Stop all outreach in this campaign/ : /Keep the email and SMS steps going/ });
    await expect(radio).toBeChecked();
    await page.getByRole("button", { name: /^Log/ }).first().click();
    await expect(page.locator("p[role='status']").first()).toBeVisible();
    await h.advanceTo(h.clock + 5 * MIN);
    // The record: stop sends nothing more; continue sends the second email; neither enters win back.
    expect(own().slice(before)).toEqual(path === "stop" ? ["First email"] : ["First email", "Second email"]);
    await at(page, world_, `/campaigns/${id}/test-run`);
    await expect(page.getByText(/Logged \d\d:\d\d: Not interested/)).toBeVisible();
  }
});
