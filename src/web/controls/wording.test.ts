import { describe, expect, test } from "vitest";
import { OUTREACH_STATUSES } from "../../domain/outreach-status.ts";
import type { CampaignPauseRead, ControlStepView, ControlView, LeadControlApi, OutreachStatus, RecordLead } from "../../shared/api.ts";
import {
  CONTROL_LABEL,
  LEAD_CONTROL_ORDER,
  campaignConfirmText,
  controlEffectText,
  controlPreviewText,
  mayStillSendText,
  nextStepSentence,
  offeredControls,
  pausedBannerText,
  statusGroupCounts,
} from "./wording.ts";

/**
 * Ticket 17b's sentences, one function per state (ADR 0003 "Ticket 17a", "Reads"): each says only what a field of the
 * server's read or a control's answer holds, in the user's zone passed in. Expected sentences are written out by hand.
 */

const ZONE = "Europe/London";
const EMAIL = { label: "Email track", several: false, branch: "main" as const };
const step = (fields: Partial<ControlStepView> = {}): ControlStepView => ({ trackId: "e1", track: EMAIL, channel: "email", branch: "main", stepId: "s2", number: 2, of: 3, dueAt: null, ...fields });
const allowed = (action: LeadControlApi, fields: Partial<Extract<ControlView, { allowed: true }>> = {}): Extract<ControlView, { allowed: true }> => ({ action, allowed: true, statusAfter: "active", skips: null, next: null, withProvider: 0, ...fields });
const refused = (action: LeadControlApi, reason: string): ControlView => ({ action, allowed: false, reason });

function lead(status: OutreachStatus, fields: Partial<RecordLead> = {}): RecordLead {
  return {
    id: "en-1",
    campaignId: "c-1",
    status,
    endedAt: null,
    reply: null,
    sender: null,
    smsSender: null,
    zone: ZONE,
    tracks: [],
    branch: "main",
    winBackEnteredAt: null,
    declined: null,
    controls: [],
    mayStillSend: 0,
    campaignState: { launched: true, paused: false, pausedSince: null },
    ...fields,
  };
}

/** A running lead whose current step is email 2, due Tuesday 3 November at 09:00 London. */
const running = (status: OutreachStatus, fields: Partial<RecordLead> = {}) =>
  lead(status, {
    tracks: [{ trackId: "e1", channel: "email", branch: "main", started: true, finishReason: null, finishedAt: null, hold: null, nextStep: { stepId: "s2", number: 2, dueAt: "2026-11-03T09:00:00.000Z" }, callTask: null, steps: [] }],
    controls: [allowed("pause", { statusAfter: "paused", next: step() }), refused("resume", "They are not paused."), allowed("skip", { skips: step(), next: step({ stepId: "s3", number: 3, dueAt: "2026-11-06T09:00:00.000Z" }) }), allowed("stop", { statusAfter: "stopped_manually" })],
    ...fields,
  });

describe("the plain next-step sentence, for every status", () => {
  test("each of the twelve statuses has a sentence (the mapping is exhaustive)", () => {
    for (const status of OUTREACH_STATUSES) expect(nextStepSentence(lead(status), ZONE), status).not.toBe("");
  });

  test("queued before launch", () => {
    expect(nextStepSentence(lead("queued", { campaignState: { launched: false, paused: false, pausedSince: null } }), ZONE)).toBe("Nothing goes out until this campaign launches.");
  });

  test("queued and active after launch: the step the read names, and when it is due", () => {
    expect(nextStepSentence(running("queued"), ZONE)).toBe("Nothing has gone out yet. Next: email 2 of 3, due Tue 3 Nov at 09:00.");
    expect(nextStepSentence(running("active"), ZONE)).toBe("Next: email 2 of 3, due Tue 3 Nov at 09:00.");
  });

  test("a step of a campaign with several tracks on its channel names the track; a win-back step says so", () => {
    const two = { label: "Email track 2", several: true, branch: "main" as const };
    const r = running("active");
    const several = { ...r, controls: r.controls.map((c) => (c.action === "skip" && c.allowed ? { ...c, skips: step({ track: two }) } : c)) };
    expect(nextStepSentence(several, ZONE)).toBe("Next: email 2 of 3 on email track 2, due Tue 3 Nov at 09:00.");
    const wb = { label: "Win-back email track", several: false, branch: "win_back" as const };
    const w = running("in_win_back");
    const winBack = { ...w, controls: w.controls.map((c) => (c.action === "skip" && c.allowed ? { ...c, skips: step({ track: wb, branch: "win_back", number: 1, of: 2 }) } : c)) };
    expect(nextStepSentence(winBack, ZONE)).toBe("Next: win-back email 1 of 2, due Tue 3 Nov at 09:00.");
  });

  test("a running lead with no step waiting says why, in the read's words", () => {
    const r = running("active", { tracks: [] });
    // With no step waiting, the pause's preview names none either: both read the engine's current step.
    const waiting = { ...r, controls: r.controls.map((c) => (c.action === "skip" ? refused("skip", "No step is waiting: the next track has not started yet.") : c.action === "pause" ? allowed("pause", { statusAfter: "paused" }) : c)) };
    expect(nextStepSentence(waiting, ZONE)).toBe("No step is waiting: the next track has not started yet.");
  });

  test("a running lead in a paused campaign: its waits are frozen, and no due time is said", () => {
    const paused = { launched: true, paused: true, pausedSince: "2026-11-02T10:00:00.000Z" };
    expect(nextStepSentence(running("active", { campaignState: paused }), ZONE)).toBe("Next: email 2 of 3. Waiting times are frozen while this campaign is paused.");
    expect(nextStepSentence(lead("waiting_on_call", { campaignState: paused }), ZONE)).toBe("The call is on hold while this campaign is paused.");
    expect(nextStepSentence(lead("callback_scheduled", { campaignState: paused }), ZONE)).toBe("The callback is on hold while this campaign is paused.");
  });

  test("paused: before the step the resume would send", () => {
    const p = lead("paused", { controls: [refused("pause", "They are already paused."), allowed("resume", { next: step({ dueAt: "2026-11-03T09:00:00.000Z" }) })] });
    expect(nextStepSentence(p, ZONE)).toBe("Paused before email 2 of 3. Waiting times are frozen.");
    expect(nextStepSentence(lead("paused"), ZONE)).toBe("Paused. Waiting times are frozen.");
  });

  test("a call step and a callback", () => {
    const call = step({ trackId: "p1", track: { label: "Phone track", several: false, branch: "main" }, channel: "call", number: 1, of: 1 });
    expect(nextStepSentence(lead("waiting_on_call", { controls: [allowed("skip", { skips: call })] }), ZONE)).toBe("Next: the call.");
    expect(nextStepSentence(lead("callback_scheduled"), ZONE)).toBe("Waiting on the callback they asked for.");
  });

  test("handed to you and ended, with the read's dates in the user's zone", () => {
    expect(nextStepSentence(lead("replied", { reply: { channel: "email", at: "2026-11-02T14:05:00.000Z" } }), ZONE)).toBe("Replied by email on Mon 2 Nov at 14:05. Answer in Instantly.");
    expect(nextStepSentence(lead("replied", { reply: { channel: "sms", at: "2026-11-02T14:05:00.000Z" } }), ZONE)).toBe("Replied by text on Mon 2 Nov at 14:05. Answer on your phone.");
    expect(nextStepSentence(lead("interested_on_call"), ZONE)).toBe("Interested on the call. Over to you.");
    expect(nextStepSentence(lead("stopped_manually", { endedAt: "2026-11-04T16:30:00.000Z" }), ZONE)).toBe("You stopped their outreach in this campaign on Wed 4 Nov at 16:30.");
    expect(nextStepSentence(lead("declined_on_call"), ZONE)).toBe("Nothing more goes out to them in this campaign.");
    expect(nextStepSentence(lead("sequence_finished_no_response"), ZONE)).toBe("Their sequence finished with no reply.");
    expect(nextStepSentence(lead("finished_no_usable_channel"), ZONE)).toBe("Nothing is left to reach them on in this campaign.");
  });

  test("the zone is the one passed in: the same read in New York says New York's day and time", () => {
    expect(nextStepSentence(running("active"), "America/New_York")).toBe("Next: email 2 of 3, due Tue 3 Nov at 04:00.");
  });
});

describe("the controls offered: exactly the ones the read allows, in a fixed order", () => {
  test("refused controls are not offered; the order is the prototype's", () => {
    expect(LEAD_CONTROL_ORDER).toEqual(["pause", "resume", "skip", "stop", "resume_from_next_step", "move_to_win_back"]);
    const r = lead("stopped_manually", {
      controls: [refused("pause", "Outreach to them has ended in this campaign (stopped manually)."), allowed("move_to_win_back", { next: step() }), allowed("resume_from_next_step", { next: step() }), refused("skip", "x")],
    });
    expect(offeredControls(r).map((c) => c.action)).toEqual(["resume_from_next_step", "move_to_win_back"]);
    expect(CONTROL_LABEL).toEqual({ pause: "Pause", resume: "Resume", skip: "Skip this step", stop: "Stop", resume_from_next_step: "Resume from the next step", move_to_win_back: "Move to win-back" });
  });
});

describe("what a control will do (the read's preview) and what it did (the answer's effect)", () => {
  const paused = { launched: true, paused: false, pausedSince: null };
  test("pause", () => {
    expect(controlPreviewText(allowed("pause", { statusAfter: "paused", next: step() }), paused, ZONE)).toBe("Nothing more goes out to them in this campaign and every wait freezes until you resume them. Email 2 of 3 waits.");
    expect(controlEffectText(allowed("pause", { statusAfter: "paused", next: step() }), ZONE)).toBe("Paused. Email 2 of 3 waits until you resume them.");
  });
  test("pause with a message already with a provider says it may still be sent", () => {
    expect(controlPreviewText(allowed("pause", { statusAfter: "paused", withProvider: 1 }), paused, ZONE)).toBe("Nothing more goes out to them in this campaign and every wait freezes until you resume them. One message already handed to a provider may still be sent.");
    expect(controlEffectText(allowed("stop", { statusAfter: "stopped_manually", withProvider: 2 }), ZONE)).toBe("Stopped. 2 messages already handed to a provider may still be sent.");
  });
  test("resume: the next step and its due time, or the hold that remains", () => {
    expect(controlPreviewText(allowed("resume", { next: step({ dueAt: "2026-11-03T09:00:00.000Z" }) }), paused, ZONE)).toBe("Their outreach continues where it was: email 2 of 3, due Tue 3 Nov at 09:00.");
    expect(controlPreviewText(allowed("resume", { next: step() }), { launched: true, paused: true, pausedSince: "2026-11-02T10:00:00.000Z" }, ZONE)).toBe("Their own pause ends. Email 2 of 3 still waits while this campaign is paused.");
    expect(controlPreviewText(allowed("resume", { statusAfter: "callback_scheduled", next: null }), paused, ZONE)).toBe("Their own pause ends. Their callback still holds their outreach until you log how it went.");
    expect(controlEffectText(allowed("resume", { next: step({ dueAt: "2026-11-03T09:00:00.000Z" }) }), ZONE)).toBe("Resumed. Next: email 2 of 3, due Tue 3 Nov at 09:00.");
  });
  test("skip", () => {
    const skip = allowed("skip", { skips: step(), next: step({ stepId: "s3", number: 3, dueAt: "2026-11-06T09:00:00.000Z" }) });
    expect(controlPreviewText(skip, paused, ZONE)).toBe("Email 2 of 3 is skipped and never sent. Next: email 3 of 3, due Fri 6 Nov at 09:00.");
    expect(controlEffectText(skip, ZONE)).toBe("Email 2 of 3 skipped. Next: email 3 of 3, due Fri 6 Nov at 09:00.");
    const call = allowed("skip", { skips: step({ channel: "call", track: { label: "Phone track", several: false, branch: "main" }, number: 1, of: 1 }), next: null });
    expect(controlPreviewText(call, paused, ZONE)).toBe("The call is skipped and never made.");
    expect(controlEffectText(call, ZONE)).toBe("Call skipped.");
  });
  test("stop", () => {
    expect(controlPreviewText(allowed("stop", { statusAfter: "stopped_manually" }), paused, ZONE)).toBe("Their outreach in this campaign stops: nothing more goes out and no call is listed. What was sent stays on record.");
    expect(controlEffectText(allowed("stop", { statusAfter: "stopped_manually" }), ZONE)).toBe("Stopped.");
  });
  test("the restarts name the step that runs next, never step 1 unless the read says so", () => {
    const resume = allowed("resume_from_next_step", { next: step({ number: 3, dueAt: "2026-11-03T09:00:00.000Z" }) });
    expect(controlPreviewText(resume, paused, ZONE)).toBe("They resume at the next unsent step: email 3 of 3, due Tue 3 Nov at 09:00. Nothing already sent goes again.");
    expect(controlEffectText(resume, ZONE)).toBe("Resumed from the next step: email 3 of 3, due Tue 3 Nov at 09:00.");
    const wb = allowed("move_to_win_back", { statusAfter: "in_win_back", next: step({ track: { label: "Win-back email track", several: false, branch: "win_back" }, branch: "win_back", number: 1, of: 2, dueAt: "2026-11-03T09:00:00.000Z" }) });
    expect(controlPreviewText(wb, paused, ZONE)).toBe("They move to this campaign’s win-back branch, starting with win-back email 1 of 2, due Tue 3 Nov at 09:00. Their remaining main-sequence steps are dropped.");
    expect(controlEffectText(wb, ZONE)).toBe("Moved to the win-back branch. Next: win-back email 1 of 2, due Tue 3 Nov at 09:00.");
  });
});

describe("the campaign's pause", () => {
  const counts = (fields: Partial<Record<OutreachStatus, number>>): Record<OutreachStatus, number> => ({ ...Object.fromEntries(OUTREACH_STATUSES.map((s) => [s, 0])), ...fields }) as Record<OutreachStatus, number>;
  const read = (fields: Partial<CampaignPauseRead> = {}): CampaignPauseRead => ({
    pause: { paused: true, pausedSince: "2026-11-02T10:15:00.000Z" },
    statusCounts: counts({ queued: 1, active: 2, in_win_back: 1, waiting_on_call: 3, callback_scheduled: 1, replied: 2, interested_on_call: 1, paused: 1, stopped_manually: 1, sequence_finished_no_response: 4 }),
    controls: [],
    mayStillSend: 0,
    userZone: ZONE,
    ...fields,
  });
  test("the counts in each status group sum the read's statuses", () => {
    expect(statusGroupCounts(read().statusCounts)).toEqual([
      { group: "running", label: "Running", count: 4 },
      { group: "waiting_on_you", label: "Waiting on you", count: 4 },
      { group: "handed_to_you", label: "Handed to you", count: 3 },
      { group: "paused", label: "Paused", count: 1 },
      { group: "ended", label: "Ended", count: 5 },
    ]);
  });
  test("the banner: the date paused in the user's zone, and what may still go", () => {
    expect(pausedBannerText(read(), ZONE)).toEqual({ title: "Paused since Mon 2 Nov at 10:15", provider: null });
    expect(pausedBannerText(read({ mayStillSend: 1 }), ZONE).provider).toBe("One message already handed to a provider may still be sent.");
  });
  test("the confirmations", () => {
    expect(campaignConfirmText("pause", "Roofers, Antwerp", read({ pause: { paused: false, pausedSince: null } }))).toBe("Pause Roofers, Antwerp? Messages stop, its calls leave your list, and every waiting time freezes.");
    expect(campaignConfirmText("pause", "Roofers, Antwerp", read({ pause: { paused: false, pausedSince: null }, mayStillSend: 3 }))).toBe("Pause Roofers, Antwerp? Messages stop, its calls leave your list, and every waiting time freezes. 3 messages already handed to a provider may still be sent.");
    expect(campaignConfirmText("resume", "Roofers, Antwerp", read())).toBe("Resume Roofers, Antwerp? Each lead continues where it was, spread across the sending window.");
  });
  test("mayStillSend: nothing at zero", () => {
    expect(mayStillSendText(0)).toBeNull();
    expect(mayStillSendText(1)).toBe("One message already handed to a provider may still be sent.");
    expect(mayStillSendText(4)).toBe("4 messages already handed to a provider may still be sent.");
  });
});
