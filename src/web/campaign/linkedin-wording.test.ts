import { describe, expect, test } from "vitest";
import type { LinkedinTrackView, NeedsAttention, TrackProgressView } from "../../shared/api.ts";
import { attentionItems, SAID_ON_TODAY } from "../calls/wording.ts";
import { describeEntry } from "../activity.tsx";
import { expiryLine, linkedinTrackLines, MARK_REPLIED, noteLine, withdrawalStuckItems } from "./linkedin-wording.ts";

/** The record's and Today's LinkedIn sentences, one per state of the read (ticket 24b; ADR 0004 section 9). */
const ZONE = "Europe/London";
const VIEW: LinkedinTrackView = { note: null, connection: null, connectedAt: null, acceptedAt: null, acceptedAfterFinish: false, withdrawal: null, withdrawalStuck: false, inviteOpen: false, pendingElsewhereSince: null };
const track = (linkedin: Partial<LinkedinTrackView> | null, fields: Partial<TrackProgressView> = {}): TrackProgressView => ({
  trackId: "li",
  channel: "linkedin",
  branch: "main",
  started: true,
  finishReason: null,
  finishedAt: null,
  conversationOwners: [],
  linkedin: linkedin === null ? null : { ...VIEW, ...linkedin },
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
    expect(linkedinTrackLines(track({ note: "with", connection: "accepted", connectedAt: "2026-11-03T10:00:00.000Z" }), "active", ZONE)).toEqual(["The connection invite went with its note.", "They accepted the invite on Tue 3 Nov."]);
    expect(linkedinTrackLines(track({ connection: "already_connected", connectedAt: "2026-11-03T10:00:00.000Z" }), "active", ZONE)).toEqual(["Your LinkedIn session was already connected to them, so no invite was sent."]);
    expect(linkedinTrackLines(track({}), "active", ZONE)).toEqual([]);
    expect(linkedinTrackLines(track(null, { channel: "email" }), "active", ZONE)).toEqual([]);
  });

  test("the expiry by each withdrawal state, never a time promised", () => {
    expect(expiryLine("wanted")).toBe("The invite wasn’t accepted within the track’s wait, so the LinkedIn track ended for them. The invite is being withdrawn.");
    expect(expiryLine("withdrawn")).toBe("The invite wasn’t accepted within the track’s wait, so the LinkedIn track ended for them, and the invite was withdrawn.");
    expect(expiryLine("accepted_first")).toContain("LinkedIn showed they had accepted it first");
    expect(expiryLine("kept_by_user")).toContain("You marked the invite as still there on LinkedIn");
  });

  test("an acceptance after the track ended: connected now, and the user may write by hand", () => {
    const lines = linkedinTrackLines(track({ note: "none", acceptedAt: "2026-11-20T09:00:00.000Z", acceptedAfterFinish: true, withdrawal: "accepted_first" }, { finishReason: "invite_not_accepted" }), "sequence_finished_no_response", ZONE);
    expect(lines).toContain("They accepted the invite on Fri 20 Nov, after this track had ended. You are connected now, and may want to write to them on LinkedIn yourself.");
  });

  test("an invite still open on LinkedIn is said once the lead no longer runs (Q38), never while it runs", () => {
    const open = track({ note: "with", inviteOpen: true });
    const said = "The connection invite sent from this campaign is still open on LinkedIn. Stopping doesn’t withdraw it; withdraw it on LinkedIn if you want it gone.";
    expect(linkedinTrackLines(open, "stopped_manually", ZONE)).toContain(said);
    expect(linkedinTrackLines(open, "replied", ZONE)).toContain(said);
    expect(linkedinTrackLines(open, "active", ZONE)).not.toContain(said);
  });

  test("a pending invite from elsewhere, a stuck withdrawal, a skip naming the owner, a missing profile", () => {
    expect(linkedinTrackLines(track({ pendingElsewhereSince: "2026-11-02T09:00:00.000Z" }), "active", ZONE)).toEqual(["An invite to them was already pending on LinkedIn, not sent by this application (first seen Mon 2 Nov). This track waits until it is accepted or gone."]);
    expect(linkedinTrackLines(track({ withdrawalStuck: true, withdrawal: "wanted" }, { finishReason: "invite_not_accepted" }), "active", ZONE).at(-1)).toBe("LinkedIn hasn’t confirmed the invite was withdrawn. Check their profile on LinkedIn and say what you found.");
    const taken = linkedinTrackLines(track(null, { finishReason: "skipped_conversation_taken", conversationOwners: [{ name: "Spring clinics", test: false }] }), "active", ZONE);
    expect(taken[0]).toContain("campaign Spring clinics");
    expect(taken[0]).toContain("LinkedIn");
    expect(taken[0]).not.toMatch(/mobile|\btext\b/);
    expect(linkedinTrackLines(track(null, { finishReason: "skipped_missing_channel" }), "active", ZONE)).toEqual(["The LinkedIn track was skipped: there is no LinkedIn member profile for them in the import."]);
  });

  test("the reply mark says the handoff on LinkedIn, never a phone", () => {
    expect(MARK_REPLIED.done).toContain("Carry on the conversation on LinkedIn");
    expect(Object.values(MARK_REPLIED).join(" ")).not.toMatch(/phone|Instantly/);
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
    const items = attentionItems({ ...NOTHING, waitingForCapacity: [{ ...LEAD, enrollmentId: "e1", campaignId: "c1", trackId: "li", stepId: "i1", channel: "linkedin", dueAt: "2026-11-02T09:00:00.000Z", accountIds: ["linkedin:s1"], resetsAt: "2026-11-03T00:00:00.000Z" }] }, TODAY);
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
