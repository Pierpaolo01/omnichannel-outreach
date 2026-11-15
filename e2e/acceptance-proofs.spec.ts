import { expect, test, type Page } from "@playwright/test";
import type { CampaignDefinition, StepDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, TodayView } from "../src/shared/api.ts";
import { Crash } from "../test/support/engine-harness.ts";
import { acceptanceWorld, DAY, exportFiles, H, INBOX, MIN, NUMBERS, PEOPLE, type AcceptanceWorld } from "./acceptance-world.ts";
import { business, csvOf, person } from "../test/support/export-builder.ts";

/**
 * Ticket 23: the spec's supporting acceptance cases that the story does not walk through itself, each its own named test
 * through the application's HTTP surface and screens, on the fake providers (e2e/acceptance-world.ts). Where an earlier
 * ticket's test already proves a case at this tip, docs/acceptance/mvp-acceptance.md points to it instead.
 * Every name, address and number is fictitious.
 */

test.use({ timezoneId: "Europe/London", actionTimeout: 15_000 });

const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const step = (id: string, fields: Partial<StepDefinition>): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false, ...fields });

/** The story's canvas, written over HTTP: email (2), SMS (2) and a phone track together, an email a day after the call. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [INBOX],
  smsPool: [...NUMBERS],
  callScript: "Ask for the clinic director.",
  tracks: [
    { id: "email", channel: "email", branch: "main", window: WEEKDAYS, start: { kind: "entry" }, removed: false, steps: [step("s1", { subject: "Evening bookings at {{company}}", body: "Hi {{first_name|there}}, a note for {{company}}." }), step("s2", { waitDays: 2, threading: "continue_thread", body: "A quick follow-up, {{first_name|there}}." })] },
    { id: "sms", channel: "sms", branch: "main", window: WEEKDAYS, start: { kind: "entry" }, removed: false, steps: [step("m1", { body: "Hi {{first_name|there}}, Alex here about {{company}}." }), step("m2", { waitDays: 2, body: "Should I send the video for {{company}}?" })] },
    { id: "phone", channel: "call", branch: "main", window: WEEKDAYS, start: { kind: "entry" }, removed: false, steps: [step("c1", {})] },
    { id: "after-call", channel: "email", branch: "main", window: WEEKDAYS, start: { kind: "after", trackId: "phone", delayDays: 1 }, removed: false, steps: [step("a1", { subject: "Following up on my call", body: "Hi {{first_name|there}}, following up on my call." })] },
  ],
};

let w: AcceptanceWorld | null = null;
test.afterEach(async () => {
  await w?.close();
  w = null;
});

async function launched(world: AcceptanceWorld, name: string, files = exportFiles(), definition = DEFINITION): Promise<string> {
  const created = await world.harness.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name, defaultTimezone: "Europe/London", businessesCsv: files.businesses.toString(), peopleCsv: files.people.toString() });
  expect(created.status).toBe(201);
  const id = created.body.campaign.id;
  await world.harness.defineSequence(id, definition);
  const launch = await world.harness.launch(id);
  expect(launch.status).toBe(200);
  return id;
}

async function at(page: Page, world: AcceptanceWorld, route: string): Promise<void> {
  await page.clock.setFixedTime(world.harness.clock);
  await page.goto(world.url + route);
}

const deliveries = (world: AcceptanceWorld) => [...world.harness.fake.deliveryLog, ...world.harness.sms.deliveryLog];

test("interruption recovery: the application stops in the middle of a send and starts again three hours later; nothing is sent twice, nothing is skipped", async ({ page }) => {
  w = await acceptanceWorld({ smsConnected: true });
  const world = w;
  const id = await launched(world, "Clinics, Bristol");
  const leads = new Map<string, string>();
  for (const p of Object.values(PEOPLE)) leads.set(p["full_name"] ?? "", await world.lead(p["full_name"] ?? "", id));
  const juniper = await world.lead("Juniper Pilates Studio", id);

  // The fifth email: the provider takes it, and the application stops before recording that it did, for three hours.
  let handovers = 0;
  world.harness.hooks = {
    crashPoint: (point) => {
      if (point === "after_call" && ++handovers === 5) {
        world.harness.hooks = {};
        world.harness.downAfterCrash = 3 * H;
        throw new Crash(point);
      }
    },
  };
  await world.harness.advanceTo(world.harness.clock + 30 * MIN);
  expect(world.harness.crashes).toHaveLength(1);
  // The rest of the week: every first and second email and text, and every email after a call skipped unworked.
  await world.harness.advanceTo(world.harness.clock + 7 * DAY);

  // The test's own record of what must have arrived, from the export: each lead gets each email step once, each person
  // with a mobile each text once; nothing more, nothing less.
  const expected: string[] = [];
  for (const lead of leads.values()) expected.push(`${lead}/s1`, `${lead}/s2`, `${lead}/a1`, `${lead}/m1`, `${lead}/m2`);
  expected.push(`${juniper}/s1`, `${juniper}/s2`, `${juniper}/a1`);
  const got = deliveries(world).map((d) => `${d.subjectId}/${d.stepId}`);
  expect([...got].sort()).toEqual([...expected].sort());

  // Today says when sending was interrupted and how many sends were rescheduled, from the server's read.
  const today = (await world.harness.request<TodayView>("GET", "/api/today")).body;
  expect(today.interruption).not.toBeNull();
  await at(page, world, "/");
  await expect(page.getByTestId("interruption-line")).toContainText(`${today.interruption?.rescheduled ?? -1} sends rescheduled`);
});

test("reimport into a running campaign: nobody is enrolled twice or restarted; a new person starts from the first step; a newer email is marked newer", async ({ page }) => {
  w = await acceptanceWorld({ smsConnected: true });
  const world = w;
  const id = await launched(world, "Clinics, Bristol");
  await world.harness.advanceTo(world.harness.clock + 3 * H);
  const ada = await world.lead("Ada Reyes", id);
  const before = await world.read(ada);
  const sentBefore = deliveries(world).length;

  // A later scraper run: the same rows, Ada with a new address, and one new person at Kestrel Dental.
  const people = Object.values(PEOPLE).map((p) => (p["person_id"] === "pp-ada" ? { ...p, email: "ada.reyes@harbourmail.example" } : p));
  const newcomer = person({ person_id: "pp-lia", business_id: "bz-kestrel", full_name: "Lia Grant", title: "Practice manager", email: "lia@kestreldental.example" });
  const businesses = csvOf({ businesses: [business({ business_id: "bz-harbour", place_id: "pl-harbour", business_name: "Harbour Lane Physio", city: "Bristol", phone_e164: "+441174960101", phone_original: "0117 496 0101" }), business({ business_id: "bz-kestrel", place_id: "pl-kestrel", business_name: "Kestrel Dental", city: "Bristol", phone_e164: "+441174960202", phone_original: "0117 496 0202" }), business({ business_id: "bz-juniper", place_id: "pl-juniper", business_name: "Juniper Pilates Studio", city: "Bath", general_emails: "hello@juniperpilates.example" })], people: [...people, newcomer] });

  await at(page, world, "/campaigns");
  await page.getByRole("link", { name: "Import again into Clinics, Bristol" }).click();
  await page.getByLabel("People file", { exact: true }).setInputFiles({ name: "people-later.csv", mimeType: "text/csv", buffer: Buffer.from(businesses.peopleCsv) });
  await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses-later.csv", mimeType: "text/csv", buffer: Buffer.from(businesses.businessesCsv) });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Imported again into Clinics, Bristol" })).toBeVisible();
  await expect(page.getByText("No sequence was restarted.", { exact: false })).toBeVisible();
  await expect(page.getByRole("tab", { name: "New 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: `Already enrolled ${Object.keys(PEOPLE).length}`, exact: false })).toBeVisible();

  // Ada's progress is as it was: same tracks, same next steps; nothing was sent again.
  const after = await world.read(ada);
  expect(after.tracks.map((t) => [t.trackId, t.nextStep?.stepId ?? null, t.finishReason])).toEqual(before.tracks.map((t) => [t.trackId, t.nextStep?.stepId ?? null, t.finishReason]));
  expect(deliveries(world)).toHaveLength(sentBefore);
  await world.harness.advanceTo(world.harness.clock + 30 * MIN);
  const lia = await world.lead("Lia Grant", id);
  expect(deliveries(world).filter((d) => d.subjectId === lia).map((d) => d.stepId)).toEqual(["s1"]);
  const resends = deliveries(world).map((d) => `${d.subjectId}/${d.stepId}`);
  expect(new Set(resends).size).toBe(resends.length);
  await at(page, world, `/leads/people/${await world.record("Ada Reyes")}`);
  await expect(page.getByText("Email, newer")).toBeVisible();
});

test("one person in two campaigns stays independent: stopped in one, they keep running in the other", async ({ page }) => {
  w = await acceptanceWorld({ smsConnected: true });
  const world = w;
  const first = await launched(world, "Clinics, Bristol");
  const second = await launched(world, "Spring follow-up, Bristol");
  await world.harness.advanceTo(world.harness.clock + H);
  await at(page, world, `/leads/people/${await world.record("Eve Hart")}`);
  const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Clinics, Bristol" }).first();
  await row.getByRole("button", { name: /^Stop: / }).click();
  await page.getByRole("group").getByRole("button", { name: "Stop" }).click();
  await expect(row.getByText("Stopped manually")).toBeVisible();
  const eveFirst = await world.lead("Eve Hart", first);
  const eveSecond = await world.lead("Eve Hart", second);
  const stoppedAt = world.harness.clock;
  await world.harness.advanceTo(world.harness.clock + 4 * DAY);
  expect((await world.read(eveFirst)).status).toBe("stopped_manually");
  expect((await world.read(eveSecond)).status).not.toBe("stopped_manually");
  expect(deliveries(world).filter((d) => d.subjectId === eveFirst && d.at > stoppedAt)).toHaveLength(0);
  expect(deliveries(world).filter((d) => d.subjectId === eveSecond && d.at > stoppedAt).map((d) => d.stepId)).toContain("s2");
  // Her colleague is untouched in both.
  expect((await world.read(await world.lead("Finn Wood", first))).status).not.toBe("stopped_manually");
});

test("a missing track releases what waits on it: a company lead with no number skips the call, and the email after the call goes a day later", async ({ page }) => {
  w = await acceptanceWorld({ smsConnected: true });
  const world = w;
  const id = await launched(world, "Clinics, Bristol");
  const launchedAt = world.harness.clock;
  await world.harness.advanceTo(launchedAt + 2 * DAY);
  const juniper = await world.lead("Juniper Pilates Studio", id);
  const read = await world.read(juniper);
  expect(read.tracks.find((t) => t.trackId === "phone")?.finishReason).toBe("skipped_missing_channel");
  expect(read.tracks.find((t) => t.trackId === "sms")?.finishReason).toBe("skipped_missing_channel");
  const after = world.harness.fake.deliveryLog.find((d) => d.subjectId === juniper && d.stepId === "a1");
  expect(after).toBeDefined();
  expect((after?.at ?? 0) - launchedAt).toBeLessThan(2 * DAY);
  expect((after?.at ?? 0) - launchedAt).toBeGreaterThanOrEqual(DAY - H);
  // An unworked call holds only what is after it: Eve's call is still open, her email after the call has not gone,
  // and her parallel email and text tracks went on.
  const eve = await world.lead("Eve Hart", id);
  expect(world.harness.fake.deliveryLog.filter((d) => d.subjectId === eve).map((d) => d.stepId)).toEqual(["s1"]);
  expect(world.harness.sms.deliveryLog.filter((d) => d.subjectId === eve).map((d) => d.stepId)).toEqual(["m1"]);
  await at(page, world, `/leads/companies/${await world.record("Juniper Pilates Studio")}`);
  await expect(page.getByRole("region", { name: "Activity" })).toContainText(/Following up on my call|Email 1 sent/);
  await expect(page.getByRole("region", { name: "Activity" })).toContainText(/phone track/i);
});
