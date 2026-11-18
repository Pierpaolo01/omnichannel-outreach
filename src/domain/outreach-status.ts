/**
 * Outreach status: where one lead's automated outreach stands in one campaign.
 * Each lead has exactly one. The set and its five groups are fixed by the spec (issue #10,
 * "Outreach status"); every ticket uses this closed type rather than adding strings of its own.
 */
export const OUTREACH_STATUSES = [
  "queued",
  "active",
  "in_win_back",
  "waiting_on_call",
  "callback_scheduled",
  "replied",
  "interested_on_call",
  "paused",
  "declined_on_call",
  "stopped_manually",
  "sequence_finished_no_response",
  "finished_no_usable_channel",
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const STATUS_GROUPS = ["running", "waiting_on_you", "handed_to_you", "paused", "ended"] as const;

export type StatusGroup = (typeof STATUS_GROUPS)[number];

const GROUP_OF = {
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
} as const satisfies Record<OutreachStatus, StatusGroup>;

export function statusGroup(status: OutreachStatus): StatusGroup {
  return GROUP_OF[status];
}

export function isOutreachStatus(value: unknown): value is OutreachStatus {
  return typeof value === "string" && (OUTREACH_STATUSES as readonly string[]).includes(value);
}

/** The status an import gives a newly enrolled lead: it waits for launch and sending capacity. */
export const ENROLLED_BY_IMPORT: OutreachStatus = "queued";
