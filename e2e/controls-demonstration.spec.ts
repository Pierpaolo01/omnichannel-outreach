import { expect, test, type Page } from "@playwright/test";
import type { ActivityView, EnrollmentRead, LeadSearchResult } from "../src/shared/api.ts";
import { fakeCallsApp, type FakeCallsApp } from "./fake-provider.ts";

/**
 * Ticket 17's demonstration (recorded with RECORD_DEMO=1), on the fake providers with fictitious data: a campaign paused
 * during a wait and during a pending call, its call's skip limit frozen while paused, a resume without a burst, a skip, a
 * stop, and a restart after an auto-reply that sends nothing twice. One story on one app; the clock moves by the harness.
 */

const H = 3_600_000;
const DAY = 24 * H;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

async function at(page: Page, f: FakeCallsApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
}

const row = (page: Page) => page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Clinics, London" }).first();

test("pause during a wait and a pending call, the frozen skip limit, a smooth resume, skip, stop, and a restart after an auto-reply", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeCallsApp("win-back", "controls-demonstration");
  const amira = f.person("Amira Hassan");
  const enrollmentOf = async (who: string) => (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const amiraLead = await enrollmentOf("Amira Hassan");
  const read = async () => (await f.harness.request<EnrollmentRead>("GET", `/api/enrollments/${amiraLead}`)).body;
  const callDue = async () => (await read()).tracks.find((t) => t.trackId === "phone")?.callTask?.dueAt;

  await test.step("Monday 10:00: email 1 went out, email 2 waits two days, and the call is on today's list", async () => {
    await at(page, f, `/leads/people/${amira}`);
    await expect(row(page).getByText("Waiting on call")).toBeVisible();
    await expect(row(page).getByText(/Their call is on today’s list/)).toBeVisible();
    await linger(page);
  });

  const dueBefore = await callDue();
  const email2Before = (await read()).tracks.find((t) => t.trackId === "email")?.nextStep?.dueAt;

  await test.step("pause the campaign from the list, during the wait and with the call pending", async () => {
    await at(page, f, "/campaigns");
    await page.getByRole("button", { name: "Pause campaign: Clinics, London" }).click();
    await linger(page);
    await page.getByRole("group").getByRole("button", { name: "Pause campaign" }).click();
    await expect(page.getByRole("heading", { name: "Paused since Mon 9 Nov at 10:00" })).toBeVisible();
    await linger(page);
    await at(page, f, "/calls");
    await expect(page.getByText(/calls in Clinics, London are off your list while the campaign is paused/).first()).toBeVisible();
    await linger(page);
  });

  await test.step("three days pass while paused: nothing goes out, and the call's two-day skip limit does not run out", async () => {
    const sentBefore = f.harness.fake.deliveryLog.length;
    await f.harness.advanceTo(f.harness.clock + 3 * DAY);
    expect(f.harness.fake.deliveryLog.length).toBe(sentBefore);
    await at(page, f, `/leads/people/${amira}`);
    await expect(row(page).getByText("(campaign paused)")).toBeVisible();
    await expect(row(page).getByText("The call is on hold while this campaign is paused.")).toBeVisible();
    await linger(page);
    expect((await read()).tracks.find((t) => t.trackId === "phone")?.callTask?.open).toBe(true);
  });

  await test.step("resume from the campaign's page: every wait continues where it was, moved by the time paused", async () => {
    await at(page, f, `/campaigns/${f.campaign}`);
    await page.getByRole("button", { name: "Resume campaign: Clinics, London" }).click();
    await linger(page);
    await page.getByRole("group").getByRole("button", { name: "Resume campaign" }).click();
    await expect(page.getByText("Resumed. Each lead continues where it was.")).toBeVisible();
    await linger(page);
    // The call keeps its original due time; email 2 is due three days later than it was, by the time paused.
    expect(await callDue()).toBe(dueBefore);
    const email2After = (await read()).tracks.find((t) => t.trackId === "email")?.nextStep?.dueAt;
    expect(Date.parse(email2After ?? "") - Date.parse(email2Before ?? "")).toBe(3 * DAY);
    await at(page, f, "/calls");
    await expect(page.getByText(/Rolled over, due Mon 9 Nov/).first()).toBeVisible();
    await linger(page);
  });

  await test.step("no burst: the emails that fell due go out one pacing gap apart", async () => {
    const before = f.harness.fake.deliveryLog.length;
    await f.harness.advanceTo(f.harness.clock + 2 * H);
    const sent = f.harness.fake.deliveryLog.slice(before).map((d) => d.at).sort((a, b) => a - b);
    for (let i = 1; i < sent.length; i++) expect((sent[i] ?? 0) - (sent[i - 1] ?? 0)).toBeGreaterThanOrEqual(60_000);
  });

  await test.step("skip Amira's call: never made, and the email after it is named", async () => {
    await at(page, f, `/leads/people/${amira}`);
    await page.getByRole("button", { name: "Skip this step: Amira Hassan in Clinics, London" }).click();
    await linger(page);
    await page.getByRole("group").getByRole("button", { name: "Skip this step" }).click();
    await expect(row(page).getByRole("status").filter({ hasText: /^Call skipped\./ })).toBeVisible();
    await linger(page);
  });

  await test.step("stop Tom, her colleague: only he stops", async () => {
    const tom = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaign}`)).body.rows.find((r) => r.name.startsWith("Tom"));
    await at(page, f, `/leads/people/${tom?.id ?? ""}`);
    const tomRow = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").first();
    await tomRow.getByRole("button", { name: /^Stop: / }).click();
    await linger(page);
    await page.getByRole("group").getByRole("button", { name: "Stop" }).click();
    await expect(tomRow.getByText("Stopped manually")).toBeVisible();
    await linger(page);
  });

  await test.step("an auto-reply stops her; resume from the next step sends nothing twice", async () => {
    expect(f.harness.fake.prospectReplies("amira@harbourlanephysio.example")).toBe(true);
    await f.harness.advanceTo(f.harness.clock + H);
    await at(page, f, `/leads/people/${amira}`);
    await expect(row(page).getByText("Replied, automation stopped")).toBeVisible();
    await linger(page);
    await page.getByRole("button", { name: "Resume from the next step: Amira Hassan in Clinics, London" }).click();
    await linger(page);
    await page.getByRole("group").getByRole("button", { name: "Resume from the next step" }).click();
    await expect(row(page).getByRole("status").filter({ hasText: /^Resumed from the next step/ })).toBeVisible();
    await linger(page);
    await f.harness.advanceTo(f.harness.clock + 6 * DAY);
    const steps = f.harness.fake.deliveryLog.filter((d) => d.subjectId === amiraLead).map((d) => d.stepId);
    expect(new Set(steps).size).toBe(steps.length);
  });

  await test.step("Amira was untouched by Tom's stop, and Activity says each control once", async () => {
    await at(page, f, `/leads/people/${amira}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Call skipped by you")).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Campaign paused")).toBeVisible();
    await page.getByRole("region", { name: "Activity" }).scrollIntoViewIfNeeded();
    await linger(page);
    const entries = (await f.harness.request<ActivityView>("GET", `/api/people/${amira}/activity`)).body.entries;
    expect(entries.flatMap((e) => (e.kind === "control" ? [e.action] : []))).toEqual(["resume_from_next_step", "skip"]);
    expect((await read()).status).not.toBe("stopped_manually");
  });
});
