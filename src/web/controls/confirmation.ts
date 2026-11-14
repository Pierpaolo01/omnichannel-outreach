/**
 * A confirmation is a snapshot (council on 57d874f, item 1; ADR 0003 4.4.1). Opened on one read, it keeps that read's
 * allowed control, its preview and its precondition: the strip shows them, and the press sends that precondition, so a step
 * that changed since is refused by the server in place, never applied to another step. A newer read can only be said to
 * differ ("This row changed since you opened this"); it never changes what the confirmation shows or sends.
 */
import type { CampaignPauseRead, LeadControlApi, RecordLead } from "../../shared/api.ts";
import type { CampaignExpectation, LeadExpectation } from "./requests.ts";
import type { AllowedControl } from "./wording.ts";

export interface LeadConfirmation {
  readonly action: LeadControlApi;
  /** The control as the read the confirmation opened on allowed it, with its preview. */
  readonly control: AllowedControl;
  readonly expect: LeadExpectation;
  readonly campaignState: RecordLead["campaignState"];
}

/** What a confirmation sends with its control: the lead's status in the read, and the digest of the whole preview it showed. */
export function expectationOf(lead: Pick<RecordLead, "status">, control: AllowedControl): LeadExpectation {
  return { status: lead.status, preview: control.digest };
}

const allowedIn = (lead: Pick<RecordLead, "controls">, action: LeadControlApi): AllowedControl | null =>
  lead.controls.find((c): c is AllowedControl => c.action === action && c.allowed) ?? null;

/** The snapshot of a lead control's confirmation, from the read it opens on; null when that read refuses the control. */
export function openLeadConfirmation(lead: RecordLead, action: LeadControlApi): LeadConfirmation | null {
  const control = allowedIn(lead, action);
  return control ? { action, control, expect: expectationOf(lead, control), campaignState: lead.campaignState } : null;
}

/** A newer read differs from what the confirmation shows: its control refused, its preview or its precondition changed. */
export function confirmationChanged(opened: LeadConfirmation, lead: RecordLead): boolean {
  const now = allowedIn(lead, opened.action);
  if (!now) return true;
  return JSON.stringify(now) !== JSON.stringify(opened.control) || JSON.stringify(expectationOf(lead, now)) !== JSON.stringify(opened.expect) || lead.campaignState.paused !== opened.campaignState.paused;
}

export interface CampaignConfirmation {
  readonly action: "pause" | "resume";
  readonly expect: CampaignExpectation;
  /** The read the confirmation opened on, whose words it shows. */
  readonly read: CampaignPauseRead;
}

/** The snapshot of a campaign's pause or resume confirmation; null when the read does not allow the action. */
export function openCampaignConfirmation(read: CampaignPauseRead, action: "pause" | "resume"): CampaignConfirmation | null {
  return read.controls.some((c) => c.action === action && c.allowed) ? { action, expect: { pausedSince: read.pause.pausedSince }, read } : null;
}

/** A newer read differs from the pause read the confirmation opened on. */
export function campaignConfirmationChanged(opened: CampaignConfirmation, read: CampaignPauseRead): boolean {
  return read.pause.pausedSince !== opened.expect.pausedSince || !read.controls.some((c) => c.action === opened.action && c.allowed);
}
