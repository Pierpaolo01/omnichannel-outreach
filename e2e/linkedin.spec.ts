import { expect, test, type Page } from "@playwright/test";
import { csvOf, business, person } from "../test/support/export-builder.ts";
import { fakeLinkedinApp, LINKEDIN_TRACK, type FakeLinkedinApp } from "./fake-linkedin.ts";

/**
 * Ticket 24b's LinkedIn screens beyond the demonstration (linkedin-demonstration.spec.ts): the running application, where
 * no LinkedIn session is connected, blocks a LinkedIn track's launch in the existing blocker's words; and, on the simulated
 * provider, the record's LinkedIn states, a stop's confirmation that leaves the invite open (Q38), a withdrawal LinkedIn
 * never confirmed settled from Needs attention, and a skip naming the campaign that reached the person first (Q41).
 */

async function at(page: Page, f: FakeLinkedinApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.h.clock);
  await page.goto(f.url + path);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `${dir}/linkedin-${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("the running application has no LinkedIn session: the track's inspector and Before launch say so, and nothing offers to connect one", async ({ page, request }) => {
  const rows = csvOf({
    businesses: [business({ business_id: "bz-li-nosession-01", business_name: "Northgate Physio", city: "Leeds" })],
    people: [person({ person_id: "pl-nosession-1", business_id: "bz-li-nosession-01", full_name: "Rae Lund", email: "rae@northgatephysio.example", linkedin_url: "https://www.linkedin.com/in/fictional-rae-lund" })],
  });
  const created = await request.post("/api/campaigns", { data: { name: "LinkedIn with no session", defaultTimezone: "Europe/London", ...rows } });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { campaign: { id: string } }).campaign.id;
  const saved = await request.put(`/api/campaigns/${id}/sequence`, { data: { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [LINKEDIN_TRACK] } });
  expect(saved.status()).toBe(200);
  await page.goto(`/campaigns/${id}?track=li`);
  await expect(page.getByText("No connected LinkedIn session.")).toBeVisible();
  await expect(page.getByText("No LinkedIn session is connected, so LinkedIn tracks cannot launch.").first()).toBeVisible();
  await page.goto(`/campaigns/${id}/before-launch`);
  await expect(page.getByText("The LinkedIn track has no connected LinkedIn session")).toBeVisible();
  await expect(page.getByText("No LinkedIn session is connected, so LinkedIn tracks cannot launch. Remove the track to launch without it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
  await expect(page.getByText(/connect a session|connect LinkedIn/i)).toHaveCount(0);
  await shot(page, "08-no-session-blocker");
});

test("the record's LinkedIn states: waiting for acceptance with the day it ends, an invite left open by a stop, a skip naming the first campaign", async ({ page }) => {
  const f = await fakeLinkedinApp("running", "linkedin-record");

  await test.step("Nia waits for acceptance: the day the wait ends is a fact, and the invite went without its note (the allowance was used)", async () => {
    await at(page, f, `/leads/people/${await f.person("Nia Cole")}`);
    await expect(page.getByText("Next: the first message, waiting for them to accept the LinkedIn invite; the wait ends Thu 5 Nov.")).toBeVisible();
    await expect(page.getByText("The connection invite went without its note: the session’s note allowance for the month was used up.")).toBeVisible();
    // Stop's confirmation says the invite stays open on LinkedIn (Q38); cancelled here.
    await page.getByRole("button", { name: /^Stop: Nia Cole in/ }).click();
    await expect(page.getByText(/The LinkedIn invite already sent stays open on LinkedIn: stopping doesn’t withdraw it\./)).toBeVisible();
    await shot(page, "09-stop-confirmation-invite-open");
    await page.getByRole("group").getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("Ola, stopped after her invite went: the record says it is still open on LinkedIn", async () => {
    await at(page, f, `/leads/people/${await f.person("Ola Berg")}`);
    await expect(page.getByText("The connection invite sent from this campaign is still open on LinkedIn. The app asks LinkedIn to withdraw an invite only when the wait for acceptance runs out, so this one stays until they answer it or you withdraw it on LinkedIn.")).toBeVisible();
  });

  await test.step("Pat: connected, and skipped in the second campaign, which names the first; Kim has no member profile and the mark is refused with why", async () => {
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText(/^They accepted the invite on Tue 3 Nov\.$/)).toBeVisible();
    await expect(page.getByText(/^The LinkedIn track was skipped: .*campaign Clinics on LinkedIn/)).toBeVisible();
    await shot(page, "10-record-connected-and-skipped");
    await at(page, f, `/leads/people/${await f.person("Kim Hart")}`);
    await expect(page.getByText("The LinkedIn track was skipped: the LinkedIn address in the import isn’t a member profile (a company page, for one), so it can’t receive an invite.")).toBeVisible();
  });
});

test("a withdrawal LinkedIn never confirmed: Needs attention names it, the record takes one of the two answers, and an acceptance after the track ended", async ({ page }) => {
  const f = await fakeLinkedinApp("later", "linkedin-withdrawal");
  await at(page, f, "/");
  await expect(page.getByText("Check whether Nia Cole’s LinkedIn invite was withdrawn")).toBeVisible();
  await shot(page, "11-today-withdrawal-to-check");
  await page.getByRole("link", { name: "Open Nia Cole’s record" }).click();
  await expect(page.getByText(/LinkedIn hasn’t answered whether it did: check their profile on LinkedIn and say what you found\.$/)).toBeVisible();
  await page.getByRole("button", { name: /^It’s withdrawn: the LinkedIn invite to Nia Cole/ }).click();
  await expect(page.getByText(/^Mark the invite withdrawn\?/)).toBeVisible();
  await shot(page, "12-withdrawal-answer");
  await page.getByRole("group").getByRole("button", { name: "It’s withdrawn" }).click();
  await expect(page.getByText("Marked withdrawn. The invite no longer holds this person for this session.")).toBeVisible();
  await expect(page.getByText(/and the invite was withdrawn\.$/)).toBeVisible();
  await at(page, f, `/leads/people/${await f.person("Ivo Marsh")}`);
  await expect(page.getByText(/^Their acceptance of the invite was recorded after this track had ended; LinkedIn shows they had accepted it by /)).toBeVisible();
  await shot(page, "13-accepted-after-the-track-ended");
});

test("a LinkedIn step a session has no allowance for, set to zero or never set, and one whose allowance is used up today: on the record and on Today", async ({ page }) => {
  for (const [name, allowances] of [["zero", { invitesPerDay: 0, messagesPerDay: 0, notesPerMonth: 0 }], ["unset", null]] as const) {
    const f = await fakeLinkedinApp("running", `linkedin-allowance-${name}`, allowances);
    await at(page, f, `/leads/people/${await f.person("Pat Oneil")}`);
    await expect(page.getByText(/Next: the connection invite, waiting: no LinkedIn session it may use has an allowance for this kind of step\./).first()).toBeVisible();
    await at(page, f, "/");
    await expect(page.getByText("4 leads in Clinics on LinkedIn have LinkedIn steps that can’t go yet")).toBeVisible();
    await expect(page.getByText(/is full for the day/)).toHaveCount(0);
    if (name === "zero") await shot(page, "14-today-no-allowance");
  }
  const used = await fakeLinkedinApp("launched", "linkedin-allowance-used", { invitesPerDay: 1, messagesPerDay: 20, notesPerMonth: 0 });
  await at(page, used, "/");
  await expect(page.getByText(/leads in Clinics on LinkedIn are waiting for sending capacity/)).toBeVisible();
  await expect(page.getByText(/is full for the day\. The first resets/)).toBeVisible();
});
