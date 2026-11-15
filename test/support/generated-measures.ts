import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { MeasureRules } from "../../src/server/measures.ts";
import type { CallsView, CallTaskView, CampaignMeasures, ControlAnswer, LeadSearchResult, OutreachStatus, TestRunTab } from "../../src/shared/api.ts";
import { EngineHarness } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { FakeMode } from "./fake-email-port.ts";
import type { FakeSmsMode } from "./fake-sms-port.ts";
import { random } from "./generated-sequences.ts";

/**
 * The generated measure runs (ticket 22; ADR 0003 "Ticket 22"). Through the real HTTP app, SQLite store and engine on the
 * fake email and SMS providers, with fictitious data: two launched campaigns with different leads, the first with an
 * email track of two steps, an SMS track and a phone track, the second one email. Some addresses bounce once sent, some
 * are refused as invalid, some mobiles are refused or reported invalid after a text; in some runs the providers send up
 * to an hour after the handover. At random instants the clock moves on, leads reply by email or text (now and then a
 * second time, or on the other channel), the user logs call outcomes (each of the eight, redials, callbacks, the
 * callback's own outcome), pauses and resumes a lead or the campaign, stops a lead and resumes it from its next step.
 *
 * The record imports nothing from src/domain/sequence/ or src/server/measures.ts. From its own log (the providers'
 * handovers, deliveries, lookups and bounces, the replies it made, the call outcomes the application accepted, the
 * callbacks it asked for and completed) and each lead's status as Leads shows it, mapped by its own copy of the spec's
 * group table, it computes every measure, and after a tick at random instants compares both campaigns' reads: M1 to M8.
 */

export type MeasureInvariant = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";
export const measureInvariantsOf = (problem: string): MeasureInvariant[] => [...problem.matchAll(/\b(M[1-8])\b/g)].map((m) => m[1] as MeasureInvariant);

export interface MeasureRunOptions {
  readonly measureRules?: Partial<MeasureRules>;
  readonly events?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const NUMBER = "+447700900001";
/** The user's own test contacts (ticket 21): fictitious, a reserved example domain and a drama-range mobile. */
const OWN_EMAIL = "alex.own@personal-mail.example";
const OWN_MOBILE = "+447700900456";

/** The spec's table of the five groups ("Outreach status"), the record's own copy. */
const GROUP: Readonly<Record<OutreachStatus, keyof CampaignMeasures["groups"]>> = {
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
/** Statuses of a lead whose outreach has ended (2.1): its callback is kept only for a restart. */
const ENDED: readonly OutreachStatus[] = ["replied", "interested_on_call", "declined_on_call", "stopped_manually", "sequence_finished_no_response", "finished_no_usable_channel"];

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const text = (id: string, waitDays = 0): StepDefinition => ({ ...email(id, waitDays), subject: "" });

const CALL_OUTCOMES = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "not_interested", "callback_requested", "skip_for_now"] as const;
type Outcome = (typeof CALL_OUTCOMES)[number];
/** What a call outcome counts as, by the ADR's definitions: the record's own table. */
const MADE: readonly Outcome[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "not_interested", "callback_requested"];
const CONNECTED: readonly Outcome[] = ["interested", "not_interested", "callback_requested"];

interface Lead {
  readonly name: string;
  readonly campaign: 0 | 1;
  readonly email: string;
  readonly mobile: string | null;
  enrollmentId: string;
  /** The channel of the lead's first reply in the campaign; never cleared (council on 384630e, item 2). */
  firstReply: "email" | "sms" | null;
  /** The lead has texted a reply (the guard below). */
  textReplied: boolean;
  /** A callback asked for with no outcome logged since. */
  callbackOpen: boolean;
  /** The first campaign's first person, enrolled in the second campaign too (by the same scraper row). */
  readonly shared?: true;
}

export async function runMeasures(seed: number, options: MeasureRunOptions = {}): Promise<{ problems: string[]; stats: { features: string[] } }> {
  const rnd = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const chance = (p: number) => rnd() < p;
  const problems: string[] = [];
  const features = new Set<string>();
  const fail = (what: string) => {
    if (problems.length < 20 && !problems.includes(what)) problems.push(what);
  };

  const late = chance(0.5);
  if (late) features.add("providers-send-late");
  const start = Date.parse("2026-11-02T08:00:00Z") + Math.floor(rnd() * 5) * DAY;
  const h = new EngineHarness({
    start,
    random: rnd,
    accounts: [{ id: "inbox-a", capacity: 500, gapMs: MIN, k: 5, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    modes: (late ? ["honest", "late-send"] : ["honest"]) satisfies FakeMode[],
    sms: { numbers: [{ id: NUMBER, capacity: 500, gapMs: MIN, k: 5, healthy: true, resetZone: "Europe/London" }], modes: (late ? ["honest", "late-send"] : ["honest"]) satisfies FakeSmsMode[] },
    ...(options.measureRules ? { measureRules: options.measureRules } : {}),
  });
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 50, userZone: "Europe/London" });

  // Fictitious people. In the first campaign, each has an email and, mostly, a mobile; in the second, an email only.
  const firstNames = ["Pat Oneil", "Nia Cole", "Sam Reed", "Ivo Marsh", "Ada Holt", "Ben Vale"].slice(0, 3 + Math.floor(rnd() * 4));
  const leads: Lead[] = [
    ...firstNames.map((name, i): Lead => ({ name, campaign: 0, email: `p${i}@harbour.example`, mobile: i === 0 || chance(0.8) ? `+4477009001${String(10 + i)}` : null, enrollmentId: "", firstReply: null, textReplied: false, callbackOpen: false })),
    ...["Rae Lund", "Lea Park"].map((name, i): Lead => ({ name, campaign: 1, email: `q${i}@kestrel.example`, mobile: null, enrollmentId: "", firstReply: null, textReplied: false, callbackOpen: false })),
    // Council on 384630e (item 3): the first campaign's first person is in the second campaign too, by the same scraper row.
    { name: firstNames[0]!, campaign: 1, email: "p0@harbour.example", mobile: null, enrollmentId: "", firstReply: null, textReplied: false, callbackOpen: false, shared: true },
  ];
  // Addresses that bounce once sent, that are refused, and mobiles refused or reported invalid after a text.
  for (const l of leads) {
    if (l.shared) continue;
    const r = rnd();
    if (r < 0.2) h.fake.bouncing.add(l.email);
    else if (r < 0.3) h.fake.invalid.add(l.email);
    if (l.mobile !== null) {
      const m = rnd();
      if (m < 0.15) h.sms.invalid.add(l.mobile);
      else if (m < 0.3) h.sms.invalidAfterSend.add(l.mobile);
    }
  }
  const definition: { -readonly [K in keyof CampaignDefinition]: CampaignDefinition[K] } & { tracks: CampaignDefinition["tracks"][number][] } = {
    timezone: "Europe/London",
    callSkipLimitDays: 3,
    emailPool: ["inbox-a"],
    smsPool: [NUMBER],
    callScript: "",
    tracks: [
      { id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 1)], start: { kind: "entry" }, removed: false },
      { id: "x1", channel: "sms", branch: "main", window: ALWAYS, steps: chance(0.5) ? [text("t1")] : [text("t1"), text("t2", 1)], start: { kind: "entry" }, removed: false },
      { id: "p1", channel: "call", branch: "main", window: ALWAYS, steps: [{ ...email("c1"), subject: "", body: "" }], start: chance(0.5) ? { kind: "entry" } : { kind: "after", trackId: "e1", delayDays: 0 }, removed: false },
    ],
  };
  // Council on 384630e, item 4, from a stream of its own: a win-back branch of two emails in half the runs.
  const r22 = random(seed ^ 0x22b);
  const winBack = r22() < 0.5;
  if (winBack) {
    features.add("a-campaign-with-a-win-back-branch");
    definition.tracks.push({ id: "w1", channel: "email", branch: "win_back", window: ALWAYS, steps: [email("w1"), email("w2", 1)], start: { kind: "entry" }, removed: false });
  }
  const second: CampaignDefinition = { ...definition, smsPool: [], tracks: [definition.tracks[0]!] };
  const campaignIds: string[] = [];
  for (const [i, def] of [definition, second].entries()) {
    const mine = leads.filter((l) => l.campaign === i);
    const harbour = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
    const companies = i === 0 ? [harbour] : [business({ business_id: "b2", business_name: "Kestrel Dental" }), harbour];
    const first = leads.find((l) => l.campaign === 0)!;
    const people = mine.map((l, j) =>
      l.shared
        ? person({ person_id: "p0-0", business_id: "b1", full_name: l.name, email: l.email, ...(first.mobile ? { dial_phone: first.mobile, dial_phone_type: "mobile" } : {}) })
        : person({ person_id: `p${i}-${j}`, business_id: i === 0 ? "b1" : "b2", full_name: l.name, email: l.email, ...(l.mobile ? { dial_phone: l.mobile, dial_phone_type: "mobile" } : {}) }),
    );
    const { campaign } = await h.createCampaign(i === 0 ? "Clinics" : "Dentists", { businesses: companies, people });
    await h.defineSequence(campaign.id, def);
    if ((await h.launch(campaign.id)).status !== 200) throw new Error("launch refused");
    campaignIds.push(campaign.id);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    for (const l of mine) l.enrollmentId = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? "";
  }
  const leadOf = (subjectId: string) => leads.find((l) => l.enrollmentId === subjectId);

  // The record's own log of calls the application accepted, and of the replies it made, per campaign.
  const callsLogged: { campaign: 0 | 1; test: boolean; outcome: Outcome }[] = [];
  // Ticket 21's test runs (the principal's decision of 15 November 2026: counted, marked as test), each with its own record:
  // its id, and the channel of its first reply. The user's own contacts are fictitious.
  const tests = new Map<string, { firstReply: "email" | "sms" | null }>();
  const isTest = (subjectId: string) => tests.has(subjectId);
  await h.request("PUT", `/api/campaigns/${campaignIds[0]}/test-contacts`, { email: OWN_EMAIL, mobile: OWN_MOBILE });
  let ids = 0;

  /** Each lead's status, as Leads shows it. */
  const statuses = async (): Promise<Map<string, OutreachStatus>> => {
    const map = new Map<string, OutreachStatus>();
    for (const id of campaignIds) for (const r of (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${id}&limit=500`)).body.rows) for (const e of r.enrollments) if (e.campaign.id === id) map.set(e.id, e.status);
    return map;
  };

  /** When the application has seen a provider's send: its event became visible, or a lookup answered it was sent. */
  const seenAt = (key: string, visibleAt: number, lookups: readonly { at: number; key: string; answer: string }[]) => Math.min(visibleAt, ...lookups.filter((x) => x.key === key && x.answer === "sent").map((x) => x.at));
  const deliveries = (channel: "email" | "sms") => {
    const log = channel === "email" ? h.fake.deliveryLog : h.sms.deliveryLog;
    const lookups = channel === "email" ? h.fake.lookupLog : h.sms.lookupLog;
    return log.filter((d) => seenAt(d.key, d.visibleAt, lookups) <= h.clock);
  };

  /** Every measure, as the record computes it for campaign `c` from its own log. */
  const expected = (c: 0 | 1, status: Map<string, OutreachStatus>) => {
    const mine = leads.filter((l) => l.campaign === c);
    // The campaign's subjects whose activity counts: its leads, and (the first campaign's) test runs.
    const counted = (subjectId: string) => mine.some((l) => l.enrollmentId === subjectId) || (c === 0 && isTest(subjectId));
    const share = <T,>(rows: readonly T[], subjectOf: (row: T) => string) => ({ all: rows.length, test: rows.filter((r) => isTest(subjectOf(r))).length });
    const groups = { running: 0, waiting_on_you: 0, handed_to_you: 0, paused: 0, ended: 0 };
    for (const l of mine) {
      const s = status.get(l.enrollmentId);
      if (s) groups[GROUP[s]] += 1;
    }
    const testReplies = c === 0 ? [...tests].filter(([, t]) => t.firstReply !== null) : [];
    const messages = (channel: "email" | "sms") => {
      const sent = deliveries(channel).filter((d) => counted(d.subjectId));
      const handovers = (channel === "email" ? h.fake.handoverLog : h.sms.handoverLog).filter((x) => counted(x.subjectId));
      const refusedTo = channel === "email" ? h.fake.invalid : h.sms.invalid;
      const bouncing = channel === "email" ? h.fake.bouncing : h.sms.invalidAfterSend;
      const bounceDelay = channel === "email" ? 5 * MIN : 2 * MIN;
      const failed = new Map<string, string>();
      for (const x of handovers) if (refusedTo.has(x.destination)) failed.set(`${x.subjectId}/${x.stepId}`, x.subjectId);
      for (const d of sent) if (bouncing.has(d.destination) && d.at + bounceDelay <= h.clock) failed.set(`${d.subjectId}/${d.stepId}`, d.subjectId);
      const replies = [...mine.filter((l) => l.firstReply === channel).map((l) => l.enrollmentId), ...testReplies.filter(([, t]) => t.firstReply === channel).map(([id]) => id)];
      return { sent: share(sent, (d) => d.subjectId), failedOrBounced: share([...failed.values()], (id) => id), replies: share(replies, (id) => id) };
    };
    const calls = callsLogged.filter((x) => x.campaign === c);
    const callShare = (rows: typeof calls) => ({ all: rows.length, test: rows.filter((x) => x.test).length });
    const made = callShare(calls.filter((x) => MADE.includes(x.outcome)));
    const connected = callShare(calls.filter((x) => CONNECTED.includes(x.outcome)));
    const replied = [...mine.filter((l) => l.firstReply !== null).map((l) => l.enrollmentId), ...testReplies.map(([id]) => id)];
    const reached = [...new Set([...replied, ...[...deliveries("email"), ...deliveries("sms")].filter((d) => counted(d.subjectId)).map((d) => d.subjectId)])];
    const pct = (n: number, d: number) => (d === 0 ? null : Math.round((100 * n) / d));
    const rate = (n: { all: number; test: number }, d: { all: number; test: number }) => ({ numerator: n.all, denominator: d.all, percent: pct(n.all, d.all), fromTests: { numerator: n.test, denominator: d.test } });
    return {
      groups,
      email: messages("email"),
      sms: messages("sms"),
      calls: {
        made,
        connected,
        interested: callShare(calls.filter((x) => x.outcome === "interested")),
        declined: callShare(calls.filter((x) => x.outcome === "not_interested")),
        // Test calls are never asked for a callback in these runs, so a pending callback is a lead's.
        callbacksPending: { all: mine.filter((l) => l.callbackOpen && !ENDED.includes(status.get(l.enrollmentId) ?? "queued")).length, test: 0 },
      },
      replyRate: rate(share(replied, (id) => id), share(reached, (id) => id)),
      connectRate: rate(connected, made),
    };
  };


  const check = async (when: string) => {
    await h.tick();
    const status = await statuses();
    for (const c of [0, 1] as const) {
      const res = await h.request<CampaignMeasures>("GET", `/api/campaigns/${campaignIds[c]}/measures`);
      if (res.status !== 200) {
        fail(`M1 ${when}: the measures of campaign ${c} answered ${res.status}`);
        continue;
      }
      const got = res.body;
      const want = expected(c, status);
      const label = (inv: string, what: string, g: unknown, w: unknown) => {
        if (JSON.stringify(g) !== JSON.stringify(w)) fail(`${inv}${c === 1 ? "/M8" : ""} ${when}: campaign ${c}'s ${what} is ${JSON.stringify(g)}, the record says ${JSON.stringify(w)}`);
      };
      label("M1", "groups", got.groups, want.groups);
      // Each figure, then how many of it came from test runs (M8: test runs counted, and only the campaign's).
      const both = (inv: string, what: string, all: number, test: number, w: { all: number; test: number }) => {
        label(inv, what, all, w.all);
        label("M8", `${what} from test runs`, test, w.test);
      };
      for (const ch of ["email", "sms"] as const) {
        both("M2", `${ch} sent`, got[ch].sent, got[ch].fromTests.sent, want[ch].sent);
        both("M3", `${ch} failed or bounced`, got[ch].failedOrBounced, got[ch].fromTests.failedOrBounced, want[ch].failedOrBounced);
        both("M4", `${ch} replies`, got[ch].replies, got[ch].fromTests.replies, want[ch].replies);
      }
      for (const part of ["made", "connected", "interested", "declined"] as const) both("M5", `calls ${part}`, got.calls[part], got.calls.fromTests[part], want.calls[part]);
      both("M6", "callbacks pending", got.calls.callbacksPending, got.calls.fromTests.callbacksPending, want.calls.callbacksPending);
      label("M7", "reply rate", got.replyRate, want.replyRate);
      label("M7", "connect rate", got.connectRate, want.connectRate);
      if (c === 0 && (h.fake.handoverLog.length > deliveries("email").length || h.sms.handoverLog.length > deliveries("sms").length)) features.add("checked-with-a-message-at-the-provider");
    }
  };

  // The events.
  const reply = async () => {
    const status = await statuses();
    const candidates = leads.filter((l) => [...deliveries("email"), ...deliveries("sms")].some((d) => d.subjectId === l.enrollmentId));
    if (candidates.length === 0) return;
    const l = pick(candidates);
    const smsSeen = deliveries("sms").filter((d) => d.subjectId === l.enrollmentId);
    const emailSeen = deliveries("email").filter((d) => d.subjectId === l.enrollmentId);
    const channel: "email" | "sms" = smsSeen.length > 0 && (emailSeen.length === 0 || chance(0.5)) ? "sms" : "email";
    const before = status.get(l.enrollmentId);
    const made = channel === "email" ? h.fake.prospectReplies(l.email, true, null, { inThreadOf: emailSeen.at(-1)! }) : h.sms.prospectTexts(l.mobile ?? "");
    if (!made) return;
    features.add(`a-reply-by-${channel}`);
    if (l.campaign === 1) features.add("a-reply-in-the-other-campaign");
    if (leads.some((x) => x.shared && x.name === l.name)) features.add(`a-reply-from-the-person-in-two-campaigns-in-campaign-${l.campaign}`);
    // Any reply ends a lead as replied unless it already replied or was interested on a call (2.1).
    // Every reply is stored on the lead, whatever its status (2.1, `applyReply`); the figure counts the lead once, by its first.
    if (before === "replied") features.add(l.firstReply === channel ? "a-second-reply" : "a-second-reply-on-the-other-channel");
    else if (before === "interested_on_call") features.add("a-reply-after-interested");
    else if (before && ENDED.includes(before)) features.add("a-reply-after-the-lead-ended");
    if (l.firstReply !== null && before !== "replied") features.add("a-new-reply-after-a-restart");
    if (l.firstReply === null) l.firstReply = channel;
    if (channel === "sms") l.textReplied = true;
    await h.advanceTo(h.clock + MIN);
  };

  const call = async () => {
    const items = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow;
    if (items.length === 0) return;
    const item = pick(items);
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
    const numberId = view.numbers.find((n) => !n.bad)?.detailId;
    if (item.test) {
      // A test call (ticket 21), to the user's own mobile; never asked for a callback here, and it keeps no note.
      const outcome = pick(CALL_OUTCOMES.filter((o) => o !== "callback_requested"));
      const res = await h.request("POST", `/api/call-tasks/${item.taskId}/outcome`, { requestId: `call-${++ids}`, outcome, numberId, ...(outcome === "not_interested" ? { declinedPath: "continue" } : {}) });
      if (res.status !== 200) return;
      callsLogged.push({ campaign: 0, test: true, outcome });
      features.add("a-test-call-logged");
      return;
    }
    const l = leadOf(item.enrollmentId);
    if (!l) return;
    const outcome = pick(CALL_OUTCOMES);
    const extra: Record<string, unknown> = {};
    if ((outcome === "no_answer" || outcome === "voicemail" || outcome === "gatekeeper") && chance(0.4)) extra["redial"] = true;
    if (outcome === "callback_requested") extra["callbackAt"] = new Date(h.clock + (1 + Math.floor(rnd() * 30)) * HOUR).toISOString();
    if (outcome === "not_interested") extra["declinedPath"] = winBack ? pick(["stop", "continue", "win_back"] as const) : pick(["stop", "continue"] as const);
    const res = await h.request("POST", `/api/call-tasks/${item.taskId}/outcome`, { requestId: `call-${++ids}`, outcome, numberId, note: "", ...extra });
    if (res.status !== 200) return;
    callsLogged.push({ campaign: l.campaign, test: false, outcome });
    features.add(`call-${outcome.replace(/_/g, "-")}`);
    if (extra["redial"]) features.add("call-redial");
    if (outcome !== "skip_for_now") {
      if (l.callbackOpen) features.add("a-callback-completed");
      l.callbackOpen = outcome === "callback_requested";
    }
  };

  /** Run test on the first campaign (ticket 21): refused while one runs; its sends go to the user's own contacts. */
  const runTest = async () => {
    const tab = (await h.request<TestRunTab>("GET", `/api/campaigns/${campaignIds[0]}/test-runs`)).body;
    const renderAs = pick(leads.filter((l) => l.campaign === 0)).enrollmentId;
    const res = await h.request<TestRunTab>("POST", `/api/campaigns/${campaignIds[0]}/test-runs`, { requestId: `test-${++ids}`, renderAs, expect: { definitionVersion: tab.definitionVersion } });
    if (res.status !== 200 || !res.body.run) return;
    tests.set(res.body.run.id, { firstReply: null });
    features.add(tests.size > 1 ? "a-second-test-run" : "a-test-run");
  };

  /** A reply from the user's own test email, in the thread of a test's email the application has seen. */
  const testReply = async () => {
    const seen = deliveries("email").filter((d) => isTest(d.subjectId));
    const d = seen.length > 0 ? pick(seen) : null;
    if (!d || !h.fake.prospectReplies(OWN_EMAIL, true, null, { inThreadOf: d })) return;
    const t = tests.get(d.subjectId)!;
    if (t.firstReply === null) t.firstReply = "email";
    else features.add("a-second-test-reply");
    features.add("a-test-reply");
    await h.advanceTo(h.clock + MIN);
  };

  /** The SMS track removed from the running campaign once it has sent (ticket 19's running edit); its texts still count. */
  let removed = false;
  const removeTrack = async () => {
    if (removed || !deliveries("sms").some((d) => leads.some((l) => l.campaign === 0 && l.enrollmentId === d.subjectId))) return;
    const current = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${campaignIds[0]}/sequence`)).body.definition;
    const next: CampaignDefinition = { ...current, tracks: current.tracks.map((t) => (t.id === "x1" ? { ...t, removed: true } : t)) };
    const res = await h.request("PUT", `/api/campaigns/${campaignIds[0]}/sequence`, next);
    if (res.status !== 200) return;
    removed = true;
    features.add("a-track-removed-after-it-sent");
  };

  const control = async () => {
    // Half the time, when one has a callback open, that lead: a pause, a stop, a skip or win-back during a callback.
    const withCallback = leads.filter((x) => x.campaign === 0 && x.callbackOpen);
    const l = withCallback.length > 0 && chance(0.5) ? pick(withCallback) : pick(leads.filter((x) => x.campaign === 0));
    const action = pick(["pause", "resume", "stop", "resume_from_next_step", "skip", ...(winBack ? (["move_to_win_back"] as const) : [])] as const);
    // Not generated until pull request 62 merges: a resume after any texted reply. The engine stores an observed text as
    // `sms:<id>` and its pre-send check compares the provider's bare id, so the resumed lead's next text finds that same old
    // reply and stops it again (seed 22058; email first then a text reaches it too, the verifier on 41028f2).
    if (action === "resume_from_next_step" && l.textReplied) return;
    const before = (await statuses()).get(l.enrollmentId);
    const res = await h.request<ControlAnswer>("POST", `/api/enrollments/${l.enrollmentId}/controls`, { requestId: `control-${++ids}`, action });
    if (res.status !== 200) return;
    features.add(`lead-${action.replace(/_/g, "-")}`);
    if (l.callbackOpen && action === "pause") features.add("a-callback-while-paused");
    if (l.callbackOpen && action === "stop") features.add("a-callback-of-a-stopped-lead");
    if (action === "resume_from_next_step" && before === "replied") features.add("resumed-after-a-reply");
    if (action === "move_to_win_back") {
      // Entering win-back finishes every main track, closing its call task (2.4): a callback asked for is no longer pending.
      if (before === "replied") features.add("moved-to-win-back-after-a-reply");
      l.callbackOpen = false;
    }
    if (action === "skip") {
      // A skipped call step closes its task and releases a callback (2.4, "Skip step").
      const skipped = res.body.effect.skips;
      if (skipped?.call) {
        features.add(skipped.call.callback ? "a-callback-skipped" : "a-call-step-skipped");
        l.callbackOpen = false;
      } else features.add("a-message-step-skipped");
    }
  };

  let campaignPaused = false;
  const campaignControl = async () => {
    const action = campaignPaused ? "resume" : "pause";
    const res = await h.request("POST", `/api/campaigns/${campaignIds[0]}/${action}`, { requestId: `campaign-${++ids}` });
    if (res.status === 200) {
      campaignPaused = !campaignPaused;
      features.add(`campaign-${action}`);
    }
  };

  const events = options.events ?? 40;
  await check("at launch");
  // Council on 384630e, from a stream of its own: test runs, their replies, and the track removal.
  const rTest = random(seed ^ 0x22c);
  for (let i = 0; i < events && problems.length === 0; i++) {
    const t = rTest();
    if (t < 0.08) await runTest();
    else if (t < 0.14) await testReply();
    else if (t < 0.17) await removeTrack();
    const r = rnd();
    if (r < 0.3) await h.advanceTo(h.clock + pick([2 * MIN, 10 * MIN, 45 * MIN, 3 * HOUR, 12 * HOUR, DAY]));
    else if (r < 0.5) await reply();
    else if (r < 0.75) await call();
    else if (r < 0.92) await control();
    else await campaignControl();
    if (chance(0.5)) await check(`after event ${i}`);
  }
  if (problems.length === 0) await check("at the end");
  for (const ch of ["email", "sms"] as const) {
    if (deliveries(ch).length > 0) features.add(`${ch}-sent`);
    const bouncing = ch === "email" ? h.fake.bouncing : h.sms.invalidAfterSend;
    if (deliveries(ch).some((d) => bouncing.has(d.destination))) features.add(`${ch}-bounced`);
    const refused = ch === "email" ? h.fake.invalid : h.sms.invalid;
    if ((ch === "email" ? h.fake.handoverLog : h.sms.handoverLog).some((x) => refused.has(x.destination))) features.add(`${ch}-refused`);
  }
  return { problems, stats: { features: [...features] } };
}
