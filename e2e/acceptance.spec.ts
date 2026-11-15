import { expect, test, type Page } from "@playwright/test";
import type { ActivityView, CampaignMeasures, LeadSearchResult, PersonRecord, SequenceView } from "../src/shared/api.ts";
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

/** An instant as London's HH:MM, as the screens say times: formatted here from the test's own record. */
const hhmm = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
/** The London calendar day of an instant, as a day number (days since 1 January 1970 in London). */
const londonDay = (t: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t).map((x) => [x.type, x.value]));
  return Math.round(Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"])) / 86_400_000);
};
/** The instant a London day starts (London is on GMT throughout this story, 9 to 20 November 2026). */
const startOfLondonDay = (day: number) => day * 86_400_000;
/** The first instant at or after `t` inside weekdays 09:00 to 17:00 in London, the story's sending windows. */
const nextWeekdayWindow = (t: number) => {
  for (let x = t, i = 0; i < 14 * 24 * 4; i++) {
    const weekday = new Date(x).getUTCDay();
    const hour = new Date(x).getUTCHours();
    if (weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 17) return x;
    x = Math.floor(x / 3_600_000) * 3_600_000 + 3_600_000;
  }
  return NaN;
};
/** An instant as "Mon 9 Nov at 11:00" in London. */
const dayAt = (t: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${parts["weekday"]} ${parts["day"]} ${parts["month"]} at ${hhmm(t)}`;
};

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

  /**
   * The test's own ledger of what a test run must send, rendered for Ada at Harbour Lane Physio: a phrase from each message
   * the test typed in step 2, by the track it belongs to. The application's step ids are not used.
   */
  const COPY_FOR_ADA = {
    email1: "Online booking at Harbour Lane Physio stops at 18:00",
    email2: "happy to send a two-minute video of evening booking for Harbour Lane Physio",
    text1: "Hi Ada, Alex from Northlight Bookings",
    text2: "Ada, should I send the two-minute video for Harbour Lane Physio?",
    afterCall: "Following up on my call: here is the two-minute video for Harbour Lane Physio",
    winBack: "a booking link for evenings only",
  } as const;
  type Message = keyof typeof COPY_FOR_ADA;
  const messageOf = (body: string): Message | "unknown" => (Object.keys(COPY_FOR_ADA) as Message[]).find((k) => body.includes(COPY_FOR_ADA[k])) ?? "unknown";
  /** Every delivery to the user's own contacts, from the fake providers' logs, in order, with the test run it belongs to. */
  const ownDeliveries = () =>
    [...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog]
      .filter((d) => d.destination === OWN_EMAIL || d.destination === OWN_MOBILE)
      .sort((x, y) => x.at - y.at)
      .map((d) => ({ run: d.subjectId, at: d.at, to: d.destination, message: messageOf(d.rendered.body) }));
  const toOwn = (destination: string) => ownDeliveries().filter((d) => d.to === destination);
  const runs = () => [...new Set(ownDeliveries().map((d) => d.run))];
  const ofRun = (run: string | undefined) => ownDeliveries().filter((d) => d.run === run);
  const at_ = (run: string | undefined, m: Message) => ofRun(run).find((d) => d.message === m)?.at ?? NaN;
  /** "About a minute": the spec's words for a test run's cut wait, taken as between 45 and 90 seconds. */
  const aboutAMinute = (ms: number) => {
    expect(ms).toBeGreaterThanOrEqual(45_000);
    expect(ms).toBeLessThanOrEqual(90_000);
  };
  const logTestCall = async (outcome: "No answer" | "Not interested") => {
    await at(page, w, "/calls");
    await expect(page.getByText(/To your test mobile/).first()).toBeVisible();
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: outcome, exact: true }).click();
    if (outcome === "Not interested") await expect(page.getByRole("group", { name: /What happens next for/ }).getByRole("radio", { name: /Move to the win-back messages/ })).toBeChecked();
    await shot(page, outcome === "No answer" ? "03-test-call-no-answer" : "03-test-call-declined", false);
    await page.getByRole("button", { name: /^Log/ }).first().click();
    await expect(page.locator("p[role='status']").first()).toBeVisible();
    return w.harness.clock;
  };

  await test.step("3. Test run: every step to the user's own contacts with waits of about a minute; the test call's paths; a reply stops a repeat", async () => {
    const tab = `/campaigns/${campaignId}/test-run`;
    await at(page, w, tab);
    await page.getByLabel("Your email").fill(OWN_EMAIL);
    await page.getByLabel("Your mobile, for texts and the test call").fill(OWN_MOBILE);
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.getByLabel("Copy written for").selectOption({ label: "Ada Reyes" });

    // Run A: the call is logged No answer, so the main path runs to its end, the email after the call included.
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await w.harness.advanceTo(w.harness.clock + 3 * MIN);
    const a = runs()[0];
    // Every email and text step of the main path, each once, to the right contact, in its track's order.
    expect(ofRun(a).map((d) => `${d.message} to ${d.to}`).sort()).toEqual([`email1 to ${OWN_EMAIL}`, `email2 to ${OWN_EMAIL}`, `text1 to ${OWN_MOBILE}`, `text2 to ${OWN_MOBILE}`]);
    expect(at_(a, "email1")).toBeLessThan(at_(a, "email2"));
    expect(at_(a, "text1")).toBeLessThan(at_(a, "text2"));
    aboutAMinute(at_(a, "email2") - at_(a, "email1"));
    aboutAMinute(at_(a, "text2") - at_(a, "text1"));
    // Nothing went to a lead.
    expect([...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog].every((d) => d.destination === OWN_EMAIL || d.destination === OWN_MOBILE)).toBe(true);
    await at(page, w, tab);
    await expect(page.getByText("On your Calls list")).toBeVisible();
    await shot(page, "03-test-sends-and-call");
    await linger(page);
    const loggedA = await logTestCall("No answer");
    await w.harness.advanceTo(w.harness.clock + 3 * MIN);
    expect(ofRun(a).map((d) => d.message).sort()).toEqual(["afterCall", "email1", "email2", "text1", "text2"]);
    aboutAMinute(at_(a, "afterCall") - loggedA);
    await at(page, w, tab);
    await expect(page.getByRole("heading", { name: `Finished: every step ran at ${hhmm(at_(a, "afterCall"))}` })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Win-back email 1" })).toContainText("Not reached");
    await shot(page, "03-test-finished-main-path");
    await linger(page);

    // Run B: Not interested takes the canvas's win-back path; the email after the call is skipped, and said so.
    await page.getByRole("button", { name: "Run test again" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await w.harness.advanceTo(w.harness.clock + 3 * MIN);
    const b = runs()[1];
    expect(ofRun(b).map((d) => d.message).sort()).toEqual(["email1", "email2", "text1", "text2"]);
    const loggedB = await logTestCall("Not interested");
    await w.harness.advanceTo(w.harness.clock + 3 * MIN);
    expect(ofRun(b).map((d) => d.message).sort()).toEqual(["email1", "email2", "text1", "text2", "winBack"]);
    expect(at_(b, "winBack") - loggedB).toBeLessThanOrEqual(MIN);
    await at(page, w, tab);
    await expect(page.getByRole("heading", { name: `Finished at ${hhmm(at_(b, "winBack"))}` })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Email track 2" })).toContainText("Skipped: the test moved to the win-back branch");
    await shot(page, "03-test-finished-win-back");
    await linger(page);

    // Run C: a reply from the test email stops it after its first email and first text.
    await page.getByRole("button", { name: "Run test again" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await w.harness.advanceTo(w.harness.clock + 30_000);
    const c = runs()[2];
    expect(ofRun(c).map((d) => d.message).sort()).toEqual(["email1", "text1"]);
    expect(w.harness.fake.prospectReplies(OWN_EMAIL)).toBe(true);
    await w.harness.advanceTo(w.harness.clock + 5 * MIN);
    expect(ofRun(c).map((d) => d.message).sort()).toEqual(["email1", "text1"]);
    expect(runs()).toHaveLength(3);
    await at(page, w, tab);
    await expect(page.getByRole("heading", { name: /Stopped by your reply/ })).toBeVisible();
    await shot(page, "03-test-stopped-by-reply");
    await linger(page);
  });

  /** The test's own ledger: every call outcome it logged and every reply it made, in this campaign. */
  // ---------------------------------------------------------------------------------------------
  // The test's own ledger. Everything the later steps expect is written here as the test acts, or read from the fake
  // providers' logs; nothing is read from the application to decide what it should show.

  /** Every call outcome the test logged in this campaign, test calls included. */
  const logged: { name: string | null; outcome: string; test: boolean }[] = [
    { name: null, outcome: "no_answer", test: true },
    { name: null, outcome: "not_interested", test: true },
  ];
  /** Every reply the test made a prospect send: who, on which channel, at which instant, with which body. */
  const replies: { name: string; channel: "email" | "sms"; at: number; body: string }[] = [];
  const TEST_RUN_REPLIES = 1;
  /** What the test expects each lead's status to end as, written down from the story. */
  const ENDS: Record<string, string> = {
    "Ada Reyes": "replied",
    "Ben Ortiz": "replied",
    "Ivy Cole": "replied",
    "Gia Moss": "interested_on_call",
    "Hal Price": "declined_on_call",
    "Cara Lin": "sequence_finished_no_response",
    "Dev Shah": "sequence_finished_no_response",
    "Eve Hart": "sequence_finished_no_response",
    "Finn Wood": "sequence_finished_no_response",
    "Jon Lake": "sequence_finished_no_response",
    "Kim Rowe": "sequence_finished_no_response",
    "Juniper Pilates Studio": "sequence_finished_no_response",
  };
  /** The status group of each status the story reaches (spec "Outreach status"). */
  const GROUP: Record<string, string> = {
    queued: "running",
    active: "running",
    in_win_back: "running",
    waiting_on_call: "waiting_on_you",
    callback_scheduled: "waiting_on_you",
    replied: "handed_to_you",
    interested_on_call: "handed_to_you",
    paused: "paused",
    declined_on_call: "ended",
    stopped_manually: "ended",
    sequence_finished_no_response: "ended",
    finished_no_usable_channel: "ended",
  };
  const groupsOf = (statuses: Record<string, string>) => {
    const out: Record<string, number> = { running: 0, waiting_on_you: 0, handed_to_you: 0, paused: 0, ended: 0 };
    for (const status of Object.values(statuses)) out[GROUP[status] ?? "?"] = (out[GROUP[status] ?? "?"] ?? 0) + 1;
    return out;
  };
  const NAMES = Object.keys(ENDS);
  const ids = new Map<string, string>();
  const idOf = (name: string) => ids.get(name) ?? "";
  const nameOf = (subjectId: string) => NAMES.find((n) => idOf(n) === subjectId) ?? null;
  /** Deliveries the fake providers made to this campaign's leads (their own logs), by lead name. */
  const deliveredTo = (name: string, channel: "email" | "sms" | "both" = "both") =>
    [...(channel === "sms" ? [] : w.harness.fake.deliveryLog), ...(channel === "email" ? [] : w.harness.sms.deliveryLog)].filter((d) => d.subjectId === idOf(name));
  const campaignDeliveries = () => [...w.harness.fake.deliveryLog, ...w.harness.sms.deliveryLog].filter((d) => nameOf(d.subjectId) !== null);
  const activity = async (name: string) => (await w.harness.request<ActivityView>("GET", `/api/people/${await w.record(name)}/activity`)).body.entries.filter((e) => e.campaign.id === campaignId);
  const status = async (name: string) => (await w.read(idOf(name))).status;
  const attention = (p: Page) => p.getByRole("region", { name: "Needs attention" });
  const campaignRow = (p: Page, name: string) => p.getByRole("region", { name: "Campaigns" }).getByRole("listitem").filter({ hasText: name }).first();
  /** The marker of each message the test typed, by the step it belongs to, for any lead: its copy without merge fields. */
  const MARK = { email2: "A quick follow-up: happy to send a two-minute video", text2: "should I send the two-minute video", afterCall: "Following up on my call" };
  const got = (name: string, mark: string) => deliveredTo(name).filter((d) => d.rendered.body.includes(mark));

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

    // Every lead's first email went, once; every person with a mobile got their first text, once; the company lead none.
    for (const name of NAMES) {
      expect(deliveredTo(name, "email")).toHaveLength(1);
      expect(deliveredTo(name, "sms")).toHaveLength(name === "Juniper Pilates Studio" ? 0 : 1);
    }
    // On schedule: one send a minute from the inbox, never two at once.
    const emailTimes = w.harness.fake.deliveryLog.filter((d) => nameOf(d.subjectId) !== null).map((d) => d.at).sort((x, y) => x - y);
    for (let i = 1; i < emailTimes.length; i++) expect((emailTimes[i] ?? 0) - (emailTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN);

    // The timeline says each send at the time the provider sent it.
    await at(page, w, `/leads/people/${await w.record("Ada Reyes")}`);
    const timeline = page.getByRole("region", { name: "Activity" });
    await expect(timeline.getByRole("listitem").filter({ hasText: "Email 1 sent" })).toContainText(hhmm(deliveredTo("Ada Reyes", "email")[0]?.at ?? NaN));
    await expect(timeline.getByRole("listitem").filter({ hasText: "Text 1 sent" })).toContainText(hhmm(deliveredTo("Ada Reyes", "sms")[0]?.at ?? NaN));
    // No delivered state: Instantly reports none for email (ADR 0002), and no SMS provider reports one yet. Not met; see the record.
    await expect(timeline.getByText(/delivered/i)).toHaveCount(0);
    await shot(page, "04-timeline-sent");

    // Failed: Cara's bounce, five minutes after the fake sent her email, and Dev's invalid number, two after his text.
    await at(page, w, `/leads/people/${await w.record("Cara Lin")}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByRole("listitem").filter({ hasText: "Email 1 bounced" })).toContainText(hhmm((deliveredTo("Cara Lin", "email")[0]?.at ?? NaN) + 5 * MIN));
    await expect(page.getByText("Email, marked wrong")).toBeVisible();
    await shot(page, "04-timeline-bounced");
    await at(page, w, `/leads/people/${await w.record("Dev Shah")}`);
    await expect(page.getByRole("region", { name: "Activity" }).getByText("Text 1: bad number")).toBeVisible();
    await expect(page.getByText("+44 7700 900306 was reported invalid and is marked wrong. Nothing more is texted to it.")).toBeVisible();
    await expect(page.getByText("Mobile, marked wrong")).toBeVisible();
    await shot(page, "04-timeline-text-failed");
  });

  /** The outcome the test logs for each call, as the focus queue opens it. */
  const PLAN: Record<string, { outcome: string; api: string; path?: RegExp; redial?: boolean; callback?: string; note?: string }> = {
    "Ada Reyes": { outcome: "Left voicemail", api: "voicemail" },
    "Ben Ortiz": { outcome: "No answer", api: "no_answer" },
    "Cara Lin": { outcome: "Didn’t reach them", api: "gatekeeper", note: "Front desk says the owner decides; try mornings." },
    "Dev Shah": { outcome: "Wrong number", api: "wrong_number" },
    "Eve Hart": { outcome: "No answer", api: "no_answer" },
    "Finn Wood": { outcome: "Callback requested", api: "callback_requested", callback: "15:30" },
    "Gia Moss": { outcome: "Interested", api: "interested" },
    "Hal Price": { outcome: "Not interested", api: "not_interested", path: /Stop all outreach in this campaign/ },
    "Ivy Cole": { outcome: "Not interested", api: "not_interested", path: /Keep the email and SMS steps going/ },
    "Jon Lake": { outcome: "Not interested", api: "not_interested", path: /Move to the win-back messages/ },
    "Kim Rowe": { outcome: "No answer", api: "no_answer", redial: true },
  };
  /** When Finn's callback hold began and ended: the instants the test logged the request and the callback's outcome. */
  const callbackHold = { from: NaN, to: NaN };
  const callQueue = (p: Page) => p.getByRole("complementary", { name: "Call queue" });

  await test.step("5. Calls: Today and the focus queue; every outcome, redial, callback, interested and every declined path", async () => {
    await at(page, w, "/");
    const callers = Object.keys(PLAN);
    await expect(page.getByText(`${callers.length} calls are ready now.`)).toBeVisible();
    await shot(page, "05-today");
    await linger(page);
    // The company lead has no number: nothing of it is on the list.
    expect(new Set((await w.calls()).readyNow.map((c) => c.person?.name ?? c.company.name))).toEqual(new Set(callers));
    await page.getByRole("link", { name: "Start calling" }).click();
    const done = new Set<string>();
    for (let i = 0; i < callers.length; i++) {
      // After a log, the desk has settled on the next call only once it has moved keyboard focus to that call's chosen
      // number, its last step in opening it. Acting before then races that focus move, which scrolls the sheet to its top while a
      // click lower down is under way (the flaky Log click, review item 15).
      await expect(page.getByRole("group", { name: "Call outcome" })).toBeVisible();
      if (i > 0) await expect(page.getByRole("group", { name: "Number you dial" }).getByRole("radio", { checked: true })).toBeFocused();
      let current = "";
      for (const name of callers) if (!done.has(name) && (await page.getByRole("heading", { name, exact: true }).isVisible())) current = name;
      expect(current).not.toBe("");
      const plan = PLAN[current]!;
      await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: plan.outcome, exact: true }).click();
      if (plan.path) await page.getByRole("group", { name: /What happens next for/ }).getByRole("radio", { name: plan.path }).check();
      if (plan.redial) await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
      if (plan.callback) await page.getByLabel("Their time", { exact: true }).fill(plan.callback);
      if (plan.note) await page.getByLabel("Notes from this call").fill(plan.note);
      await shot(page, `05-call-${current.split(" ")[0]?.toLowerCase() ?? ""}`, false);
      await page.getByRole("button", { name: "Log and open next call" }).click();
      await expect(page.locator("p[role='status']")).toContainText(current);
      logged.push({ name: current, outcome: plan.api, test: false });
      if (plan.callback) callbackHold.from = w.harness.clock;
      done.add(current);
      await linger(page);
    }
    await w.harness.advanceTo(w.harness.clock + 5 * MIN);
    // Every outcome read back from the server as the test logged it.
    for (const name of callers) {
      const calls = (await activity(name)).flatMap((e) => (e.kind === "call" ? [e.outcome] : []));
      expect(calls, name).toEqual([PLAN[name]?.api]);
    }
    expect(await status("Gia Moss")).toBe("interested_on_call");
    expect(await status("Hal Price")).toBe("declined_on_call");
    expect(await status("Finn Wood")).toBe("callback_scheduled");
    expect((await w.read(idOf("Jon Lake"))).branch).toBe("win_back");
    expect((await w.read(idOf("Ivy Cole"))).declined?.path).toBe("continue");
    // Wrong number: the number dialled, the clinic's main line (Dev's own mobile was already marked wrong), is marked bad.
    const dev = await w.harness.request<PersonRecord>("GET", `/api/people/${await w.record("Dev Shah")}`);
    const badDigits = dev.body.contactDetails.filter((d) => d.bad).map((d) => d.value.replace(/\D/g, ""));
    expect(badDigits.some((v) => v.endsWith("1174960202"))).toBe(true);
    expect(badDigits.some((v) => v.endsWith("7700900306"))).toBe(true);
    const kim = (await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask;
    expect(kim?.open).toBe(true);
    expect(kim?.listedFor).toBe("2026-11-10");
    await at(page, w, `/leads/people/${await w.record("Gia Moss")}`);
    await expect(campaignRow(page, CAMPAIGN).getByText("Interested on call")).toBeVisible();
    await shot(page, "05-interested");
  });

  await test.step("6. Reply: an email reply, a text opt-out and a text auto-reply each stop only that lead in that campaign, with channel and date", async () => {
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
    const at11 = w.harness.clock;
    expect(w.harness.fake.prospectReplies("ada@harbourlane.example")).toBe(true);
    replies.push({ name: "Ada Reyes", channel: "email", at: at11, body: "" });
    expect(w.harness.sms.prospectTexts("+447700900302", "STOP please remove me")).toBe(true);
    replies.push({ name: "Ben Ortiz", channel: "sms", at: at11, body: "STOP please remove me" });
    expect(w.harness.sms.prospectTexts("+447700900305", "Auto-reply: I am away until Monday 16 November")).toBe(true);
    replies.push({ name: "Ivy Cole", channel: "sms", at: at11, body: "Auto-reply: I am away until Monday 16 November" });
    await w.harness.advanceTo(w.harness.clock + 10 * MIN);

    for (const r of replies) {
      const read = await w.read(idOf(r.name));
      expect(read.status, r.name).toBe("replied");
      expect(read.reply?.channel, r.name).toBe(r.channel);
      expect(Date.parse(read.reply?.at ?? ""), r.name).toBe(r.at);
    }
    // Only that lead: a colleague at the same company, and Ada's lead in the other campaign, keep running.
    expect(await status("Cara Lin")).toBe("active");
    expect((await w.read(await w.lead("Ada Reyes", otherId))).status).not.toBe("replied");

    for (const r of replies) {
      await at(page, w, `/leads/people/${await w.record(r.name)}`);
      const row = campaignRow(page, CAMPAIGN);
      await expect(row.getByText("Replied, automation stopped")).toBeVisible();
      await expect(row).toContainText(`Replied by ${r.channel === "email" ? "email" : "text"} on ${dayAt(r.at)}`);
      // The reply's channel and date only, never its content.
      if (r.body) await expect(page.getByText(r.body)).toHaveCount(0);
      if (r.name === "Ada Reyes") await expect(campaignRow(page, OTHER).getByText("Replied, automation stopped")).toHaveCount(0);
      await shot(page, `06-replied-${r.name.split(" ")[0]?.toLowerCase() ?? ""}`);
      await linger(page);
    }
    // In search too.
    await at(page, w, "/leads");
    await page.getByLabel("Search leads").fill("Ada");
    await expect(page.getByRole("row", { name: /Ada Reyes/ })).toContainText("Replied");
    await shot(page, "06-search-replied");
  });

  await test.step("7. Failures: a bounce and a bad number end their track early; a disconnected number shows in Needs attention; a missed callback is overdue", async () => {
    // Cara's bounce ended her first email track after one email; Dev's invalid number ended his SMS track after one text.
    // (That neither gets a second message is asserted at the end, when it would have been due.)
    const cara = (await w.read(idOf("Cara Lin"))).tracks.find((t) => t.channel === "email" && t.branch === "main");
    expect(cara?.finishReason).not.toBeNull();
    const dev = (await w.read(idOf("Dev Shah"))).tracks.find((t) => t.channel === "sms");
    expect(dev?.finishReason).not.toBeNull();

    // The second number is disconnected at the provider; Needs attention names it; reconnected, the entry goes.
    const second = w.harness.sms.numbers.get(NUMBERS[1]);
    if (second) second.healthy = false;
    await w.harness.advanceTo(w.harness.clock + 2 * MIN);
    await at(page, w, "/");
    const entry = attention(page).getByRole("listitem").filter({ hasText: "+44 7700 900901" });
    await expect(entry).toContainText("can’t send");
    await expect(entry).toContainText("It is disconnected.");
    await shot(page, "07-disconnected-number");
    await linger(page);
    if (second) second.healthy = true;
    await w.harness.advanceTo(w.harness.clock + 2 * MIN);
    await at(page, w, "/");
    await expect(attention(page).getByRole("listitem").filter({ hasText: "+44 7700 900901" })).toHaveCount(0);

    // Finn's callback at 15:30 is missed: overdue on Today and on the Calls list, and it stays there.
    await w.harness.advanceTo(Date.parse("2026-11-09T15:45:00Z"));
    await at(page, w, "/");
    await expect(attention(page).getByText("Finn Wood’s callback is overdue")).toBeVisible();
    await shot(page, "07-overdue-callback");
    await at(page, w, "/calls");
    await expect(callQueue(page).getByRole("listitem").filter({ hasText: "Finn Wood" })).toContainText(/overdue/i);
    await linger(page);
  });

  /** What the test expects each lead's status to be just before the pause on Tuesday at 10:00, from the story so far. */
  const AT_PAUSE: Record<string, string> = {
    "Ada Reyes": "replied",
    "Ben Ortiz": "replied",
    "Ivy Cole": "replied",
    "Gia Moss": "interested_on_call",
    "Hal Price": "declined_on_call",
    // Win back: its one email went on Monday, and nothing else was left.
    "Jon Lake": "sequence_finished_no_response",
    "Finn Wood": "callback_scheduled",
    "Kim Rowe": "waiting_on_call",
    "Cara Lin": "active",
    "Dev Shah": "active",
    "Eve Hart": "active",
    "Juniper Pilates Studio": "active",
  };
  const PAUSE_AT = Date.parse("2026-11-10T10:00:00Z");
  const RESUME_AT = Date.parse("2026-11-12T10:00:00Z");

  await test.step("8. Pause and resume: rolled-over calls, the Paused banner with its date and counts, frozen clocks, calls off the list, and each lead continuing where it was", async () => {
    await w.harness.advanceTo(PAUSE_AT);
    // Tuesday: the other campaign's email reached Ada; this campaign sent her nothing after her reply.
    const otherAda = await w.lead("Ada Reyes", otherId);
    expect(w.harness.fake.deliveryLog.filter((d) => d.subjectId === otherAda)).toHaveLength(1);
    // The calls on the list are exactly the redial and the overdue callback: no declined lead is called again.
    const listed = await w.calls();
    expect(new Set([...listed.readyNow, ...listed.laterToday].map((c) => c.person?.name))).toEqual(new Set(["Kim Rowe", "Finn Wood"]));
    await at(page, w, "/");
    await expect(page.getByRole("region", { name: "Up next" }).getByRole("listitem").filter({ hasText: "Kim Rowe" })).toContainText("Redial, due Mon 9 Nov");
    // Rolled over: Kim's redial from Monday is one call carried over, in Needs attention.
    await expect(attention(page).getByText("One call carried over from an earlier day")).toBeVisible();
    await shot(page, "08-today-rolled-over");

    for (const [name, expected] of Object.entries(AT_PAUSE)) expect(await status(name), name).toBe(expected);
    await at(page, w, `/campaigns/${campaignId}`);
    await page.getByRole("button", { name: `Pause campaign: ${CAMPAIGN}` }).click();
    await page.getByRole("group").getByRole("button", { name: "Pause campaign" }).click();
    await expect(page.getByRole("heading", { name: `Paused since ${dayAt(PAUSE_AT)}` })).toBeVisible();
    const banner = page.getByRole("region", { name: /^Paused since/ }).getByRole("list", { name: "Leads in each status group" });
    for (const [group, n] of Object.entries(groupsOf(AT_PAUSE))) await expect(banner.getByRole("listitem").filter({ hasText: group.replace(/_/g, " ") })).toHaveText(`${n}${group.replace(/_/g, " ")}`);
    // The campaign's counts strip and the measures read say the same groups (ticket 22's figures).
    expect((await w.harness.request<CampaignMeasures>("GET", `/api/campaigns/${campaignId}/measures`)).body.groups).toEqual(groupsOf(AT_PAUSE));
    await shot(page, "08-paused-banner");
    await linger(page);
    // Off the Calls list itself while paused.
    await at(page, w, "/calls");
    await expect(page.getByText(/calls? in Clinics, Bristol (are|is) off your list while the campaign is paused/).first()).toBeVisible();
    // The queue itself lists neither call. (The panel beside it may still reopen the call it last had open: defect 3 in
    // the record, e2e/acceptance-defects.spec.ts.)
    await expect(callQueue(page).getByText("Ready now, 0")).toBeVisible();
    await expect(callQueue(page).getByText("Later today, 0")).toBeVisible();
    for (const name of ["Kim Rowe", "Finn Wood"]) await expect(callQueue(page).getByText(name, { exact: true })).toHaveCount(0);
    await shot(page, "08-calls-paused", false);

    // Two days paused: nothing goes to this campaign's leads, and the redial is not skipped.
    const sentBefore = campaignDeliveries().length;
    await w.harness.advanceTo(RESUME_AT);
    expect(campaignDeliveries()).toHaveLength(sentBefore);
    expect((await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call")?.callTask?.open).toBe(true);

    await at(page, w, `/campaigns/${campaignId}`);
    await page.getByRole("button", { name: `Resume campaign: ${CAMPAIGN}` }).click();
    await page.getByRole("group").getByRole("button", { name: "Resume campaign" }).click();
    await expect(page.getByText("Resumed. Each lead continued where it was.")).toBeVisible();
    await shot(page, "08-resumed");

    // Kim's redial is back in the queue after two days paused: without the pause its two-day limit, counted from
    // Monday, ended on Tuesday night. (The overdue callback comes first, so the queue opens Finn; Kim waits below.)
    await at(page, w, "/calls");
    await expect(callQueue(page).getByRole("listitem").filter({ hasText: "Kim Rowe" })).toBeVisible();
    await shot(page, "08-calls-after-resume", false);
  });

  await test.step("8 (continued). Clocks froze: each follow-up goes two days late, by the pause; the callback still holds Finn until its outcome", async () => {
    // Friday noon. Each lead's second email was due two days after its first; paused for two days, it goes four days after.
    await w.harness.advanceTo(Date.parse("2026-11-13T12:00:00Z"));
    // A wait of two days runs to the start of the lead's local day two days after the first message (ADR 0003 3.3), and
    // the message goes when that day's window opens at 09:00. Paused for two days, that day moves two days later.
    const PAUSE = RESUME_AT - PAUSE_AT;
    const PAUSE_DAYS = PAUSE / DAY;
    const followUpDay = (first: number) => londonDay(first) + 2 + PAUSE_DAYS;
    for (const name of ["Eve Hart", "Dev Shah", "Juniper Pilates Studio"]) {
      const sent = got(name, MARK.email2).map((d) => d.at);
      expect(sent, name).toHaveLength(1);
      expect(londonDay(sent[0] ?? NaN), name).toBe(followUpDay(deliveredTo(name, "email")[0]?.at ?? NaN));
      expect(hhmm(sent[0] ?? NaN) >= "09:00", name).toBe(true);
    }
    // Cara, Ada's colleague at Harbour Lane, still running after the replies there: her second text, on the same frozen clock.
    const caraText = got("Cara Lin", MARK.text2).map((d) => d.at);
    expect(caraText).toHaveLength(1);
    expect(londonDay(caraText[0] ?? NaN)).toBe(followUpDay(deliveredTo("Cara Lin", "sms")[0]?.at ?? NaN));
    // Kim's redial was not worked: its limit, Tuesday night moved by the two days paused, ended on Thursday night.
    const kimCall = (await w.read(idOf("Kim Rowe"))).tracks.find((t) => t.channel === "call");
    expect(kimCall?.finishReason).toBe("skipped_unworked");
    expect(Date.parse(kimCall?.finishedAt ?? "")).toBe(Date.parse("2026-11-10T00:00:00Z") + DAY + PAUSE);
    // Finn's follow-ups fell due too, and the callback held them: nothing has gone to him since Monday.
    expect(deliveredTo("Finn Wood").filter((d) => d.at > Date.parse("2026-11-09T12:00:00Z"))).toHaveLength(0);
    await at(page, w, "/calls");
    await expect(page.getByRole("heading", { name: "Finn Wood", exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "No answer", exact: true }).click();
    await page.getByRole("button", { name: "Log and open next call" }).click();
    await expect(page.locator("p[role='status']")).toContainText("Finn Wood");
    logged.push({ name: "Finn Wood", outcome: "no_answer", test: false });
    callbackHold.to = w.harness.clock;
    // The hold froze Finn's clock as a pause does (ADR 0003 2.3): nothing goes now; checked when it falls due, in step 9.
    await w.harness.advanceTo(callbackHold.to + H);
    expect(got("Finn Wood", MARK.email2).length + got("Finn Wood", MARK.text2).length).toBe(0);
  });

  await test.step("9. End: unanswered leads end as sequence finished, no response; the campaign, channel and call measures", async () => {
    await w.harness.advanceTo(Date.parse("2026-11-20T12:00:00Z"));
    for (const name of NAMES) expect.soft(await status(name), name).toBe(ENDS[name]);
    await at(page, w, `/leads/people/${await w.record("Eve Hart")}`);
    await expect(campaignRow(page, CAMPAIGN).getByText("Sequence finished, no response")).toBeVisible();
    await shot(page, "09-finished-no-response");
    await linger(page);
    // Nothing went twice to any lead: each (lead, step) at most once, on the fake providers' own logs.
    const keys = campaignDeliveries().map((d) => `${d.subjectId}/${d.stepId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Nothing after a reply, to anyone who replied.
    for (const r of replies) expect(deliveredTo(r.name).filter((d) => d.at > r.at), r.name).toHaveLength(0);
    // Finn's follow-ups: due at the start of the local day two days after his first email, on a clock frozen from the
    // callback request to its outcome (the campaign's pause lies inside that hold), then at the next weekday window.
    const finnDue = startOfLondonDay(londonDay(deliveredTo("Finn Wood", "email")[0]?.at ?? NaN) + 2) + (callbackHold.to - callbackHold.from);
    for (const mark of [MARK.email2, MARK.text2]) {
      const sent = got("Finn Wood", mark).map((d) => d.at);
      expect(sent, mark).toHaveLength(1);
      expect(londonDay(sent[0] ?? NaN), mark).toBe(londonDay(nextWeekdayWindow(finnDue)));
      expect(sent[0] ?? NaN, mark).toBeGreaterThanOrEqual(nextWeekdayWindow(finnDue));
    }
    // Bad details were never used again: Cara got one email, Dev one text.
    expect(deliveredTo("Cara Lin", "email")).toHaveLength(1);
    expect(deliveredTo("Dev Shah", "sms")).toHaveLength(1);

    // The measures, against the test's own ledger and the fake providers' delivery logs.
    const m = (await w.harness.request<CampaignMeasures>("GET", `/api/campaigns/${campaignId}/measures`)).body;
    const testEmail = toOwn(OWN_EMAIL).length;
    const testSms = toOwn(OWN_MOBILE).length;
    const leadEmail = w.harness.fake.deliveryLog.filter((d) => nameOf(d.subjectId) !== null).length;
    const leadSms = w.harness.sms.deliveryLog.filter((d) => nameOf(d.subjectId) !== null).length;
    const emailReplies = replies.filter((r) => r.channel === "email").length;
    const smsReplies = replies.filter((r) => r.channel === "sms").length;
    expect(m.email.sent).toBe(leadEmail + testEmail);
    expect(m.email.fromTests.sent).toBe(testEmail);
    expect(m.sms.sent).toBe(leadSms + testSms);
    expect(m.sms.fromTests.sent).toBe(testSms);
    expect(m.email.failedOrBounced).toBe(1);
    expect(m.sms.failedOrBounced).toBe(1);
    expect(m.email.replies).toBe(emailReplies + TEST_RUN_REPLIES);
    expect(m.sms.replies).toBe(smsReplies);
    const CONNECTED = new Set(["callback_requested", "interested", "not_interested"]);
    const made = logged.length;
    const connected = logged.filter((l) => CONNECTED.has(l.outcome)).length;
    expect(m.calls.made).toBe(made);
    expect(m.calls.connected).toBe(connected);
    expect(m.calls.interested).toBe(logged.filter((l) => l.outcome === "interested").length);
    expect(m.calls.declined).toBe(logged.filter((l) => l.outcome === "not_interested").length);
    expect(m.calls.callbacksPending).toBe(0);
    const expectedGroups = groupsOf(ENDS);
    for (const [group, n] of Object.entries(m.groups)) expect(n, group).toBe(expectedGroups[group] ?? 0);

    await at(page, w, `/campaigns/${campaignId}`);
    const panel = page.getByRole("region", { name: "Outreach so far" });
    const row = (label: string) => panel.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
    const tests = (n: number) => (n > 0 ? ` (${n} from test runs)` : "");
    const testCalls = logged.filter((l) => l.test);
    await expect(row("Email")).toHaveText(`${leadEmail + testEmail} sent${tests(testEmail)} · 1 failed or bounced · ${emailReplies + TEST_RUN_REPLIES} replied${tests(TEST_RUN_REPLIES)}`);
    await expect(row("SMS")).toHaveText(`${leadSms + testSms} sent${tests(testSms)} · 1 failed or bounced · ${smsReplies} leads replied`);
    await expect(row("Calls")).toHaveText(
      `${made} made${tests(testCalls.length)} · ${connected} connected${tests(testCalls.filter((l) => CONNECTED.has(l.outcome)).length)} · 1 interested · ${logged.filter((l) => l.outcome === "not_interested").length} declined${tests(testCalls.filter((l) => l.outcome === "not_interested").length)} · 0 callbacks pending`,
    );
    // The rates, with the counts behind them: leads (and test runs) emailed or texted, and how many replied; calls made, and how many connected.
    const messagedLeads = new Set(campaignDeliveries().map((d) => d.subjectId)).size;
    const testRuns = runs().length;
    const replyNum = new Set(replies.map((r) => r.name)).size + TEST_RUN_REPLIES;
    const replyDen = messagedLeads + testRuns;
    await expect(panel).toContainText(`${Math.round((100 * replyNum) / replyDen)}% ${replyNum} of the ${replyDen} you emailed or texted replied (test runs: ${TEST_RUN_REPLIES} of ${testRuns})`);
    const testConnected = testCalls.filter((l) => CONNECTED.has(l.outcome)).length;
    await expect(panel).toContainText(`${Math.round((100 * connected) / made)}% ${connected} of ${made} calls reached the prospect for a conversation (test runs: ${testConnected} of ${testCalls.length})`);
    // Opens and clicks are left out.
    await expect(panel).not.toContainText(/\bopen(s|ed)\b|\bclick/i);
    for (const [group, n] of Object.entries(expectedGroups)) await expect(page.getByRole("list", { name: "Leads in each status group" }).first().getByRole("listitem").filter({ hasText: group.replace(/_/g, " ") })).toHaveText(`${n}${group.replace(/_/g, " ")}`);
    await panel.scrollIntoViewIfNeeded();
    await shot(page, "09-measures");
    await linger(page);
  });
});
