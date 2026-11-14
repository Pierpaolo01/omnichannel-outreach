import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Campaign, EnrollmentView } from "../src/shared/api.ts";
import { fakeProviderApp } from "./fake-provider.ts";
import { fixture } from "./support.ts";

/**
 * Ticket 13b, as the user uses it: SMS tracks and connections between tracks in the campaign
 * editor, Before launch on both channels, and SMS on the person record. The running app has no SMS
 * provider, so an SMS track is blocked by "no connected sender"; sends, bad numbers and replies run
 * on the app over the fake providers, which is not provider proof. All data is fictitious.
 */
const H = 3_600_000;
const DAY = 24 * H;

async function writeText(page: Page, n: number, copy: string) {
  await page.getByLabel(`Text ${n} message`).fill(copy);
}

test.describe("on the running app, with no SMS provider", () => {
  test("an SMS track can be written and connected, and launch is blocked only because no SMS number is connected", async ({ page, request }) => {
    const created = await request.post("/api/campaigns", { data: { name: "Texts, no provider", businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
    const id = ((await created.json()) as { campaign: Campaign }).campaign.id;
    await page.goto(`/campaigns/${id}`);
    await page.getByRole("button", { name: "SMS track" }).click();
    await writeText(page, 1, "Hi {{first_name|there}}, a quick text about evening booking at {{company}}.");
    await expect(page.getByText("No connected SMS number.")).toBeVisible();
    await expect(page.getByText("No SMS provider is set up, so no number can be connected yet.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Text 1 message")).toHaveValue(/a quick text about evening booking/);
    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("The SMS track has no connected sender number")).toBeVisible();
    await expect(page.getByText("Can’t project the load until the SMS track has a connected SMS number", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
  });
});

test.describe("a merge field with no fallback, named by every track and message that uses it (verifier B2)", () => {
  test("used in an email track and two SMS tracks: the blocker names each, and each action opens its own message", async ({ page, request }) => {
    const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
    const msg = (id: string, body: string, waitDays = 0, subject = "") => ({ id, waitDays, subject, body, threading: "new_subject", removed: false });
    const created = await request.post("/api/campaigns", { data: { name: "Fallbacks on two channels", businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
    const id = ((await created.json()) as { campaign: Campaign }).campaign.id;
    await request.put(`/api/campaigns/${id}/sequence`, {
      data: {
        timezone: "Europe/London",
        emailPool: [],
        smsPool: [],
        tracks: [
          { id: "email", channel: "email", window: week, start: { kind: "entry" }, steps: [msg("e1", "Hi {{first_name}}.", 0, "Hello")] },
          { id: "sms-a", channel: "sms", window: week, start: { kind: "entry" }, steps: [msg("a1", "Hi {{first_name}}, a text.")] },
          { id: "sms-b", channel: "sms", window: week, start: { kind: "after", trackId: "email", delayDays: 1 }, steps: [msg("b1", "Hi {{first_name|there}}."), msg("b2", "Still {{first_name}}?", 2)] },
        ],
      },
    });
    await page.goto(`/campaigns/${id}/before-launch`);
    await expect(page.getByText("First name has no fallback in Email 1 of the email track, Text 1 of SMS track 1 and Text 2 of SMS track 2")).toBeVisible();
    await page.getByRole("button", { name: "Add fallback: Text 2 of SMS track 2" }).click();
    await expect(page).toHaveURL(/track=sms-b&step=b2/);
    await expect(page.getByRole("heading", { name: "SMS track 2" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Merge fields in this text" })).toBeVisible();
    await page.goBack();
    await page.getByRole("button", { name: "Add fallback: Email 1 of the email track" }).click();
    await expect(page).toHaveURL(/track=email&step=e1/);
  });
});

test.describe("the Add track menu button (council on 10121d3, item 4)", () => {
  test("a click outside or focus leaving closes the menu, and its phone item adds nothing", async ({ page, request }) => {
    const created = await request.post("/api/campaigns", { data: { name: "Menu closes", businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
    const id = ((await created.json()) as { campaign: Campaign }).campaign.id;
    await page.goto(`/campaigns/${id}`);
    await page.getByRole("button", { name: "Email track" }).click();
    const button = page.getByRole("button", { name: "Add track" });
    await button.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("heading", { name: "Email track" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await button.click();
    // Disabled with aria-disabled, so it stays focusable and says why; a click on it still does nothing.
    await page.getByRole("menuitem", { name: /^Phone track/ }).click({ force: true });
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Phone track: / })).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

test.describe("on the app over the fake providers", () => {
  test("connections are saved through the one editor state: a track after another with a delay survives a reload, and a circle is refused", async ({ page }) => {
    const f = await fakeProviderApp("sms-connections");
    const id = await f.freshTwoChannelCampaign("Connections, Bristol");
    await page.goto(`${f.url}/campaigns/${id}`);
    await page.getByRole("button", { name: "Email track" }).click();
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "SMS track" }).click();
    await page.getByLabel("How this track starts").selectOption({ label: "After the email track" });
    await page.getByLabel("Days after that track finishes").fill("2");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.reload();
    await expect(page.getByText("after · 2 days")).toBeVisible();
    // The email track cannot now start after the SMS track: each would wait for the other.
    await page.getByRole("button", { name: /^Email track: / }).click();
    await page.getByLabel("How this track starts").selectOption({ label: "After the SMS track" });
    await expect(page.getByText("The SMS track starts after this one, so this one can’t start after it: each would wait for the other.")).toBeVisible();
    await expect(page.getByLabel("How this track starts")).toHaveValue("entry");
    // Removing the email track is refused while the SMS track waits for it.
    await page.getByRole("button", { name: "Remove this email track" }).click();
    await expect(page.getByText("The SMS track starts after this one. Change how it starts first.")).toBeVisible();
  });

  test("demonstration: tracks together and after a delay, a missing and a failed channel releasing the track after them, and a text reply stopping later email and texts", async ({ page }) => {
    test.setTimeout(180_000);
    const demo = await fakeProviderApp("sms-demonstration");
    const h = demo.harness;
    const id = await demo.freshTwoChannelCampaign("Dental clinics, Clifton");

    await test.step("write an email track and an SMS track that start together, and an email track a day after the texts", async () => {
      await page.goto(`${demo.url}/campaigns/${id}`);
      await page.getByRole("button", { name: "Email track" }).click();
      await page.getByLabel("Email 1 subject").fill("Evening bookings at {{company}}");
      await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}},\n\nOnline booking at {{company}} stops at 18:00.\n\nAlex");
      await page.getByRole("button", { name: "Add track" }).click();
      await page.getByRole("menuitem", { name: "SMS track" }).click();
      await writeText(page, 1, "Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week?");
      await page.getByRole("button", { name: "Add follow-up" }).click();
      await page.getByLabel("Days to wait before Text 2").fill("2");
      await writeText(page, 2, "Should I send the two-minute video for {{company}}? A yes is enough.");
      await page.getByRole("button", { name: "Add track" }).click();
      await page.getByRole("menuitem", { name: "Email track" }).click();
      await page.getByLabel("Email 1 subject").fill("One more idea for {{company}}");
      await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}},\n\nOne last note about evening booking.\n\nAlex");
      await page.getByLabel("How this track starts").selectOption({ label: "After the SMS track" });
      await page.getByLabel("Days after that track finishes").fill("1");
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
      await expect(page.getByText("together").first()).toBeVisible();
      await expect(page.getByText("after · 1 day")).toBeVisible();
    });

    await test.step("Before launch: copy by track and day for a lead with both channels and one with no mobile, the load on both channels, then launch", async () => {
      await page.getByRole("link", { name: "Launch…" }).click();
      await expect(page.getByText("Ready to launch.")).toBeVisible();
      await expect(page.getByText("Simulated SMS (not a provider)", { exact: false }).first()).toBeVisible();
      await page.getByLabel("Preview as lead").selectOption({ label: "Priya Shah" });
      await expect(page.getByText("Hi Priya, Alex from Northlight Bookings.", { exact: false })).toBeVisible();
      await page.getByLabel("Preview as lead").selectOption({ label: "Lena Ford" });
      await expect(page.getByText("Skipped: this lead has no mobile of their own to text.").first()).toBeVisible();
      await page.getByRole("button", { name: "Launch campaign" }).click();
      await expect(page.getByText(/^Launched .*\.$/)).toBeVisible();
    });

    await test.step("the days pass: Owen's number is reported invalid after his first text, and Priya texts back", async () => {
      // Owen's, not Ben's: this app's seeded campaign already marked Ben's number wrong, so here his SMS track is skipped.
      h.sms.invalidAfterSend.add("+447700900322");
      const start = h.clock;
      const mine = new Set(await h.store.engine.subjectsOf(id));
      const toPriya = () => h.sms.deliveryLog.find((d) => mine.has(d.subjectId) && d.destination === "+447700900311");
      // Texts go inside the window: wait for Priya's first text from this campaign, then she answers it.
      for (let i = 0; i < 5 * 24 && !toPriya(); i++) await h.advanceTo(h.clock + H);
      expect(h.sms.prospectTexts("+447700900311", "STOP", toPriya()?.sender ?? null)).toBe(true);
      await h.advanceTo(start + 9 * DAY);
    });

    const rows = (await h.request<{ rows: { id: string; name: string; enrollments: EnrollmentView[] }[] }>("GET", `/api/leads?campaign=${id}&limit=500`)).body.rows;
    const person = (name: string) => rows.find((r) => r.name === name)?.id ?? "";
    const activity = async (name: string) => {
      await page.goto(`${demo.url}/leads/people/${person(name)}`);
      await page.getByLabel("Show activity from").selectOption({ label: "Dental clinics, Clifton" });
    };

    await test.step("Priya's text reply stops every track in this campaign: no second email, no second text, no later email track", async () => {
      await activity("Priya Shah");
      await expect(page.getByText("Replied by text")).toBeVisible();
      await expect(page.getByText("Text 1 sent")).toBeVisible();
      await expect(page.getByText("Text 2 sent")).toHaveCount(0);
      await expect(page.getByText(/Email track 2/)).toHaveCount(0);
      await page.getByText("Show message").first().click();
      await expect(page.getByText("Hi Priya, Alex from Northlight Bookings.", { exact: false })).toBeVisible();
    });

    await test.step("Owen's bad number ends the SMS track, and the email track after it starts a day later and sends", async () => {
      await activity("Owen Hale");
      await expect(page.getByText("Text 1: bad number")).toBeVisible();
      await expect(page.getByText("It starts after the SMS track, which ended on a bad number.")).toBeVisible();
      await expect(page.getByText("Email track 2, in Dental clinics, Clifton")).toBeVisible();
    });

    await test.step("Lena has no mobile: her SMS track is skipped and the email track after it is released", async () => {
      await activity("Lena Ford");
      await expect(page.getByText("SMS track skipped")).toBeVisible();
      await expect(page.getByText("It starts after the SMS track, which was skipped for this lead.")).toBeVisible();
    });
  });
});

test.describe("the canvas is measured before it is painted (CI on 07bff24)", () => {
  // Before the canvas knew its width it drew the tracks side by side for one frame, which at a
  // phone's width crossed the panel; a slow machine's layout scan caught that frame. Every frame
  // painted is recorded here, so the check does not depend on timing.
  for (const width of [390, 1024] as const) {
    test(`at ${width}px no frame draws tracks side by side that do not fit`, async ({ page }) => {
      const f = await fakeProviderApp();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { canvasFrames: string[] }).canvasFrames = seen;
        const frame = () => {
          const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]');
          const area = canvas?.querySelector<HTMLElement>(".overflow-auto");
          if (canvas && area) seen.push(`${canvas.dataset["layout"] ?? "?"}:${area.scrollWidth > area.clientWidth + 1 ? "overflows" : "fits"}`);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.goto(`${f.url}/campaigns/${f.twoChannels}?track=sms`);
      await expect(page.getByRole("heading", { name: "SMS track" })).toBeVisible();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const frames = await page.evaluate(() => (window as unknown as { canvasFrames: string[] }).canvasFrames);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.filter((f) => f.endsWith("overflows"))).toEqual([]);
    });
  }
});
