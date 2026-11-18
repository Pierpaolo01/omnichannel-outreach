import { OUTREACH_STATUSES, STATUS_GROUPS, statusGroup } from "../domain/outreach-status.ts";
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

/** The spec's five status groups, as every screen names them (ticket 18: one wording, with `statusGroup` the one grouping). */
export const STATUS_GROUP_LABEL = {
  running: "Running",
  waiting_on_you: "Waiting on you",
  handed_to_you: "Handed to you",
  paused: "Paused",
  ended: "Ended",
} as const satisfies Record<StatusGroup, string>;

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

/** A group's name beside its count, lower case as variant A's strip has it ("8 running"): the one wording of the strip and the Paused banner (ticket 22). */
export function groupCountText(group: StatusGroup): string {
  return STATUS_GROUP_LABEL[group].toLowerCase();
}

const GROUP_TONE = {
  running: "text-ink-2",
  waiting_on_you: "text-you",
  handed_to_you: "text-hand",
  paused: "text-pause",
  ended: "text-end",
} as const satisfies Record<StatusGroup, string>;

/**
 * The leads in each status group, as variant A draws them in its running strip and its paused banner (`.counts`): the count
 * in ink, then the group's name in its tone after a 7px dot. The one rendering of the five groups wherever counts are shown
 * (the campaign's strip and the Paused banner; council on 384630e, item 6).
 */
export function GroupCounts({ counts }: { counts: Readonly<Record<StatusGroup, number>> }) {
  return (
    <ul aria-label="Leads in each status group" className="flex flex-wrap gap-x-[18px] gap-y-1.5">
      {STATUS_GROUPS.map((group) => (
        <li key={group} className={`inline-flex items-center gap-1.5 before:size-[7px] before:rounded-full before:bg-current before:content-[''] ${GROUP_TONE[group]}`}>
          <b className="font-semibold tabular-nums text-base-content">{counts[group]}</b>
          {groupCountText(group)}
        </li>
      ))}
    </ul>
  );
}
