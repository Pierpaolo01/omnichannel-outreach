import { describe, expect, test } from "vitest";
import type { ControlView, LinkedinTrackView, RecordLead, TestRunRead, TrackProgressView } from "../../shared/api.ts";
import { attentionItems } from "../calls/wording.ts";
import { confirmationChanged, openLeadConfirmation } from "../controls/confirmation.ts";
import { controlPreviewText, stepWaitWords, type AllowedControl } from "../controls/wording.ts";
import { usedTodayWarnings } from "./BeforeLaunchTab.tsx";
import { INVITE_STAYS_OPEN, testReplyHelper } from "./linkedin-wording.ts";
import { stepWaitReach, whatItDoes } from "./RunningChanges.tsx";
import { pressDone, testConfirmationGone } from "./TestRunTab.tsx";
import { withheldExplanation } from "./withheld.ts";

/** The council's first review of `dee365d` (ticket 24b): each screen sentence or snapshot that could say something untrue. */

const VIEW: LinkedinTrackView = { invite: "sent", note: "with", connection: null, connectedAt: null, acceptedAt: null, acceptedAfterFinish: false, withdrawal: null, withdrawalAsked: false, skipCause: null, withdrawalStuck: false, inviteOpen: true, pendingElsewhereSince: null };
const liTrack = (view: Partial<LinkedinTrackView>): TrackProgressView => ({ trackId: "li", channel: "linkedin", branch: "main", started: true, finishReason: null, finishedAt: null, conversationOwners: [], messageRequest: null, linkedin: { ...VIEW, ...view }, hold: null, holdOwners: [], nextStep: null, callTask: null, steps: [] });
const control = (action: "stop" | "move_to_win_back"): AllowedControl => ({ action, allowed: true, statusAfter: "stopped_manually", skips: null, next: null, withProvider: 0, digest: `${action}|x|invite_open` });
const lead = (controls: ControlView[], tracks: TrackProgressView[]): RecordLead => ({
  id: "en-1", campaignId: "c-1", status: "active", endedAt: null, reply: null, sender: null, smsSender: null, zone: "Europe/London", tracks, branch: "main", winBackEnteredAt: null, declined: null, controls, mayStillSend: 0, replyMarks: {},
  campaignState: { launched: true, paused: false, pausedSince: null },
});
const CAMPAIGN = { launched: true, paused: false, pausedSince: null };

describe("items 6 and 7: an open invite in a confirmation, and in its snapshot", () => {
  test("stop and move to win-back each say the invite stays open, only while the read says one is open", () => {
    expect(controlPreviewText(control("stop"), CAMPAIGN, "Europe/London", true)).toContain(INVITE_STAYS_OPEN.stop);
    expect(controlPreviewText(control("move_to_win_back"), CAMPAIGN, "Europe/London", true)).toContain(INVITE_STAYS_OPEN.move_to_win_back);
    expect(controlPreviewText(control("move_to_win_back"), CAMPAIGN, "Europe/London", false)).not.toContain("stays open");
  });
  test("a confirmation opened while the invite was open is changed once a newer read says it no longer is", () => {
    const opened = openLeadConfirmation(lead([control("stop")], [liTrack({})]), "stop");
    expect(opened?.inviteOpen).toBe(true);
    expect(opened && confirmationChanged(opened, lead([control("stop")], [liTrack({ inviteOpen: false, connection: "accepted" })]))).toBe(true);
    expect(opened && confirmationChanged(opened, lead([control("stop")], [liTrack({})]))).toBe(false);
  });
});

describe("item 4: a LinkedIn session's invites and messages are said apart", () => {
  const row = { id: "linkedin:s1", label: "Simulated LinkedIn (not a session) s1", channel: "linkedin" as const, capacity: 40, usedToday: 2, busiestDay: 0, gapSeconds: 60 };
  test("messages used never say fewer invites can go", () => {
    const said = usedTodayWarnings({ ...row, kinds: { invite: { capacity: 20, usedToday: 0 }, message: { capacity: 20, usedToday: 2 } } });
    expect(said.map((w) => w.title)).toEqual(["Simulated LinkedIn (not a session) s1 has 2 of its 20 messages a day used today"]);
    expect(said.map((w) => `${w.title} ${w.detail}`).join(" ")).not.toMatch(/invite/);
  });
  test("held LinkedIn work on Today is said without a summed capacity", () => {
    const NOTHING = { overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [], waitingForCapacity: [], noUsableChannel: [], waitingOnProvider: [], waitingOnTransport: [], sendingInterrupted: null };
    const [item] = attentionItems({ ...NOTHING, heldCapacity: [{ accountId: "linkedin:s1", channel: "linkedin", held: 1, capacity: 40, sentToday: 0, work: [] }] }, { overdueCallbacks: [], userZone: "Europe/London", date: "2026-11-02", carriedOver: 0, carriedOverLastDay: 0 });
    expect(item?.title).toBe("1 of linkedin:s1’s LinkedIn steps today is held");
  });
});

describe("item 5: a running edit's wait, by the step's role", () => {
  const def = { timezone: "UTC", callSkipLimitDays: 2, emailPool: [], tracks: [{ id: "li", channel: "linkedin" as const, branch: "main" as const, window: [], start: { kind: "entry" as const }, removed: false, acceptWaitDays: 3, steps: ["i", "m1", "m2"].map((id) => ({ id, waitDays: 1, subject: "", body: "x", threading: "new_subject" as const, removed: false })) }] };
  test("the first message's wait counts from the connection; a follow-up's from the message before", () => {
    expect(stepWaitReach({ trackId: "li", stepId: "m1" }, def)).toContain("counted from when they accept the invite");
    expect(stepWaitReach({ trackId: "li", stepId: "m2" }, def)).toContain("counted from their last message");
  });
  test("removing a LinkedIn track says a sent invite stays open", () => {
    const removed = { ...def, tracks: [{ ...def.tracks[0]!, removed: true }] };
    expect(whatItDoes({ kind: "track_removed", trackId: "li", stepId: null, reaches: 0, skips: 2, inFlight: 0, untouched: 0 }, false, removed)).toContain("An invite already sent stays open on LinkedIn");
  });
});

describe("items 1, 8 and 9: the load withheld for LinkedIn", () => {
  test("another campaign's LinkedIn track is named as the reason", () => {
    const competing = (fields: Partial<{ name: string; test: boolean; own: boolean; why: "inbox" | "number" | "session" | "calls" | "through_another" }>) => ({ tracks: [{ trackId: "li", channel: "linkedin" as const, label: "the LinkedIn track", why: "not_modelled" as const, competing: { name: "Clinics on LinkedIn", test: false, own: false, why: "inbox" as const, ...fields } }] });
    expect(withheldExplanation(competing({}))).toBe(
      "No load is projected for this campaign: campaign Clinics on LinkedIn, which shares a sender inbox with it, still has a LinkedIn track to finish, which the estimate doesn’t model yet, so a figure here would leave out what it sends after it.",
    );
    // Item 4: a campaign pulled in by the call list is never said to share senders.
    expect(withheldExplanation(competing({ why: "calls" }))).toContain("which shares your call list with it");
    // Item 3: a test run is named as an SMS owner is; this campaign's own says the figure returns when it ends.
    expect(withheldExplanation(competing({ test: true }))).toContain("the test run of campaign Clinics on LinkedIn, which");
    expect(withheldExplanation(competing({ test: true, own: true }))).toBe("No load is projected while this campaign’s own test is running: its LinkedIn track, which the estimate doesn’t model yet, uses the same senders. The figure returns when the test ends.");
  });
});

describe("item 10: a test run's confirmation belongs to the run it was opened on", () => {
  const run = (id: string, fields: Partial<TestRunRead> = {}): TestRunRead => ({
    id, running: false, ending: "finished", startedAt: "2026-11-02T09:00:00Z", endedAt: null, renderAs: { id: "l", name: "Pat" }, email: null, mobile: null, linkedin: null, status: "sequence_finished_no_response", mayStillSend: 0, steps: [], linkedinTracks: [], replyMarks: { linkedin: { allowed: true, work: { kind: "invite", state: "sent" } } }, social: { instagram: null }, ...fields,
  });
  test("a newer run shown closes it, with the reason; the same run still allowing it keeps it", () => {
    const c = { kind: "reply" as const, channel: "linkedin" as const, runId: "t1", status: "sequence_finished_no_response" as const, wasRunning: false };
    expect(testConfirmationGone(c, run("t1"))).toBeNull();
    expect(testConfirmationGone(c, run("t2", { running: true, status: "active" }))).toBe("The test shown here changed since you opened this, so it was closed. Nothing was marked.");
    expect(testConfirmationGone(c, run("t1", { replyMarks: { linkedin: { allowed: false, reason: "They are already marked replied in this campaign." } } }))).not.toBeNull();
  });
  test("its answer says the test stopped only for the run it was confirmed on, while that run was running", () => {
    expect(pressDone({ kind: "reply", runId: "t1", wasRunning: false }, run("t2", { running: true }))).toBe("Marked the earlier test replied on LinkedIn. The test shown now is a newer one.");
    expect(pressDone({ kind: "reply", runId: "t1", wasRunning: false }, run("t1"))).toBe("Marked replied on LinkedIn.");
    expect(pressDone({ kind: "reply", runId: "t1", wasRunning: true }, run("t1"))).toContain("The test stopped");
  });
});

describe("item 11, continued: a step handed over and not yet reported promises nothing", () => {
  test("on every channel, it is handed to the provider and not known to have gone", () => {
    for (const channel of ["email", "sms", "linkedin"] as const) {
      const said = stepWaitWords("with_provider", channel);
      expect(said).toBe("handed to the provider; it isn’t known yet whether it went");
      expect(said).not.toMatch(/sends it|will go|will be sent/);
    }
  });
});

describe("item 15: LinkedIn steps with no allowance, or none left today, on Today", () => {
  const LEAD = { person: { id: "p1", name: "Pat Oneil" }, company: { id: "k1", name: "Harbour Lane Physio" }, campaign: { id: "c1", name: "Clinics, London" } };
  const NOTHING = { overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [], waitingForCapacity: [], noUsableChannel: [], waitingOnProvider: [], waitingOnTransport: [], sendingInterrupted: null };
  const TODAY = { overdueCallbacks: [], userZone: "Europe/London", date: "2026-11-02", carriedOver: 0, carriedOverLastDay: 0 };
  const wait = (noAllowance: boolean) => ({ ...LEAD, enrollmentId: "e1", campaignId: "c1", trackId: "li", stepId: "inv", channel: "linkedin" as const, dueAt: "2026-11-02T09:00:00.000Z", accountIds: ["linkedin:s1"], resetsAt: "2026-11-03T00:00:00.000Z", action: "invite" as const, noAllowance });
  test("no allowance: never full today, no reset, nothing about a setting to find", () => {
    const [item] = attentionItems({ ...NOTHING, waitingForCapacity: [wait(true)] }, TODAY);
    expect(item?.title).toBe("Pat Oneil’s LinkedIn step can’t go yet");
    expect(item?.body).toBe("In Clinics, London: No LinkedIn session it may use has an allowance for invites, so it waits. With no allowance there is no room on any day, so no time is given; nothing is dropped.");
    expect(item?.body).not.toMatch(/full|resets|settings?|set it|change/);
    expect(stepWaitWords("no_allowance", "linkedin")).not.toMatch(/full|today|resets|setting/);
  });
  test("used up today: full for the day, with its reset", () => {
    const [item] = attentionItems({ ...NOTHING, waitingForCapacity: [wait(false)] }, TODAY);
    expect(item?.body).toContain("is full for the day. The first resets");
    expect(item?.body).toContain("LinkedIn");
  });
});

describe("the review bot on c20c8f0: the test reply mark's helper says the work that allows the mark, by its kind and state", () => {
  test("four cases, one sentence each, nothing inferred from empty fields", () => {
    expect(testReplyHelper({ kind: "message", state: "sent" })).toBe("Once you have answered a test message on your test profile.");
    expect(testReplyHelper({ kind: "invite", state: "sent" })).toBe("Only the test invite has gone so far: mark it once you have written back on LinkedIn from your test profile.");
    expect(testReplyHelper({ kind: "message", state: "handed" })).toBe("A test message is with the LinkedIn session, which hasn’t confirmed whether it went: mark it once you have written back on LinkedIn from your test profile.");
    expect(testReplyHelper({ kind: "invite", state: "handed" })).toBe("The test invite is with the LinkedIn session, which hasn’t confirmed whether it went: mark it once you have written back on LinkedIn from your test profile.");
    for (const kind of ["invite", "message"] as const) expect(testReplyHelper({ kind, state: "handed" })).not.toMatch(/has gone/);
  });
});
