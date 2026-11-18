import { describe, expect, test } from "vitest";
import type { LinkedinTrackView, NeedsAttention, TrackProgressView } from "../../shared/api.ts";
import { attentionItems, SAID_ON_TODAY } from "../calls/wording.ts";
import { describeEntry } from "../activity.tsx";
import { expiryLine, INMAIL_AT_THE_END, inmailLine, INVITE_HANDED, INVITE_STILL_OPEN, linkedinTrackLines, MARK_REPLIED, noteLine, withdrawalStuckItems } from "./linkedin-wording.ts";

/** The record's and Today's LinkedIn sentences, one per state of the read (ticket 24b; ADR 0004 section 9). */
const ZONE = "Europe/London";
const VIEW: LinkedinTrackView = { invite: null, note: null, connection: null, connectedAt: null, acceptedAt: null, acceptedAfterFinish: false, withdrawal: null, withdrawalAsked: false, skipCause: null, withdrawalStuck: false, inviteOpen: false, pendingElsewhereSince: null, inmail: { on: false, state: null, work: null, sentAt: null, sentFrom: null, reportedAt: null } };
const track = (linkedin: Partial<LinkedinTrackView> | null, fields: Partial<TrackProgressView> = {}): TrackProgressView => ({
  trackId: "li",
  channel: "linkedin",
  branch: "main",
  started: true,
  finishReason: null,
  finishedAt: null,
  conversationOwners: [],
  linkedin: linkedin === null ? null : { ...VIEW, ...linkedin },
  messageRequest: null,
  hold: null,
  holdOwners: [],
  nextStep: null,
  callTask: null,
  steps: [],
  ...fields,
});
const LEAD = { person: { id: "p1", name: "Pat Oneil" }, company: { id: "k1", name: "Harbour Lane Physio" }, campaign: { id: "c1", name: "Clinics, London" } };
const NOTHING: NeedsAttention = { overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [], waitingForCapacity: [], noUsableChannel: [], waitingOnProvider: [], waitingOnTransport: [], sendingInterrupted: null };
const TODAY = { overdueCallbacks: [], userZone: ZONE, date: "2026-11-02", carriedOver: 0, carriedOverLastDay: 0 };

describe("a LinkedIn track's facts on the record", () => {
  test("the note as it went: with it, without it because the allowance was used, or none written", () => {
    expect(noteLine("with")).toBe("The connection invite went with its note.");
    expect(noteLine("withheld")).toBe("The connection invite went without its note: the session’s note allowance for the month was used up.");
    expect(noteLine("none")).toBe("The connection invite went without a note, as written.");
  });

  test("an acceptance with its day; an existing connection; nothing for a track not yet sent", () => {
    expect(linkedinTrackLines(track({ invite: "sent", note: "with", connection: "accepted", connectedAt: "2026-11-03T10:00:00.000Z" }), "active", ZONE)).toEqual(["The connection invite went with its note.", "They accepted the invite on Tue 3 Nov."]);
    expect(linkedinTrackLines(track({ connection: "already_connected", connectedAt: "2026-11-03T10:00:00.000Z" }), "active", ZONE)).toEqual(["Your LinkedIn session was already connected to them, so no invite was sent."]);
    expect(linkedinTrackLines(track({}), "active", ZONE)).toEqual([]);
    expect(linkedinTrackLines(track(null, { channel: "email" }), "active", ZONE)).toEqual([]);
  });

  test("the expiry by each withdrawal state, never a time promised", () => {
    // Item 9: not asked yet, asked, and stuck (said once, item 7).
    expect(expiryLine("wanted")).toBe("No acceptance was recorded within the track’s wait, so the LinkedIn track ended for them. The invite is to be withdrawn; the app hasn’t asked LinkedIn yet.");
    expect(expiryLine("wanted", "them", { withdrawalAsked: true, withdrawalStuck: false })).toBe("No acceptance was recorded within the track’s wait, so the LinkedIn track ended for them. The app has asked LinkedIn to withdraw the invite; it isn’t confirmed withdrawn yet.");
    expect(expiryLine("wanted", "them", { withdrawalAsked: true, withdrawalStuck: true })).toBe("No acceptance was recorded within the track’s wait, so the LinkedIn track ended for them. The app has asked LinkedIn to withdraw the invite, and LinkedIn hasn’t answered whether it did: check their profile on LinkedIn and say what you found.");
    expect(expiryLine("withdrawn")).toBe("No acceptance was recorded within the track’s wait, so the LinkedIn track ended for them, and the invite was withdrawn.");
    expect(expiryLine("accepted_first")).toContain("LinkedIn showed it had been accepted first, so it wasn’t withdrawn");
    expect(expiryLine("kept_by_user")).toContain("so it wasn’t withdrawn");
    // Only the withdrawn state says it was withdrawn (council on dee365d, item 2).
    for (const w of [null, "wanted", "accepted_first", "kept_by_user"] as const) expect(expiryLine(w)).not.toMatch(/and the invite was withdrawn/);
  });

  test("an acceptance after the track ended: connected now, and the user may write by hand", () => {
    const lines = linkedinTrackLines(track({ invite: "sent", note: "none", acceptedAt: "2026-11-20T09:00:00.000Z", acceptedAfterFinish: true, withdrawal: "accepted_first" }, { finishReason: "invite_not_accepted" }), "sequence_finished_no_response", ZONE);
    expect(lines).toContain("Their acceptance of the invite was recorded after this track had ended; LinkedIn shows they had accepted it by Fri 20 Nov. You are connected now, and may want to write to them on LinkedIn yourself.");
  });

  test("an invite still open on LinkedIn is said once the lead no longer runs (Q38), never while it runs", () => {
    const open = track({ note: "with", inviteOpen: true });
    expect(linkedinTrackLines(open, "stopped_manually", ZONE)).toContain(INVITE_STILL_OPEN);
    // Item 6: what the application does, never that a withdrawal will happen.
    expect(INVITE_STILL_OPEN).toContain("The app asks LinkedIn to withdraw an invite only when the wait for acceptance runs out");
    expect(INVITE_STILL_OPEN).not.toMatch(/withdraws an invite|will be withdrawn|is withdrawn/);
    expect(linkedinTrackLines(open, "replied", ZONE)).toContain(INVITE_STILL_OPEN);
    expect(linkedinTrackLines(open, "active", ZONE)).not.toContain(INVITE_STILL_OPEN);
    // Every other ending of the track leaves it open too (item 6): a finished track says so whatever the lead's status.
    expect(linkedinTrackLines(track({ note: "with", inviteOpen: true }, { finishReason: "dropped_for_win_back" }), "in_win_back", ZONE)).toContain(INVITE_STILL_OPEN);
    // An expiry's withdrawal, stuck or not, is said by its own line, never as left open by a stop.
    expect(linkedinTrackLines(track({ inviteOpen: true, withdrawal: "wanted", withdrawalAsked: false, skipCause: null, withdrawalStuck: true }, { finishReason: "invite_not_accepted" }), "sequence_finished_no_response", ZONE)).not.toContain(INVITE_STILL_OPEN);
  });

  test("a pending invite from elsewhere, a stuck withdrawal, a skip naming the owner, a missing profile", () => {
    expect(linkedinTrackLines(track({ pendingElsewhereSince: "2026-11-02T09:00:00.000Z" }), "active", ZONE)).toEqual(["An invite to them was already pending on LinkedIn, not sent by this application (first seen Mon 2 Nov). This track waits until it is accepted or gone."]);
    // A stuck withdrawal is said once, in the expiry's own line (council on a6c1700, item 7).
    const stuck = linkedinTrackLines(track({ withdrawalStuck: true, withdrawalAsked: true, withdrawal: "wanted" }, { finishReason: "invite_not_accepted" }), "active", ZONE);
    expect(stuck.filter((l) => /hasn’t (answered|confirmed)/.test(l))).toHaveLength(1);
    const taken = linkedinTrackLines(track(null, { finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "Spring clinics", test: false, lead: null }] }), "active", ZONE);
    expect(taken[0]).toContain("campaign Spring clinics");
    expect(taken[0]).toContain("LinkedIn");
    expect(taken[0]).not.toMatch(/mobile|\btext\b/);
    // Item 10: each stored cause in its own words; a replaced profile is never said to be missing from the import.
    const skipped = (skipCause: LinkedinTrackView["skipCause"]) => linkedinTrackLines(track({ skipCause }, { finishReason: "skipped_missing_channel" }), "active", ZONE)[0];
    expect(skipped("no_profile")).toBe("The LinkedIn track was skipped: there is no LinkedIn address for them in the import.");
    expect(skipped("not_a_member_profile")).toContain("isn’t a member profile (a company page, for one)");
    expect(skipped("company_lead")).toContain("a company lead has no member profile");
    expect(skipped("replaced")).toBe("The LinkedIn track was skipped: a later import gave them a different LinkedIn profile, so the one this track started with is no longer theirs.");
    expect(skipped("marked_bad")).toContain("marked unreachable");
    expect(skipped("removed_by_import")).toBe("The LinkedIn track was skipped: a later import no longer has the LinkedIn profile this track started with.");
    // A skip recorded before causes were kept says only what is known (re-check of 82cf16d).
    expect(skipped("unrecorded")).toBe("The LinkedIn track was skipped: there was no usable LinkedIn member profile for them at the time.");
    expect(skipped("replaced")).not.toContain("in the import.");
  });

  test("the reply mark says the handoff on LinkedIn, never a phone", () => {
    expect(MARK_REPLIED.done).toContain("Carry on the conversation on LinkedIn");
    expect(Object.values(MARK_REPLIED).join(" ")).not.toMatch(/phone|Instantly/);
  });
});

describe("nothing is said as done before the engine records it (council on dee365d, item 11)", () => {
  test("an invite handed over with its answer unknown: no note said as gone, the unresolved state said instead", () => {
    const lines = linkedinTrackLines(track({ invite: "handed", note: "with" }), "active", ZONE);
    expect(lines).toEqual([INVITE_HANDED]);
    expect(lines.join(" ")).not.toMatch(/invite went|was sent|accepted the|was withdrawn|connected to them/);
  });
  test("the note as it went only with the invite recorded sent", () => {
    expect(linkedinTrackLines(track({ invite: "sent", note: "withheld" }), "active", ZONE)).toEqual([noteLine("withheld")]);
    expect(linkedinTrackLines(track({ invite: null, note: "with" }), "active", ZONE)).toEqual([]);
  });
});

describe("Needs attention's LinkedIn entries (Today)", () => {
  test("a withdrawal LinkedIn keeps answering unknown: named, with its campaign and count, linking to the record for the two answers", () => {
    const stuck = [{ ...LEAD, enrollmentId: "e1", trackId: "li", unknownAnswers: 3 }];
    const [item] = withdrawalStuckItems(stuck);
    expect(item).toMatchObject({ title: "Check whether Pat Oneil’s LinkedIn invite was withdrawn", action: { href: "/leads/people/p1" } });
    expect(item?.body).toBe("In Clinics, London, the LinkedIn session answered “unknown” 3 times when asked to withdraw the invite. Check on LinkedIn, then mark it withdrawn or still there on their record.");
    // Today shows it from the read, in its place.
    expect(attentionItems({ ...NOTHING, inviteWithdrawalsUnknown: stuck }, TODAY).map((i) => i.key)).toContain("invite-withdrawal-e1-li");
    expect(SAID_ON_TODAY.inviteWithdrawalsUnknown).not.toMatch(/not yet/);
  });

  test("a LinkedIn step waiting for sending capacity is said in LinkedIn's words, never an empty clause (a part a gap)", () => {
    const items = attentionItems({ ...NOTHING, waitingForCapacity: [{ ...LEAD, enrollmentId: "e1", campaignId: "c1", trackId: "li", stepId: "i1", channel: "linkedin", dueAt: "2026-11-02T09:00:00.000Z", accountIds: ["linkedin:s1"], resetsAt: "2026-11-03T00:00:00.000Z" , action: null, noAllowance: false}] }, TODAY);
    expect(items[0]?.body).toMatch(/LinkedIn/);
    expect(items[0]?.body).not.toMatch(/due {2}|due waits/);
  });
});

describe("Activity's LinkedIn entries in words", () => {
  const LI = { label: "LinkedIn track", several: false, branch: "main" as const };
  const at = "2026-11-02T09:05:00.000Z";
  const campaign = { id: "c1", name: "Clinics, London" };
  test("each step by its role, with LinkedIn's icon; skips say why in LinkedIn's terms; a marked reply hands over on LinkedIn", () => {
    expect(describeEntry({ campaign, at, kind: "sent", channel: "linkedin", track: LI, stepNumber: 1, from: "Simulated LinkedIn (not a session) s1", to: "https://www.linkedin.com/in/fictional-pat-oneil", copy: null }, ZONE)).toMatchObject({ icon: "linkedin", title: "Connection invite sent" });
    expect(describeEntry({ campaign, at, kind: "sent", channel: "linkedin", track: LI, stepNumber: 3, from: "s1", to: "x", copy: null }, ZONE).title).toBe("Follow-up 1 sent");
    expect(describeEntry({ campaign, at, kind: "skipped", channel: "linkedin", track: LI, stepNumber: null, reason: "no_profile" }, ZONE).body).toBe("No LinkedIn member profile in the import.");
    expect(describeEntry({ campaign, at, kind: "skipped", channel: "linkedin", track: LI, stepNumber: 1, reason: "already_connected" }, ZONE)).toMatchObject({ title: "Connection invite skipped", body: "Your LinkedIn session was already connected to them, so no invite was needed." });
    expect(describeEntry({ campaign, at, kind: "replied", channel: "linkedin" }, ZONE)).toMatchObject({ title: "You marked them replied on LinkedIn", body: "Automation stopped in this campaign. Carry on the conversation on LinkedIn." });
  });
});

describe("the InMail fallback on the record (ticket 27, ADR 0004 15.7)", () => {
  const ZONE = "Europe/London";
  const REPORT = "2026-11-03T21:00:00.000Z";
  const inm = (fields: Partial<LinkedinTrackView["inmail"]>): LinkedinTrackView["inmail"] => ({ on: true, state: null, work: null, sentAt: null, sentFrom: null, reportedAt: REPORT, ...fields });
  const track = (inmail: LinkedinTrackView["inmail"], finishReason: TrackProgressView["finishReason"] = null, more: Partial<LinkedinTrackView> = {}) => ({ channel: "linkedin" as const, finishReason, conversationOwners: [], linkedin: { ...VIEW, invite: "sent" as const, note: "none" as const, inviteOpen: true, ...more, inmail } });

  test("each state has its own sentence from its stored fact; the InMail is said as gone only once recorded sent; chosen promises nothing", () => {
    const states = ["chosen", "sent", "accepted", "no_plan", "no_credit", "stale_report", "refused", "switched_off", "skipped_by_user"] as const;
    const words = states.map((state) => inmailLine({ inviteOpen: true, inmail: inm({ state, sentAt: state === "sent" ? "2026-11-04T09:00:00.000Z" : null }) }, ZONE));
    expect(new Set(words).size).toBe(states.length);
    expect(words[0]).toBe("No acceptance was recorded within the track’s wait, so the InMail fallback was chosen (as your session last reported on Tue 3 Nov, it had a credit free). It hasn’t gone. The invite stays open on LinkedIn.");
    expect(inmailLine({ inviteOpen: true, inmail: inm({ state: "chosen", work: "handed" }) }, ZONE)).toContain("hasn’t confirmed whether it went");
    expect(words[1]).toContain("went instead on Wed 4 Nov");
    // Eligibility and its lack are said as of the session's report (council on 8b0c846, item 5).
    for (const i of [0, 3, 4, 5]) expect(words[i]).toContain("Tue 3 Nov");
    for (const w of words.filter((x) => !x?.includes("went instead"))) expect(w).not.toMatch(/the InMail went/);
  });

  test("the open invite is said only while the read says it is open, and an acceptance after the InMail on its own line (council on 8b0c846, item 9)", () => {
    const sent = inm({ state: "sent", work: "sent", sentAt: "2026-11-04T09:00:00.000Z" });
    const lines = linkedinTrackLines(track(sent, null, { inviteOpen: false, acceptedAt: "2026-11-05T10:00:00.000Z" }), "active", ZONE);
    expect(lines.join(" ")).not.toContain("The invite stays open on LinkedIn");
    expect(lines).toContain("They accepted the invite by Thu 5 Nov, after the InMail went; the follow-ups go on as before.");
    expect(linkedinTrackLines(track(sent), "active", ZONE).join(" ")).toContain("The invite stays open on LinkedIn");
  });

  test("waiting with the fallback on says what the end of the wait does; with it off, nothing new is said", () => {
    expect(linkedinTrackLines(track(inm({})), "active", ZONE)).toContain(INMAIL_AT_THE_END);
    expect(linkedinTrackLines(track(inm({ on: false })), "active", ZONE)).not.toContain(INMAIL_AT_THE_END);
  });

  test("the InMail sent and the track completed: the InMail's line, not the open-invite line of an ending", () => {
    const lines = linkedinTrackLines(track(inm({ state: "sent", work: "sent", sentAt: "2026-11-04T09:00:00.000Z" }), "completed"), "sequence_finished_no_response", ZONE);
    expect(lines.some((l) => l.includes("The invite stays open on LinkedIn"))).toBe(true);
    expect(lines).not.toContain(INVITE_STILL_OPEN);
  });

  test("not eligible at the expiry: why the InMail didn't go, as of the report, then the withdrawal's own line", () => {
    const lines = linkedinTrackLines(track(inm({ state: "no_credit" }), "invite_not_accepted", { withdrawal: "withdrawn" }), "active", ZONE);
    expect(lines).toEqual(["The connection invite went without a note, as written.", "The InMail fallback didn’t go: when the wait ended, the session that sent the invite had no InMail credit free, as your session last reported on Tue 3 Nov.", expiryLine("withdrawn")]);
  });
});
