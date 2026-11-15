import { expect, test, type Page } from "@playwright/test";
import type { CampaignDetail } from "../src/shared/api.ts";
import { fakeMeasuresApp, type FakeMeasuresApp } from "./fake-provider.ts";
import { respond, serverError } from "./mocks.ts";

/**
 * Ticket 22's demonstration (recorded with RECORD_DEMO=1), on the fake providers with fictitious data: the campaign's
 * figures change after sends, a refusal and a bounce, a reply, call outcomes, a callback completed and a pause, each
 * beside the campaign activity that caused it. One story on one app; the clock moves by the harness.
 */

const H = 3_600_000;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_500);
};

async function at(page: Page, f: FakeMeasuresApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.world.h.clock);
  await page.goto(f.url + path);
}

const panel = (page: Page) => page.getByRole("region", { name: "Outreach so far" });
const strip = (page: Page) => page.getByRole("list", { name: "Leads in each status group" });
const row = (page: Page, label: string) => panel(page).locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");

test("the figures change after sends, a refusal and a bounce, a reply, call outcomes, a callback completed and a pause", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeMeasuresApp("early", "measures-demonstration");
  const { world } = f;
  const campaign = `/campaigns/${world.campaignId}`;
  const person = async (name: string) => (await world.h.request<{ rows: { id: string; name: string }[] }>("GET", "/api/leads?limit=500")).body.rows.find((r) => r.name === name)?.id ?? "";

  await test.step("Monday 07:00, just launched: four leads waiting on their calls, nothing sent or called before 09:00, and neither rate a number", async () => {
    await at(page, f, campaign);
    await expect(strip(page)).toContainText("4waiting on you");
    await expect(row(page, "Email")).toHaveText("None sent yet");
    await expect(row(page, "Calls")).toHaveText("None made yet");
    await expect(panel(page)).toContainText("No email or text has been sent yet");
    await linger(page);
  });

  await test.step("09:15: the provider sent and refused emails, one bounced, and a text was reported invalid", async () => {
    await world.h.advanceTo(world.h.clock + 2 * H + 15 * 60_000);
    await at(page, f, campaign);
    await expect(row(page, "Email")).toHaveText("3 sent · 2 failed or bounced · 0 leads replied");
    await expect(row(page, "SMS")).toHaveText("4 sent · 1 failed or bounced · 0 leads replied");
    await linger(page);
    await at(page, f, `/leads/people/${await person("Nia Cole")}`);
    await expect(page.getByText(/bounced/i).first()).toBeVisible();
    await linger(page);
  });

  await test.step("Pat replies by email: one reply, handed to you, and the reply rate", async () => {
    world.h.fake.prospectReplies("pat@harbour.example");
    await world.h.advanceTo(world.h.clock + 10 * 60_000);
    await at(page, f, `/leads/people/${await person("Pat Oneil")}`);
    await expect(page.getByText("Replied, automation stopped").first()).toBeVisible();
    await linger(page);
    await at(page, f, campaign);
    await expect(row(page, "Email")).toHaveText("3 sent · 2 failed or bounced · 1 lead replied");
    await expect(strip(page)).toContainText("1handed to you");
    await expect(panel(page)).toContainText("25% 1 of the 4 leads you emailed or texted replied");
    await linger(page);
  });

  await test.step("calls: a gatekeeper and a callback asked for", async () => {
    expect(await world.log("Nia Cole", "gatekeeper")).toBe(200);
    expect(await world.log("Ivo Marsh", "callback_requested", { callbackAt: new Date(world.h.clock + 3 * H).toISOString() })).toBe(200);
    await at(page, f, campaign);
    await expect(row(page, "Calls")).toHaveText("2 made · 1 connected · 0 interested · 0 declined · 1 callback pending");
    await expect(panel(page)).toContainText("50% 1 of 2 calls reached the prospect for a conversation");
    await linger(page);
  });

  await test.step("Sam is interested and the callback is completed at its time", async () => {
    expect(await world.log("Sam Reed", "interested")).toBe(200);
    await world.h.advanceTo(world.h.clock + 3 * H + 60_000);
    expect(await world.log("Ivo Marsh", "not_interested", { declinedPath: "continue" })).toBe(200);
    await at(page, f, `/leads/people/${await person("Ivo Marsh")}`);
    await expect(page.getByText(/not interested/i).first()).toBeVisible();
    await linger(page);
    await at(page, f, campaign);
    await expect(row(page, "Calls")).toHaveText("4 made · 3 connected · 1 interested · 1 declined · 0 callbacks pending");
    await expect(strip(page)).toContainText("2handed to you");
    await linger(page);
  });

  await test.step("a lead paused, then the campaign: the paused lead moves group, the campaign pause moves none", async () => {
    const ivo = (await world.h.request<{ rows: { name: string; enrollments: { id: string }[] }[] }>("GET", "/api/leads?limit=500")).body.rows.find((r) => r.name === "Ivo Marsh")?.enrollments[0]?.id ?? "";
    expect((await world.h.request("POST", `/api/enrollments/${ivo}/controls`, { requestId: "demo-pause-ivo", action: "pause" })).status).toBe(200);
    await at(page, f, campaign);
    await expect(strip(page)).toContainText("1paused");
    await linger(page);
    await page.getByRole("button", { name: "Pause campaign" }).first().click();
    await page.getByRole("group").getByRole("button", { name: "Pause campaign" }).click();
    await expect(page.getByRole("heading", { name: /^Paused since/ })).toBeVisible();
    // The banner says the groups as the strip did, from the same read (council on 384630e, item 6).
    await expect(page.getByRole("region", { name: /^Paused since/ }).getByRole("list", { name: "Leads in each status group" })).toContainText("1paused");
    await expect(row(page, "Calls")).toHaveText("4 made · 3 connected · 1 interested · 1 declined · 0 callbacks pending");
    await linger(page);
  });
});

test("the Paused banner's counts and the figures come from one read, even with replies between a delayed answer and the next read (verifier B1)", async ({ page }) => {
  const f = await fakeMeasuresApp("paused", "measures-one-read");
  const { world } = f;
  const detail = `${f.url}/api/campaigns/${world.campaignId}`;
  let released = false;
  // The campaign's read answers from the server now, and reaches the page only after two more leads have replied.
  await page.route(detail, async (route) => {
    const response = await route.fetch();
    if (!released) {
      released = true;
      world.h.fake.prospectReplies("ivo@harbour.example");
      world.h.sms.prospectTexts("+447700900102");
      await world.h.advanceTo(world.h.clock + 5 * 60_000);
    }
    await respond(route, (await response.json()) as CampaignDetail);
  });
  await page.clock.setFixedTime(world.h.clock);
  await page.goto(`${f.url}/campaigns/${world.campaignId}`);
  const banner = page.getByRole("region", { name: /^Paused since/ });
  await expect(banner).toBeVisible();
  await expect(row(page, "Email")).toBeVisible();
  const handed = parseInt((await banner.getByRole("listitem").filter({ hasText: "handed to you" }).textContent()) ?? "", 10);
  const replied = async (label: string) => Number(/(\d+) leads? replied/.exec((await row(page, label).textContent()) ?? "")?.[1] ?? "NaN");
  // Nobody in this campaign was interested on a call, so every lead handed to you replied.
  expect(handed).toBe((await replied("Email")) + (await replied("SMS")));
});

test("figures whose refreshes keep failing say they may be out of date, with when they were read, and Try again (verifier F1)", async ({ page }) => {
  const f = await fakeMeasuresApp("running", "measures-stale");
  const detail = `${f.url}/api/campaigns/${f.world.campaignId}`;
  await at(page, f, `/campaigns/${f.world.campaignId}`);
  await expect(row(page, "Calls")).toContainText("1 callback pending");
  let failing = true;
  await page.route(detail, (route) => (failing ? serverError(route) : route.continue()));
  const notice = page.getByRole("status").filter({ hasText: "This may be out of date" });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      return notice.isVisible();
    }, { timeout: 30_000 })
    .toBe(true);
  await expect(notice).toContainText(/so it shows the campaign as of \d\d:\d\d/);
  // The figures stay, marked; Try again reads again and the notice goes once a read succeeds.
  await expect(row(page, "Calls")).toContainText("1 callback pending");
  failing = false;
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toBeHidden();
});
