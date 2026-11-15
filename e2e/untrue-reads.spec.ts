import { expect, test } from "@playwright/test";
import type { CampaignDefinition } from "../src/domain/sequence/definition.ts";
import type { Campaign, CompanyRecord, LeadSearchResult, RecordControls } from "../src/shared/api.ts";
import { acceptanceWorld, H, INBOX, NUMBERS, type AcceptanceWorld } from "./acceptance-world.ts";
import { business, csvOf } from "../test/support/export-builder.ts";

/**
 * Ticket 23's defect 2 on the company-lead page (ADR 0003 "Reads that say when"): a company lead's campaign row says when
 * its next email goes as the engine decides it, from the server's read. Every name and address is fictitious.
 */

test.use({ timezoneId: "Europe/London", actionTimeout: 15_000 });

const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
const TUESDAY_TO_FRIDAY = [2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [INBOX],
  smsPool: [...NUMBERS],
  callScript: "",
  tracks: [{ id: "email", channel: "email", branch: "main", window: TUESDAY_TO_FRIDAY, start: { kind: "entry" }, removed: false, steps: [{ id: "s1", waitDays: 0, subject: "Spring hours", body: "A note on spring hours.", threading: "new_subject", removed: false }] }],
};
// A company with no named decision maker: a company lead, emailed at its shared inbox.
const rows = csvOf({ businesses: [business({ business_id: "bz-fern", business_name: "Fern Row Dental", city: "Bristol", phone_e164: "+441174960404", general_emails: "hello@fernrow.example" })], people: [] });

let w: AcceptanceWorld | null = null;
test.afterEach(async () => {
  await w?.close();
  w = null;
});

test("a company lead launched on Monday with a Tuesday-to-Friday window: its row says Tuesday 09:00, the instant the engine sends", async ({ page }) => {
  w = await acceptanceWorld({ start: MONDAY_10, smsConnected: true });
  const h = w.harness;
  const id = (await h.request<{ campaign: Campaign }>("POST", "/api/campaigns", { name: "Spring follow-up, Bristol", defaultTimezone: "Europe/London", ...rows })).body.campaign.id;
  await h.defineSequence(id, definition);
  expect((await h.launch(id)).status).toBe(200);
  await h.advanceTo(MONDAY_10 + H);
  const company = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}`)).body.rows.find((r) => r.kind === "company")?.id ?? "";
  // The server's read says the engine's instant.
  const read = (await h.request<CompanyRecord & RecordControls>("GET", `/api/companies/${company}`)).body;
  expect(read.leads[0]?.tracks[0]?.nextStep?.when).toEqual({ kind: "at", at: "2026-11-10T09:00:00.000Z" });
  // And the page says it.
  await page.clock.setFixedTime(h.clock);
  await page.goto(`${w.url}/leads/companies/${company}`);
  const row = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").first();
  await expect(row).toContainText("due Tue 10 Nov at 09:00");
  await expect(row).not.toContainText("Mon 9 Nov at 10:00");
  // What the engine does: nothing on Monday; the email goes when Tuesday's window opens.
  await h.advanceTo(Date.parse("2026-11-10T12:00:00Z"));
  expect(h.fake.deliveryLog.map((d) => d.at)).toEqual([Date.parse("2026-11-10T09:00:00Z")]);
});
