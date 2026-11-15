import { expect, test, type Page } from "@playwright/test";
import type { EnrollmentRead, LeadSearchResult } from "../src/shared/api.ts";
import { fakePeopleApp, type FakePeopleApp } from "./fake-provider.ts";

/**
 * Ticket 18 on the fake providers with fictitious data: lead search with selection and the bulk bar, bulk pause, stop and
 * add scoped to the filtered campaign or to every campaign, a partial result, a reload while a bulk is on its way, and the
 * one-column person page with two campaigns, a company note seen on a colleague, and a filtered timeline.
 */

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

async function at(page: Page, f: FakePeopleApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
}

const leadRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
const statusIn = async (f: FakePeopleApp, who: string, campaignId: string) => {
  const row = (await f.harness.request<LeadSearchResult>("GET", "/api/leads?limit=500")).body.rows.find((r) => r.name === who);
  const id = row?.enrollments.find((e) => e.campaign.id === campaignId)?.id ?? "";
  return (await f.harness.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.status;
};

test("the demonstration: a person in two campaigns, a filtered and an all-campaign bulk operation, add to campaign, a company note seen on a colleague, and a filtered timeline", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakePeopleApp("people-demonstration");

  await test.step("Leads: Amira is one row, with each campaign's status", async () => {
    await at(page, f, "/leads?q=amira");
    const amira = leadRow(page, "Amira Hassan");
    await expect(amira).toHaveCount(1);
    for (const name of ["Clinics, London", "Physio follow-up", "Spring outreach"]) await expect(amira.getByText(name)).toBeVisible();
    await linger(page);
  });

  await test.step("filtered to Clinics, London: pause Amira and Tom there only", async () => {
    await at(page, f, `/leads?campaign=${f.campaigns.clinics}`);
    await leadRow(page, "Amira Hassan").getByRole("checkbox").check();
    await leadRow(page, "Tom").getByRole("checkbox").check();
    await expect(page.getByRole("toolbar")).toContainText("2 selected");
    await expect(page.getByText("Bulk actions change the selected people’s campaigns in Clinics, London only.")).toBeVisible();
    await linger(page);
    await page.getByRole("toolbar").getByRole("button", { name: "Pause" }).click();
    const confirm = page.getByRole("group").filter({ hasText: "Pause 2 campaign enrollments for 2 people in Clinics, London?" });
    await expect(confirm).toBeVisible();
    await linger(page);
    await confirm.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Paused 2 campaign enrollments." })).toBeVisible();
    await linger(page);
    expect(await statusIn(f, "Amira Hassan", f.campaigns.clinics)).toBe("paused");
    expect(await statusIn(f, "Amira Hassan", f.campaigns.followUp)).not.toBe("paused");
  });

  await test.step("every campaign: stop Amira wherever she is; the campaign not launched is left alone, and says why", async () => {
    await at(page, f, "/leads?q=amira");
    await leadRow(page, "Amira Hassan").getByRole("checkbox").check();
    await expect(page.getByText("Pick a campaign above to limit them to one campaign.")).toBeVisible();
    await page.getByRole("toolbar").getByRole("button", { name: "Stop" }).click();
    const confirm = page.getByRole("group").filter({ hasText: "in every campaign they are in?" });
    await expect(confirm).toContainText("Stop 2 campaign enrollments for 1 person, in every campaign they are in? 1 is left alone: This campaign has not launched");
    await linger(page);
    await confirm.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Stopped 2 campaign enrollments." })).toBeVisible();
    await expect(leadRow(page, "Amira Hassan").getByText("Stopped manually")).toHaveCount(2);
    await linger(page);
  });

  await test.step("add Ravi and Amira to Physio follow-up: Ravi is added, Amira is already in it", async () => {
    await at(page, f, "/leads");
    await leadRow(page, "Ravi Patel").getByRole("checkbox").check();
    await leadRow(page, "Amira Hassan").getByRole("checkbox").check();
    await page.getByRole("toolbar").getByLabel("Add to campaign").selectOption({ label: "Physio follow-up" });
    const confirm = page.getByRole("group").filter({ hasText: "Add 1 person to Physio follow-up? 1 is already in it and left alone." });
    await expect(confirm).toBeVisible();
    await linger(page);
    await confirm.getByRole("button", { name: "Add to campaign" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added 1 person to Physio follow-up. 1 was already in it." })).toBeVisible();
    await expect(leadRow(page, "Ravi Patel").getByText("Physio follow-up")).toBeVisible();
    await linger(page);
  });

  await test.step("Amira's page: contact details, her campaigns, Tom's last call note, and his company note on her timeline", async () => {
    await at(page, f, `/leads/people/${f.person("Amira Hassan")}`);
    await expect(page.getByText(/, marked wrong$/)).toBeVisible();
    await expect(page.getByText(/, newer$/)).toBeVisible();
    const campaigns = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem");
    await expect(campaigns.filter({ hasText: "Clinics, London" })).toContainText("Stopped manually");
    const others = page.getByRole("region", { name: "Others at Harbour Lane Physio" });
    await expect(others.getByRole("link", { name: "Tom" })).toBeVisible();
    await expect(others).toContainText("Last call, Today, 10:");
    await expect(others).toContainText("Front desk says the director decides on software.");
    await expect(others.getByRole("button")).toHaveCount(0);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText("Company note", { exact: true })).toBeVisible();
    await linger(page);
  });

  await test.step("a note about Amira, then the timeline filtered to one campaign keeps the notes", async () => {
    const activity = page.getByRole("region", { name: "Activity" });
    await activity.getByLabel("A note about Amira").fill("Prefers email over calls this month.");
    await activity.getByRole("button", { name: "Add note" }).click();
    await expect(activity.getByRole("status").filter({ hasText: "Note added." })).toBeVisible();
    await expect(activity.getByText("Prefers email over calls this month.")).toBeVisible();
    await linger(page);
    await activity.getByLabel("Show activity from").selectOption({ label: "Physio follow-up" });
    await expect(activity.getByText("in Clinics, London")).toHaveCount(0);
    await expect(activity.getByText("in Physio follow-up").first()).toBeVisible();
    await expect(activity.getByText("Prefers email over calls this month.")).toBeVisible();
    await linger(page);
  });

  await test.step("Tom's company note shows on Amira's page; on Tom's own page it is on his call", async () => {
    await at(page, f, `/leads/people/${f.person("Tom")}`);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity.getByText(/Call: no answer/).first()).toBeVisible();
    await expect(activity.getByText("Company note", { exact: true })).toHaveCount(0);
  });
});

test("a partial result: a lead changed between the confirmation and the press is named with the server's reason", async ({ page }) => {
  const f = await fakePeopleApp("people-partial");
  await at(page, f, `/leads?campaign=${f.campaigns.followUp}`);
  await leadRow(page, "Amira Hassan").getByRole("checkbox").check();
  await leadRow(page, "Tom").getByRole("checkbox").check();
  await page.getByRole("toolbar").getByRole("button", { name: "Stop" }).click();
  const confirm = page.getByRole("group").filter({ hasText: "Stop 2 campaign enrollments" });
  await expect(confirm).toBeVisible();
  // Another page pauses Tom after this confirmation opened.
  const tom = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaigns.followUp}&q=Tom`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === f.campaigns.followUp)?.id ?? "";
  expect((await f.harness.request("POST", `/api/enrollments/${tom}/controls`, { requestId: "elsewhere-tom", action: "pause" })).status).toBe(200);
  await confirm.getByRole("button", { name: "Stop" }).click();
  const result = page.getByRole("status").filter({ hasText: "Stopped 1 of 2 campaign enrollments." });
  await expect(result).toBeVisible();
  await expect(result).toContainText("Tom in Physio follow-up: This lead changed since you confirmed this");
  await expect(result).toBeFocused();
  expect(await statusIn(f, "Tom", f.campaigns.followUp)).toBe("paused");
});

test("by keyboard: select, open a confirmation, Escape returns focus to the control that opened it, and the result takes focus", async ({ page }) => {
  const f = await fakePeopleApp("people-keyboard");
  await at(page, f, `/leads?campaign=${f.campaigns.followUp}`);
  const box = leadRow(page, "Daniel Price").getByRole("checkbox");
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  const pause = page.getByRole("toolbar").getByRole("button", { name: "Pause" });
  await pause.focus();
  await page.keyboard.press("Enter");
  const confirmButton = page.getByRole("group").getByRole("button", { name: "Pause" });
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pause).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Paused 1 campaign enrollment." })).toBeFocused();
});

test("a reload while a bulk is on its way sends the stored press again, and it is applied once", async ({ page }) => {
  const f = await fakePeopleApp("people-reload");
  await at(page, f, `/leads?campaign=${f.campaigns.followUp}`);
  // The first send reaches the server, but its answer never arrives in this tab.
  let held = 0;
  await page.route("**/api/bulk", async (route) => {
    held++;
    if (held === 1) {
      await route.fetch();
      return new Promise(() => undefined);
    }
    return route.continue();
  });
  await leadRow(page, "Daniel Price").getByRole("checkbox").check();
  await page.getByRole("toolbar").getByRole("button", { name: "Pause" }).click();
  await page.getByRole("group").getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pausing…" })).toBeVisible();
  await expect.poll(() => statusIn(f, "Daniel Price", f.campaigns.followUp)).toBe("paused");
  // Another page resumes Daniel; the reload's send must answer from the first and pause nothing again.
  const daniel = (await f.harness.request<LeadSearchResult>("GET", `/api/leads?campaign=${f.campaigns.followUp}&q=Daniel`)).body.rows[0]?.enrollments.find((e) => e.campaign.id === f.campaigns.followUp)?.id ?? "";
  expect((await f.harness.request("POST", `/api/enrollments/${daniel}/controls`, { requestId: "elsewhere-daniel", action: "resume" })).status).toBe(200);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("outreach.bulk.")).length)).toBe(0);
  // The recovered press's answer is shown, from the server's first answer (review bot on 9daf7c0).
  await expect(page.getByRole("status").filter({ hasText: "Paused 1 campaign enrollment." })).toBeVisible();
  expect(held).toBeGreaterThanOrEqual(2);
  expect(await statusIn(f, "Daniel Price", f.campaigns.followUp)).not.toBe("paused");
});

test("a confirmation opened while another tab's bulk is on its way waits, says why, keeps focus, and sends nothing until that bulk is answered (verifier B1 on 4363270)", async ({ page, context }) => {
  const f = await fakePeopleApp("people-two-tabs");
  // Every send of a bulk is held until released (either tab may send a stored press).
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  const stopsSent: string[] = [];
  await context.route("**/api/bulk", async (route, request) => {
    const body = request.postData() ?? "";
    if (body.includes('"action":"stop"')) stopsSent.push(body);
    // Held before it reaches the server, until released.
    await held;
    await route.continue();
  });
  const b = await context.newPage();
  for (const p of [page, b]) await at(p, f, `/leads?campaign=${f.campaigns.followUp}`);

  // Tab B opens Stop's confirmation on Daniel.
  await leadRow(b, "Daniel Price").getByRole("checkbox").check();
  await b.getByRole("toolbar").getByRole("button", { name: "Stop" }).click();
  const stop = b.getByRole("group").getByRole("button", { name: "Stop" });
  await expect(stop).toBeFocused();

  // Tab A confirms Pause on Daniel; its answer is held.
  await leadRow(page, "Daniel Price").getByRole("checkbox").check();
  await page.getByRole("toolbar").getByRole("button", { name: "Pause" }).click();
  await page.getByRole("group").getByRole("button", { name: "Pause" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Pausing…" })).toBeVisible();
  // Tab B's confirmation stays, says why it waits, and Enter on its action sends nothing and keeps focus.
  await expect(b.getByRole("group")).toContainText("Another bulk change is on its way from this browser.");
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  await stop.focus();
  await b.keyboard.press("Enter");
  await expect(b.getByRole("group")).toBeVisible();
  await expect(stop).toBeFocused();
  expect(stopsSent).toEqual([]);

  // Once tab A's bulk is answered, tab B's Stop is sent from its own snapshot and judged by the server lead by lead.
  release();
  await expect(stop).not.toHaveAttribute("aria-disabled", "true");
  await stop.click();
  await expect(b.getByRole("status").filter({ hasText: "Daniel Price in Physio follow-up: This lead changed since you confirmed this" })).toBeVisible();
  // One Stop was pressed: every send of it (either tab may send a stored press) carries its one bulk id.
  expect(new Set(stopsSent.map((b) => (JSON.parse(b) as { bulkId: string }).bulkId)).size).toBe(1);
  await b.close();
});

test("on the person page, a lead in a bulk on its way waits for it: its controls are off and the row says why (verifier B1 on 4363270)", async ({ page, context }) => {
  const f = await fakePeopleApp("people-person-busy");
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await context.route("**/api/bulk", async (route) => {
    // Held before it reaches the server, until released.
    await held;
    await route.continue();
  });
  const person = await context.newPage();
  await at(person, f, `/leads/people/${f.person("Daniel Price")}`);
  const row = person.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Physio follow-up" });
  await expect(row.getByRole("button", { name: "Pause: Daniel Price in Physio follow-up" })).toBeEnabled();

  await at(page, f, `/leads?campaign=${f.campaigns.followUp}`);
  await leadRow(page, "Daniel Price").getByRole("checkbox").check();
  await page.getByRole("toolbar").getByRole("button", { name: "Pause" }).click();
  await page.getByRole("group").getByRole("button", { name: "Pause" }).click();

  await expect(row).toContainText("A bulk change from Leads that includes this campaign enrollment is on its way.");
  await expect(row.getByRole("button", { name: "Pause: Daniel Price in Physio follow-up" })).toBeDisabled();
  release();
  await expect(row.getByText("A bulk change from Leads")).toHaveCount(0);
  await person.close();
});

test("a note whose answer was lost is not confirmed, not refused; the next read shows it stored, once (verifier F1 on 4363270)", async ({ page }) => {
  const f = await fakePeopleApp("people-note-lost");
  let lost = 0;
  let reread: () => void = () => undefined;
  const rereadHeld = new Promise<void>((r) => (reread = r));
  let holdActivity = false;
  await page.route("**/api/people/*/notes", async (route) => {
    if (lost++ === 0) {
      await route.fetch();
      holdActivity = true;
      return route.abort("failed");
    }
    return route.continue();
  });
  // The read after the lost answer is held, so the page's interim sentence can be seen.
  await page.route("**/api/people/*/activity", async (route) => {
    if (holdActivity) await rereadHeld;
    return route.continue();
  });
  await at(page, f, `/leads/people/${f.person("Daniel Price")}`);
  const activity = page.getByRole("region", { name: "Activity" });
  await activity.getByLabel("A note about Daniel").fill("Asked for a follow-up in spring.");
  await activity.getByRole("button", { name: "Add note" }).click();
  await expect(activity.getByText("Not confirmed yet.")).toBeVisible();
  await expect(activity.getByText("The note wasn’t added.")).toHaveCount(0);
  reread();
  // The next read holds the note: the page says it was added, and shows it once.
  await expect(activity.getByRole("status").filter({ hasText: "Note added." })).toBeVisible();
  await expect(activity.getByText("Asked for a follow-up in spring.", { exact: true })).toHaveCount(1);
});

for (const how of ["by a link", "and reloads it"] as const) {
  test(`a bulk confirmed on Leads is sent and answered wherever the user goes: opening an affected person ${how} before the answer, its controls wait, then enable (review bot on 969799e)`, async ({ page }) => {
    const f = await fakePeopleApp(`people-orphan-${how === "by a link" ? "link" : "reload"}`);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/bulk", async (route) => {
      await held;
      await route.continue();
    });
    await at(page, f, `/leads?campaign=${f.campaigns.followUp}`);
    await leadRow(page, "Daniel Price").getByRole("checkbox").check();
    await page.getByRole("toolbar").getByRole("button", { name: "Pause" }).click();
    await page.getByRole("group").getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pausing…" })).toBeVisible();

    await leadRow(page, "Daniel Price").getByRole("link", { name: "Daniel Price" }).click();
    if (how === "and reloads it") await page.reload();
    const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: "Physio follow-up" });
    await expect(row).toContainText("A bulk change from Leads that includes this campaign enrollment is on its way.");

    release();
    // The answer arrives on the person page: the line goes, the row reads again, and its controls are offered.
    await expect(row.getByText("A bulk change from Leads")).toHaveCount(0);
    await expect(row.getByText("Paused", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Resume: Daniel Price in Physio follow-up" })).toBeEnabled();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("outreach.bulk.")).length)).toBe(0);
  });
}
