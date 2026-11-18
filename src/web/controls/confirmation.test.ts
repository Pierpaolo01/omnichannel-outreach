import { describe, expect, test } from "vitest";
import type { CampaignPauseRead, ControlStepView, ControlView, LeadControlApi, RecordLead } from "../../shared/api.ts";
import { campaignConfirmationChanged, confirmationChanged, openCampaignConfirmation, openLeadConfirmation } from "./confirmation.ts";

/**
 * A confirmation is a snapshot (council on 57d874f, item 1): opened on one read, it keeps that read's allowed control, its
 * preview and its precondition. A newer read never changes what it shows or what it sends; it can only be said to differ.
 */

const EMAIL = { label: "Email track", several: false, branch: "main" as const };
const step = (number: number): ControlStepView => ({ trackId: "e1", track: EMAIL, channel: "email", call: null, branch: "main", stepId: `s${number}`, number, of: 3, when: null });
const skip = (n: number): ControlView => ({ action: "skip", allowed: true, statusAfter: "active", skips: step(n), next: step(n + 1), withProvider: 0, digest: `skip|active|e1/s${n}@main|e1/s${n + 1}@main` });
const lead = (controls: ControlView[], status: RecordLead["status"] = "active"): RecordLead => ({
  id: "en-1", campaignId: "c-1", status, endedAt: null, reply: null, sender: null, smsSender: null, zone: "Europe/London", tracks: [], branch: "main", winBackEnteredAt: null, declined: null, controls, mayStillSend: 0, replyMarks: {},
  campaignState: { launched: true, paused: false, pausedSince: null },
});
const refused = (action: LeadControlApi): ControlView => ({ action, allowed: false, reason: "No." });

describe("a lead control's confirmation", () => {
  test("keeps the read it was opened on: its preview and its precondition name email 1 after a newer read names email 2", () => {
    const opened = openLeadConfirmation(lead([skip(1)]), "skip");
    expect(opened).toMatchObject({ action: "skip", control: { skips: { stepId: "s1" } }, expect: { status: "active", preview: "skip|active|e1/s1@main|e1/s2@main" } });
    const newer = lead([skip(2)]);
    expect(opened && confirmationChanged(opened, newer)).toBe(true);
    // Nothing about the snapshot moved.
    expect(opened).toMatchObject({ control: { skips: { stepId: "s1" } }, expect: { status: "active", preview: "skip|active|e1/s1@main|e1/s2@main" } });
  });

  test("a newer read with the same preview and status is not a change", () => {
    const opened = openLeadConfirmation(lead([skip(1)]), "skip");
    expect(opened && confirmationChanged(opened, lead([skip(1)]))).toBe(false);
    expect(opened && confirmationChanged(opened, lead([skip(1)], "waiting_on_call"))).toBe(true);
  });

  test("a control the read refuses opens no confirmation; one the newer read refuses is a change", () => {
    expect(openLeadConfirmation(lead([refused("skip")]), "skip")).toBeNull();
    const opened = openLeadConfirmation(lead([skip(1)]), "skip");
    expect(opened && confirmationChanged(opened, lead([refused("skip")]))).toBe(true);
  });
});

describe("a campaign's confirmation", () => {
  const read = (pausedSince: string | null): CampaignPauseRead => ({ pause: { paused: pausedSince !== null, pausedSince }, statusCounts: {} as CampaignPauseRead["statusCounts"], controls: [{ action: pausedSince ? "resume" : "pause", allowed: true }], mayStillSend: 0, userZone: "Europe/London" });
  test("keeps the pause read it was opened on", () => {
    const opened = openCampaignConfirmation(read("2026-11-09T10:00:00.000Z"), "resume");
    expect(opened).toMatchObject({ action: "resume", expect: { pausedSince: "2026-11-09T10:00:00.000Z" } });
    expect(opened && campaignConfirmationChanged(opened, read("2026-11-09T12:00:00.000Z"))).toBe(true);
    expect(opened && campaignConfirmationChanged(opened, read("2026-11-09T10:00:00.000Z"))).toBe(false);
    expect(openCampaignConfirmation(read(null), "resume")).toBeNull();
  });
});
