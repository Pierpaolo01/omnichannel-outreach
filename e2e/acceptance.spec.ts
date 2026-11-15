import { expect, test, type Page } from "@playwright/test";
import type { ActivityView, CampaignMeasures, LeadSearchResult, NeedsAttention, SequenceView } from "../src/shared/api.ts";
import { acceptanceWorld, DAY, EXPECTED_IMPORT, exportFiles, H, MIN, NUMBERS, OWN_EMAIL, OWN_MOBILE, type AcceptanceWorld } from "./acceptance-world.ts";

/**
 * Ticket 23: the spec's acceptance story (issue 10, "Acceptance story (required)"), its nine steps in order, through the
 * screens a user uses, on one application and one database. Each step asserts what the screen shows and what the
 * server's reads return. The providers are fakes (see e2e/acceptance-world.ts): this proves the application's side
 * only, never delivery by Instantly or an SMS provider. EVIDENCE_DIR=<dir> saves a light-mode screenshot per step;
 * RECORD_DEMO=1 records the run. Every name, address and number is fictitious.
 */

test.use({ timezoneId: "Europe/London", actionTimeout: 15_000, screenshot: "only-on-failure" });
test.describe.configure({ mode: "serial" });

const CAMPAIGN = "Clinics, Bristol";
const OTHER = "Spring follow-up, Bristol";

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(1_800);
};

/** One light-mode screenshot of the page as it is, when EVIDENCE_DIR is set. */
async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  await page.emulateMedia({ colorScheme: "light" });
  // A theme switch starts colour transitions; a cancelled one rejects, which is as good as finished.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage });
}

/** Opens a page with the browser's clock at the application's instant. */
async function at(page: Page, w: AcceptanceWorld, route: string): Promise<void> {
  await page.clock.setFixedTime(w.harness.clock);
  await page.goto(w.url + route);
}

const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Saved" }).first()).toBeVisible();

let w: AcceptanceWorld;
let campaignId = "";
let otherId = "";

test.beforeAll(async () => {
  w = await acceptanceWorld();
});
test.afterAll(async () => {
  await w.close();
});

test("the acceptance story: import, build, test run, launch, calls, replies, failures, pause and resume, and the end", async ({ page }) => {
  test.setTimeout(600_000);
  const files = exportFiles();

  await test.step("1. Import: decision makers and a company lead appear, and the duplicate rows are merged", async () => {
    await at(page, w, "/campaigns");
    await page.getByRole("link", { name: "New campaign" }).click();
    await page.getByLabel("Campaign name").fill(CAMPAIGN);
    await page.getByLabel("People file", { exact: true }).setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: files.people });
    await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses.csv", mimeType: "text/csv", buffer: files.businesses });
    await expect(page.getByText(`people.csv. ${EXPECTED_IMPORT.peopleRows} people`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Create campaign and import" }).click();
    await expect(page.getByRole("heading", { name: `Imported into ${CAMPAIGN}` })).toBeVisible();
    const leads = EXPECTED_IMPORT.decisionMakers + EXPECTED_IMPORT.companyLeads;
    await expect(page.getByText(`${leads} new leads: ${EXPECTED_IMPORT.decisionMakers} decision makers and ${EXPECTED_IMPORT.companyLeads} company lead.`)).toBeVisible();
    await shot(page, "01-import");
    await linger(page);
    // The server's read: one Ada Reyes, one Harbour Lane Physio, though each was listed twice.
    const ada = (await w.harness.request<LeadSearchResult>("GET", "/api/leads?q=Ada%20Reyes")).body.rows.filter((r) => r.name === "Ada Reyes");
    expect(ada).toHaveLength(1);
    const harbour = (await w.harness.request<LeadSearchResult>("GET", "/api/leads?q=Harbour%20Lane&limit=500")).body.rows;
    expect(new Set(harbour.map((r) => (r.kind === "person" ? r.company.id : r.id))).size).toBe(1);
    campaignId = ada[0]?.enrollments[0]?.campaign.id ?? "";
    expect(campaignId).not.toBe("");

    // The same people go into a second campaign, with no exclusions.
    await at(page, w, "/campaigns/new");
    await page.getByLabel("Campaign name").fill(OTHER);
    await page.getByLabel("People file", { exact: true }).setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: files.people });
    await page.getByLabel("Businesses file", { exact: true }).setInputFiles({ name: "businesses.csv", mimeType: "text/csv", buffer: files.businesses });
    await page.getByRole("button", { name: "Create campaign and import" }).click();
    await expect(page.getByRole("heading", { name: `Imported into ${OTHER}` })).toBeVisible();
    await page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Leads", exact: true }).click();
    await page.getByLabel("Search leads").fill("Ada");
    const row = page.getByRole("row", { name: /Ada Reyes/ });
    await expect(row).toContainText(CAMPAIGN);
    await expect(row).toContainText(OTHER);
    await shot(page, "01-search-two-campaigns");
    otherId = (await w.harness.request<LeadSearchResult>("GET", "/api/leads?q=Ada%20Reyes")).body.rows[0]?.enrollments.find((e) => e.campaign.id !== campaignId)?.campaign.id ?? "";
    expect(otherId).not.toBe("");
  });

  await test.step("2. Build: the canvas, the preview for real leads, and exactly three launch blockers", async () => {
    await at(page, w, `/campaigns/${campaignId}`);
    // Email track: a first email using {{first_name}} with no fallback (the company lead lacks it), a follow-up left empty.
    await page.getByRole("button", { name: "Email track" }).click();
    await page.getByLabel("Email 1 subject").fill("Evening bookings at {{company}}");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name}},\n\nOnline booking at {{company}} stops at 18:00, when people with desk jobs go looking.\n\nWorth a 15-minute call?\n\nAlex");
    // The campaign's default zone, for leads with no location of their own (it starts as this machine's).
    await page.getByLabel("From the lead’s or company’s location, otherwise").selectOption("Europe/London");
    await page.getByRole("button", { name: "Add follow-up" }).click();
    await page.getByLabel("Days to wait before Email 2").fill("2");
    await saved(page);
    // SMS track, together with the email track.
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "SMS track" }).click();
    await page.getByLabel("Text 1 message").fill("Hi {{first_name|there}}, Alex from Northlight Bookings. I emailed about evening booking at {{company}}. OK if I call this week?");
    await page.getByRole("button", { name: "Add follow-up" }).click();
    await page.getByLabel("Days to wait before Text 2").fill("2");
    await page.getByLabel("Text 2 message").fill("{{first_name|Hi}}, should I send the two-minute video for {{company}}? A yes is enough.");
    await saved(page);
    // Phone track, together, declined path win back once the branch exists.
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "Phone track" }).click();
    await page.getByLabel("Call script").fill("Ask for the clinic director.\nAsk how patients book after 18:00.\nIf interested, offer a 20-minute walkthrough.");
    await saved(page);
    // An email the day after the phone track ends.
    await page.getByRole("button", { name: "Add track" }).click();
    await page.getByRole("menuitem", { name: "Email track" }).click();
    await page.getByLabel("Email 1 subject").fill("Following up on my call");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}},\n\nFollowing up on my call: here is the two-minute video for {{company}}.\n\nAlex");
    await page.getByLabel("How this track starts").selectOption({ label: "After the phone track" });
    await page.getByLabel("Days after that track finishes").fill("1");
    await saved(page);
    // The win-back branch: one email; then the phone track's declined path is win back.
    await page.getByRole("button", { name: "Add a win-back email track" }).click();
    await page.getByLabel("Email 1 subject").fill("One more idea for {{company}}");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}},\n\nUnderstood, and thanks for your time. One idea I’ll leave with you: a booking link for evenings only.\n\nAlex");
    await saved(page);
    await page.getByRole("button", { name: /^Phone track: / }).click();
    await page.getByRole("radiogroup", { name: "If they decline on the call" }).getByRole("radio", { name: /^Win back/ }).check();
    await saved(page);
    await shot(page, "02-canvas");
    await linger(page);

    const sequence = (await w.harness.request<SequenceView>("GET", `/api/campaigns/${campaignId}/sequence`)).body;
    expect(sequence.definition.tracks.filter((t) => !t.removed).map((t) => [t.channel, t.branch, t.start.kind])).toEqual([
      ["email", "main", "entry"],
      ["sms", "main", "entry"],
      ["call", "main", "entry"],
      ["email", "main", "after"],
      ["email", "win_back", "entry"],
    ]);

    await page.getByRole("link", { name: /Before launch/ }).click();
    await expect(page.getByText("3 things block launch.")).toBeVisible();
    const blocks = page.getByRole("region", { name: "Blocks launch" });
    await expect(blocks.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeDisabled();
    // The preview renders each step for a real imported lead, switchable between leads.
    await page.getByLabel("Preview as lead").selectOption({ label: "Ada Reyes" });
    await expect(page.getByText("Online booking at Harbour Lane Physio stops at 18:00", { exact: false }).first()).toBeVisible();
    await shot(page, "02-three-blockers");
    await linger(page);
    const view = (await w.harness.request<SequenceView>("GET", `/api/campaigns/${campaignId}/sequence`)).body;
    expect(view.launch.blockers.map((b) => b.kind).sort()).toEqual(["empty_copy", "missing_merge_field", "no_sender"]);

    // Each blocker is fixed where it is named; the SMS numbers are connected at the provider (outside the application).
    await page.getByRole("button", { name: "Write it" }).click();
    await page.getByLabel("Email 2 copy").fill("Hi {{first_name|there}},\n\nA quick follow-up: happy to send a two-minute video of evening booking for {{company}}.\n\nAlex");
    await saved(page);
    await at(page, w, `/campaigns/${campaignId}/before-launch`);
    await page.getByRole("button", { name: "Add fallback" }).click();
    await page.getByLabel("Fallback for first name").fill("there");
    await saved(page);
    for (const n of NUMBERS) {
      const number = w.harness.sms.numbers.get(n);
      if (number) number.healthy = true;
    }
    await w.harness.tick();
    await at(page, w, `/campaigns/${campaignId}/before-launch`);
    await expect(page.getByText("Ready to launch.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeEnabled();
    expect((await w.harness.request<SequenceView>("GET", `/api/campaigns/${campaignId}/sequence`)).body.launch.blockers).toEqual([]);
    await shot(page, "02-ready-to-launch");
  });

  /** What reached the user's own test contacts, from the fake providers' delivery logs: the test's record, not the app's. */
  const toOwn = (destination: string) => [...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog].filter((d) => d.destination === destination).map((d) => d.stepId);
  const stepIds = async () => {
    const def = (await w.harness.request<SequenceView>("GET", `/api/campaigns/${campaignId}/sequence`)).body.definition;
    const ids = (channel: string, branch = "main") => def.tracks.filter((t) => t.channel === channel && t.branch === branch).flatMap((t) => t.steps.map((s) => s.id));
    return { email: ids("email"), sms: ids("sms"), winBack: ids("email", "win_back") };
  };

  await test.step("3. Test run: every step to the user's own contacts, a test call whose declined path takes win back, and a reply that stops a repeat", async () => {
    const tab = `/campaigns/${campaignId}/test-run`;
    await at(page, w, tab);
    await page.getByLabel("Your email").fill(OWN_EMAIL);
    await page.getByLabel("Your mobile, for texts and the test call").fill(OWN_MOBILE);
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.getByLabel("Copy written for").selectOption({ label: "Ada Reyes" });
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await w.harness.advanceTo(w.harness.clock + 4 * MIN);
    const ids = await stepIds();
    // Every email and text step, in order, about a minute apart; nothing to a lead.
    const email = ids.email.filter((id) => toOwn(OWN_EMAIL).includes(id));
    expect(toOwn(OWN_EMAIL).slice(0, 2)).toEqual(ids.email.slice(0, 2));
    expect(toOwn(OWN_MOBILE)).toEqual(ids.sms);
    expect(email.length).toBeGreaterThanOrEqual(2);
    expect([...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog].every((d) => d.subjectId.startsWith("test-"))).toBe(true);
    await at(page, w, tab);
    await expect(page.getByText("On your Calls list")).toBeVisible();
    await shot(page, "03-test-sends-and-call");
    await linger(page);

    // The test call: Not interested, with the canvas's win-back path preselected.
    await at(page, w, "/calls");
    await expect(page.getByText(/To your test mobile/).first()).toBeVisible();
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "Not interested", exact: true }).click();
    await expect(page.getByRole("group", { name: /What happens next for/ }).getByRole("radio", { name: /Move to the win-back messages/ })).toBeChecked();
    await shot(page, "03-test-call-declined", false);
    await page.getByRole("button", { name: /^Log/ }).first().click();
    await w.harness.advanceTo(w.harness.clock + 3 * MIN);
    expect(toOwn(OWN_EMAIL).filter((id) => ids.winBack.includes(id))).toEqual(ids.winBack);
    await at(page, w, tab);
    await expect(page.getByRole("heading", { name: /^Finished at \d\d:\d\d$/ })).toBeVisible();
    await expect(page.getByText("Skipped: the test moved to the win-back branch")).toBeVisible();
    await shot(page, "03-test-finished-win-back");
    await linger(page);

    // Run again; a reply from the test email stops it.
    const before = toOwn(OWN_EMAIL).length;
    await page.getByRole("button", { name: "Run test again" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await w.harness.advanceTo(w.harness.clock + 30_000);
    expect(toOwn(OWN_EMAIL).length).toBe(before + 1);
    expect(w.harness.fake.prospectReplies(OWN_EMAIL)).toBe(true);
    await w.harness.advanceTo(w.harness.clock + 5 * MIN);
    await at(page, w, tab);
    await expect(page.getByRole("heading", { name: /Stopped by your reply/ })).toBeVisible();
    expect(toOwn(OWN_EMAIL).length).toBe(before + 1);
    await shot(page, "03-test-stopped-by-reply");
    await linger(page);
  });

  /** The test's own ledger: every call outcome it logged and every reply it made, in this campaign. */
  const logged: { name: string | null; outcome: string; test: boolean }[] = [{ name: null, outcome: "not_interested", test: true }];
  const replied = { email: ["Ada Reyes"], sms: ["Ben Ortiz"], testEmail: 1 };
  /** What the test expects each lead's status to end as, written down from the story, not read from the application. */
  const ENDS: Record<string, string> = {
    "Ada Reyes": "replied",
    "Ben Ortiz": "replied",
    "Gia Moss": "interested_on_call",
    "Hal Price": "declined_on_call",
    "Cara Lin": "sequence_finished_no_response",
    "Dev Shah": "sequence_finished_no_response",
    "Eve Hart": "sequence_finished_no_response",
    "Finn Wood": "sequence_finished_no_response",
    "Ivy Cole": "sequence_finished_no_response",
    "Jon Lake": "sequence_finished_no_response",
    "Kim Rowe": "sequence_finished_no_response",
    "Juniper Pilates Studio": "sequence_finished_no_response",
  };
  const NAMES = Object.keys(ENDS);
  const ids = new Map<string, string>();
  const idOf = (name: string) => ids.get(name) ?? "";
  /** Deliveries the fake providers made to this campaign's leads (their own logs), by lead name. */
  const deliveredTo = (name: string, channel: "email" | "sms" | "both" = "both") =>
    [...(channel === "sms" ? [] : w.harness.fake.deliveryLog), ...(channel === "email" ? [] : w.harness.sms.deliveryLog)].filter((d) => d.subjectId === idOf(name));
  const campaignDeliveries = () => [...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog].filter((d) => NAMES.some((n) => idOf(n) === d.subjectId));
  const activity = async (name: string) => (await w.harness.request<ActivityView>("GET", `/api/people/${await w.record(name)}/activity`)).body.entries.filter((e) => e.campaign.id === campaignId);

  await test.step("4. Launch: emails and texts go out on schedule, and each shows sent or failed on the person timeline", async () => {
    // Cara's address hard-bounces; Dev's mobile is reported invalid after his text.
    w.harness.fake.bouncing.add("cara@harbourlane.example");
    w.harness.sms.invalidAfterSend.add("+447700900306");
    await at(page, w, `/campaigns/${campaignId}/before-launch`);
    // The test ran after the last edit, so no warning about it.
    await expect(page.getByText("No test run since your last edit")).toHaveCount(0);
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched /).first()).toBeVisible();
    await shot(page, "04-launched");
    for (const name of NAMES) ids.set(name, await w.lead(name, campaignId));
    await w.harness.advanceTo(w.harness.clock + 40 * MIN);
    await linger(page);

    // Every lead's first email went, once; every lead with a mobile got its first text, once; the company lead got none.
    for (const name of NAMES) {
      expect(deliveredTo(name, "email").map((d) => d.stepId)).toHaveLength(1);
      expect(deliveredTo(name, "sms")).toHaveLength(name === "Juniper Pilates Studio" ? 0 : 1);
    }
    // The pacing: one send a minute from the inbox, never two at once.
    const emailTimes = w.harness.fake.deliveryLog.filter((d) => NAMES.some((n) => idOf(n) === d.subjectId)).map((d) => d.at).sort((a, b) => a - b);
    for (let i = 1; i < emailTimes.length; i++) expect((emailTimes[i] ?? 0) - (emailTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN);

    await at(page, w, `/leads/people/${await w.record("Ada Reyes")}`);
    const timeline = page.getByRole("region", { name: "Activity" });
    await expect(timeline.getByText("Email 1 sent")).toBeVisible();
    await expect(timeline.getByText("Text 1 sent")).toBeVisible();
    // No delivered state: Instantly reports none for email (ADR 0002), and no SMS provider reports one yet. Not met; see the record.
    await expect(timeline.getByText(/delivered/i)).toHaveCount(0);
    await shot(page, "04-timeline-sent");
    expect((await activity("Ada Reyes")).map((e) => e.kind).sort()).toEqual(["sent", "sent"]);

    await at(page, w, `/leads/people/${await w.record("Cara Lin")}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Email 1 bounced")).toBeVisible();
    await expect(page.getByText("Email, marked wrong")).toBeVisible();
    await shot(page, "04-timeline-bounced");
    expect((await activity("Cara Lin")).map((e) => e.kind)).toContain("bounced");
    await at(page, w, `/leads/people/${await w.record("Dev Shah")}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Text 1: bad number")).toBeVisible();
    await expect(page.getByText("+44 7700 900306 was reported invalid and is marked wrong. Nothing more is texted to it.")).toBeVisible();
    await expect(page.getByText("Mobile, marked wrong")).toBeVisible();
    await shot(page, "04-timeline-text-failed");
  });

  /** The outcome the test logs for each call, as the focus queue opens it. */
  const PLAN: Record<string, { outcome: string; path?: RegExp; redial?: boolean; callback?: string; note?: string }> = {
    "Ada Reyes": { outcome: "Left voicemail" },
    "Ben Ortiz": { outcome: "No answer" },
    "Cara Lin": { outcome: "Wrong number" },
    "Dev Shah": { outcome: "Didn’t reach them", note: "Front desk says the owner decides; try mornings." },
    "Eve Hart": { outcome: "No answer" },
    "Finn Wood": { outcome: "Callback requested", callback: "15:30" },
    "Gia Moss": { outcome: "Interested" },
    "Hal Price": { outcome: "Not interested", path: /Stop all outreach in this campaign/ },
    "Ivy Cole": { outcome: "Not interested", path: /Keep the email and SMS steps going/ },
    "Jon Lake": { outcome: "Not interested", path: /Move to the win-back messages/ },
    "Kim Rowe": { outcome: "No answer", redial: true },
  };
  const API_OUTCOME: Record<string, string> = { "Left voicemail": "voicemail", "No answer": "no_answer", "Wrong number": "wrong_number", "Didn’t reach them": "gatekeeper", "Callback requested": "callback_requested", Interested: "interested", "Not interested": "not_interested" };

  await test.step("5. Calls: Today and the focus queue; redial, callback, interested and every declined path", async () => {
    await at(page, w, "/");
    const callers = Object.keys(PLAN);
    await expect(page.getByText(`${callers.length} calls are ready now.`)).toBeVisible();
    await shot(page, "05-today");
    await linger(page);
    expect((await w.calls()).readyNow).toHaveLength(callers.length);
    // The company lead has no number: its phone track was skipped, and nothing of it is on the list.
    expect((await w.calls()).readyNow.some((c) => c.person === null)).toBe(false);
    await page.getByRole("link", { name: "Start calling" }).click();
    const done = new Set<string>();
    for (let i = 0; i < callers.length; i++) {
      await expect(page.getByRole("group", { name: "Call outcome" })).toBeVisible();
      let current = "";
      for (const name of callers) if (!done.has(name) && (await page.getByRole("heading", { name, exact: true }).isVisible())) current = name;
      expect(current).not.toBe("");
      const plan = PLAN[current]!;
      await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: plan.outcome, exact: true }).click();
      if (plan.path) await page.getByRole("group", { name: /What happens next for/ }).getByRole("radio", { name: plan.path }).check();
      if (plan.redial) await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
      if (plan.callback) await page.getByLabel("Their time", { exact: true }).fill(plan.callback);
      if (plan.note) await page.getByLabel("Notes from this call").fill(plan.note);
      if (i < 4 || plan.path || plan.redial || plan.callback) await shot(page, `05-call-${current.split(" ")[0]?.toLowerCase() ?? ""}`, false);
      await page.getByRole("button", { name: "Log and open next call" }).click();
      await expect(page.locator("p[role='status']")).toContainText(current);
      logged.push({ name: current, outcome: API_OUTCOME[plan.outcome] ?? "", test: false });
      done.add(current);
      await linger(page);
    }
    await w.harness.advanceTo(w.harness.clock + 5 * MIN);
    const status = async (name: string) => (await w.read(idOf(name))).status;
    expect(await status("Gia Moss")).toBe("interested_on_call");
    expect(await status("Hal Price")).toBe("declined_on_call");
    expect(await status("Finn Wood")).toBe("callback_scheduled");
    expect((await w.read(idOf("Jon Lake"))).branch).toBe("win_back");
    expect((await w.read(idOf("Ivy Cole"))).declined?.path).toBe("continue");
    const kim = (await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask;
    expect(kim?.open).toBe(true);
    expect(kim?.listedFor).toBe("2026-11-10");
    await at(page, w, `/leads/people/${await w.record("Gia Moss")}`);
    await expect(page.getByText("Interested on call").first()).toBeVisible();
    await shot(page, "05-interested");
  });

  await test.step("6. Reply: an email reply and a text reply each stop only that lead in that campaign, with channel and date", async () => {
    // The second campaign: one email, sent on Tuesday to Friday only, so it reaches Ada after her reply here.
    await at(page, w, `/campaigns/${otherId}`);
    await page.getByRole("button", { name: "Email track" }).click();
    await page.getByLabel("From the lead’s or company’s location, otherwise").selectOption("Europe/London");
    await page.getByLabel("Email 1 subject").fill("Spring hours at {{company}}");
    await page.getByLabel("Email 1 copy").fill("Hi {{first_name|there}},\n\nA short note on spring opening hours for {{company}}.\n\nAlex");
    await page.getByRole("button", { name: "Monday" }).click();
    await saved(page);
    await at(page, w, `/campaigns/${otherId}/before-launch`);
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched /).first()).toBeVisible();

    await w.harness.advanceTo(Date.parse("2026-11-09T11:00:00Z"));
    expect(w.harness.fake.prospectReplies("ada@harbourlane.example")).toBe(true);
    expect(w.harness.sms.prospectTexts("+447700900302", "Not now, thanks")).toBe(true);
    await w.harness.advanceTo(w.harness.clock + 10 * MIN);

    const ada = await w.read(idOf("Ada Reyes"));
    expect(ada.status).toBe("replied");
    expect(ada.reply?.channel).toBe("email");
    const ben = await w.read(idOf("Ben Ortiz"));
    expect(ben.status).toBe("replied");
    expect(ben.reply?.channel).toBe("sms");
    // Only that lead: Ada's colleague and Ada's lead in the other campaign keep running.
    expect((await w.read(idOf("Eve Hart"))).status).toBe("active");
    expect((await w.read(await w.lead("Ada Reyes", otherId))).status).not.toBe("replied");

    await at(page, w, `/leads/people/${await w.record("Ada Reyes")}`);
    const rows = page.getByRole("region", { name: "Campaigns" }).getByRole("listitem");
    await expect(rows.filter({ hasText: CAMPAIGN }).getByText("Replied, automation stopped")).toBeVisible();
    await expect(rows.filter({ hasText: OTHER }).getByText("Replied, automation stopped")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Activity" }).getByText(/Replied by email/)).toBeVisible();
    await shot(page, "06-replied-email");
    await linger(page);
    await at(page, w, `/leads/people/${await w.record("Ben Ortiz")}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByText(/Replied by text|Replied by SMS/)).toBeVisible();
    await shot(page, "06-replied-sms");
    // In search too.
    await at(page, w, "/leads");
    await page.getByLabel("Search leads").fill("Ada");
    await expect(page.getByRole("row", { name: /Ada Reyes/ })).toContainText("Replied");
    await shot(page, "06-search-replied");
  });

  const status = async (name: string) => (await w.read(idOf(name))).status;
  const attention = (p: Page) => p.getByRole("region", { name: "Needs attention" });

  await test.step("7. Failures: a bounce and a bad number end their track early; a disconnected number shows in Needs attention; an overdue callback too", async () => {
    // Cara: the bounce ended her first email track at its first email; her other tracks carry on.
    const cara = await w.read(idOf("Cara Lin"));
    const caraEmail = cara.tracks.find((t) => t.channel === "email" && t.branch === "main" && t.started);
    expect(caraEmail?.finishReason).not.toBeNull();
    expect(caraEmail?.nextStep).toBeNull();
    expect(cara.status).not.toBe("sequence_finished_no_response");
    // Dev: the invalid number ended his SMS track after text 1; text 2 is never due.
    const dev = await w.read(idOf("Dev Shah"));
    const devSms = dev.tracks.find((t) => t.channel === "sms");
    expect(devSms?.finishReason).not.toBeNull();
    expect(devSms?.nextStep).toBeNull();
    expect((await w.read(idOf("Eve Hart"))).tracks.find((t) => t.channel === "sms")?.nextStep?.number).toBe(2);

    // The second number is disconnected at the provider.
    const second = w.harness.sms.numbers.get(NUMBERS[1]);
    if (second) second.healthy = false;
    await w.harness.advanceTo(w.harness.clock + 2 * MIN);
    const needs = (await w.harness.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    expect(needs.senderProblems.map((p) => p.accountId)).toEqual([NUMBERS[1]]);
    await at(page, w, "/");
    await expect(attention(page)).toContainText("+44 7700 900901");
    await shot(page, "07-disconnected-number");
    await linger(page);
    if (second) second.healthy = true;
    await w.harness.advanceTo(w.harness.clock + 2 * MIN);
    expect((await w.harness.request<NeedsAttention>("GET", "/api/needs-attention")).body.senderProblems).toEqual([]);

    // Finn's callback at 15:30 is missed: overdue on Today until its outcome is logged.
    await w.harness.advanceTo(Date.parse("2026-11-09T15:45:00Z"));
    await at(page, w, "/");
    await expect(attention(page).getByText("Finn Wood’s callback is overdue")).toBeVisible();
    await shot(page, "07-overdue-callback");
    await linger(page);
    await at(page, w, "/calls");
    await expect(page.getByRole("heading", { name: "Finn Wood", exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "No answer", exact: true }).click();
    await page.getByRole("button", { name: "Log and open next call" }).click();
    await expect(page.locator("p[role='status']")).toContainText("Finn Wood");
    logged.push({ name: "Finn Wood", outcome: "no_answer", test: false });
    await w.harness.advanceTo(w.harness.clock + MIN);
    expect(await status("Finn Wood")).not.toBe("callback_scheduled");
  });

  await test.step("8. Pause and resume: clocks freeze, the Paused banner with its date and counts, and no burst on resume", async () => {
    await w.harness.advanceTo(Date.parse("2026-11-10T10:00:00Z"));
    // Tuesday: the other campaign's email reached Ada, who replied here on Monday; this campaign sent her nothing more.
    const otherAda = await w.lead("Ada Reyes", otherId);
    expect(w.harness.fake.deliveryLog.filter((d) => d.subjectId === otherAda)).toHaveLength(1);
    expect(deliveredTo("Ada Reyes").filter((d) => d.at > Date.parse("2026-11-09T11:00:00Z"))).toHaveLength(0);
    // Kim's redial is on today's list, its age counted from Monday.
    await at(page, w, "/");
    await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").filter({ hasText: "Kim Rowe" })).toContainText("Redial, due Mon 9 Nov");
    await shot(page, "08-today-redial");

    const eveBefore = (await w.read(idOf("Eve Hart"))).tracks.find((t) => t.channel === "email" && t.started)?.nextStep?.dueAt ?? "";
    const kimBefore = (await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask;
    expect(eveBefore).not.toBe("");

    await at(page, w, `/campaigns/${campaignId}`);
    await page.getByRole("button", { name: `Pause campaign: ${CAMPAIGN}` }).click();
    await page.getByRole("group").getByRole("button", { name: "Pause campaign" }).click();
    const banner = page.getByRole("region", { name: /^Paused since/ });
    await expect(page.getByRole("heading", { name: "Paused since Tue 10 Nov at 10:00" })).toBeVisible();
    const groups = (await w.harness.request<CampaignMeasures>("GET", `/api/campaigns/${campaignId}/measures`)).body.groups;
    // Handed to you: the two replies and the interested call, from the test's own ledger.
    expect(groups.handed_to_you).toBe(replied.email.length + replied.sms.length + logged.filter((l) => !l.test && l.outcome === "interested").length);
    for (const [group, n] of Object.entries(groups)) if (n > 0) await expect(banner.getByRole("list", { name: "Leads in each status group" })).toContainText(`${n}${group.replace(/_/g, " ")}`);
    await shot(page, "08-paused-banner");
    await linger(page);
    await at(page, w, "/calls");
    await expect(page.getByText(/calls? in Clinics, Bristol (are|is) off your list while the campaign is paused/).first()).toBeVisible();
    await shot(page, "08-calls-paused", false);

    // Two days paused: nothing goes to this campaign's leads.
    const sentBefore = campaignDeliveries().length;
    await w.harness.advanceTo(Date.parse("2026-11-12T10:00:00Z"));
    expect(campaignDeliveries()).toHaveLength(sentBefore);
    expect((await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask?.open).toBe(true);

    await at(page, w, `/campaigns/${campaignId}`);
    await page.getByRole("button", { name: `Resume campaign: ${CAMPAIGN}` }).click();
    await page.getByRole("group").getByRole("button", { name: "Resume campaign" }).click();
    await expect(page.getByText("Resumed. Each lead continued where it was.")).toBeVisible();
    await shot(page, "08-resumed");
    // Every clock froze: Eve's wait ends two days later than it would have; Kim's call keeps its original due date.
    const eveAfter = (await w.read(idOf("Eve Hart"))).tracks.find((t) => t.channel === "email" && t.started)?.nextStep?.dueAt ?? "";
    expect(Date.parse(eveAfter) - Date.parse(eveBefore)).toBe(2 * DAY);
    expect((await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask?.dueAt).toBe(kimBefore?.dueAt);

    // No burst: what fell due during the pause goes out one pacing gap apart per sender.
    const resumedAt = w.harness.clock;
    await w.harness.advanceTo(resumedAt + 3 * H);
    const after = campaignDeliveries().filter((d) => d.at >= resumedAt);
    for (const sender of new Set(after.map((d) => d.sender))) {
      const times = after.filter((d) => d.sender === sender).map((d) => d.at).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN);
    }

    // Kim's redial is still on the list, not skipped by the pause; this time no answer, no redial.
    await at(page, w, "/calls");
    await expect(page.getByRole("heading", { name: "Kim Rowe", exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "No answer", exact: true }).click();
    await page.getByRole("button", { name: "Log and open next call" }).click();
    await expect(page.locator("p[role='status']")).toContainText("Kim Rowe");
    logged.push({ name: "Kim Rowe", outcome: "no_answer", test: false });
  });

  await test.step("9. End: unanswered leads end as sequence finished, no response; the campaign, channel and call measures", async () => {
    await w.harness.advanceTo(Date.parse("2026-11-20T12:00:00Z"));
    for (const name of NAMES) expect.soft(await status(name), name).toBe(ENDS[name]);
    await at(page, w, `/leads/people/${await w.record("Eve Hart")}`);
    await expect(page.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: CAMPAIGN }).getByText("Sequence finished, no response")).toBeVisible();
    await shot(page, "09-finished-no-response");
    await linger(page);
    // Nothing went twice to any lead: each (lead, step) at most once, on the fake providers' own logs.
    const keys = campaignDeliveries().map((d) => `${d.subjectId}/${d.stepId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Bad details were never used again: Cara got one email, Dev one text.
    expect(deliveredTo("Cara Lin", "email")).toHaveLength(1);
    expect(deliveredTo("Dev Shah", "sms")).toHaveLength(1);

    // The measures, against the test's own ledger and the fake providers' delivery logs.
    const m = (await w.harness.request<CampaignMeasures>("GET", `/api/campaigns/${campaignId}/measures`)).body;
    const testEmail = toOwn(OWN_EMAIL).length;
    const testSms = toOwn(OWN_MOBILE).length;
    const leadEmail = w.harness.fake.deliveryLog.filter((d) => NAMES.some((n) => idOf(n) === d.subjectId)).length;
    const leadSms = w.harness.sms.deliveryLog.filter((d) => NAMES.some((n) => idOf(n) === d.subjectId)).length;
    expect(m.email.sent).toBe(leadEmail + testEmail);
    expect(m.email.fromTests.sent).toBe(testEmail);
    expect(m.sms.sent).toBe(leadSms + testSms);
    expect(m.email.failedOrBounced).toBe(1);
    expect(m.sms.failedOrBounced).toBe(1);
    expect(m.email.replies).toBe(replied.email.length + replied.testEmail);
    expect(m.sms.replies).toBe(replied.sms.length);
    const CONNECTED = new Set(["callback_requested", "interested", "not_interested"]);
    expect(m.calls.made).toBe(logged.length);
    expect(m.calls.connected).toBe(logged.filter((l) => CONNECTED.has(l.outcome)).length);
    expect(m.calls.interested).toBe(logged.filter((l) => l.outcome === "interested").length);
    expect(m.calls.declined).toBe(logged.filter((l) => l.outcome === "not_interested").length);
    expect(m.calls.callbacksPending).toBe(0);
    const GROUP: Record<string, string> = { replied: "handed_to_you", interested_on_call: "handed_to_you", declined_on_call: "ended", sequence_finished_no_response: "ended" };
    const expectedGroups: Record<string, number> = {};
    for (const end of Object.values(ENDS)) expectedGroups[GROUP[end] ?? ""] = (expectedGroups[GROUP[end] ?? ""] ?? 0) + 1;
    for (const [group, n] of Object.entries(m.groups)) expect(n, group).toBe(expectedGroups[group] ?? 0);

    await at(page, w, `/campaigns/${campaignId}`);
    const panel = page.getByRole("region", { name: "Outreach so far" });
    const row = (label: string) => panel.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
    const tests = (n: number) => (n > 0 ? ` (${n} from test runs)` : "");
    await expect(row("Email")).toHaveText(`${leadEmail + testEmail} sent${tests(testEmail)} · 1 failed or bounced · ${replied.email.length + replied.testEmail} replied${tests(replied.testEmail)}`);
    await expect(row("SMS")).toContainText(`${leadSms + testSms} sent${tests(testSms)} · 1 failed or bounced`);
    await expect(row("Calls")).toContainText(`${logged.length} made`);
    await expect(page.getByRole("list", { name: "Leads in each status group" }).first()).toContainText(`${expectedGroups["handed_to_you"] ?? 0}handed to you`);
    await expect(page.getByRole("list", { name: "Leads in each status group" }).first()).toContainText(`${expectedGroups["ended"] ?? 0}ended`);
    await panel.scrollIntoViewIfNeeded();
    await shot(page, "09-measures");
    await linger(page);
  });
});
