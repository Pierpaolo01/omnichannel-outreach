import { OUTREACH_STATUSES, statusGroup } from "../domain/outreach-status.ts";
import type { OutreachStatus, StatusGroup } from "../shared/api.ts";

/** Status names as the prototype and the spec word them. */
export const STATUS_LABEL = {
  queued: "Queued",
  active: "Active",
  in_win_back: "In win-back",
  waiting_on_call: "Waiting on call",
  callback_scheduled: "Callback scheduled",
  replied: "Replied, automation stopped",
  interested_on_call: "Interested on call, automation stopped",
  paused: "Paused",
  declined_on_call: "Declined on call",
  stopped_manually: "Stopped manually",
  sequence_finished_no_response: "Sequence finished, no response",
  finished_no_usable_channel: "Finished, no usable channel",
} as const satisfies Record<OutreachStatus, string>;

export const STATUS_OPTIONS = OUTREACH_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }));

const GROUP_STYLE = {
  running: "text-ink-2 bg-raised shadow-[inset_0_0_0_1px_var(--color-line)] before:bg-current",
  waiting_on_you: "text-you bg-you-soft before:bg-current",
  handed_to_you: "text-hand bg-hand-soft before:bg-current",
  paused: "text-pause bg-pause-soft before:bg-current",
  ended: "text-end bg-end-soft before:shadow-[inset_0_0_0_1.5px_currentColor]",
} as const satisfies Record<StatusGroup, string>;

export function StatusBadge({ status }: { status: OutreachStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] py-0.5 pl-[7px] pr-2 text-[13px] font-medium before:size-[7px] before:rounded-full before:content-[''] ${GROUP_STYLE[statusGroup(status)]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
