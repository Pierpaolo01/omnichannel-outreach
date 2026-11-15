import { useId, useState } from "react";
import { STATUS_GROUPS, type StatusGroup } from "../../domain/outreach-status.ts";
import type { CampaignMeasures } from "../../shared/api.ts";
import { Icon } from "../icons.tsx";
import { connectRateText, groupCountText, MEASURE_NOTES, measureRows, replyRateText } from "./measuresWording.ts";

/**
 * The campaign measures (ticket 22). **Provisional** (ADR 0003 Q33): variant A draws only the five group counts in a strip
 * under a running campaign's header; the per-channel figures and the rates are the most restrained form, one bordered
 * panel under it. Everything shown is the campaign's one read (`GET /api/campaigns/:id`, whose pause, status counts and
 * measures are one store snapshot), worded by `measuresWording.ts`; the page shows no figure from another read.
 */

const GROUP_TONE = {
  running: "text-ink-2",
  waiting_on_you: "text-you",
  handed_to_you: "text-hand",
  paused: "text-pause",
  ended: "text-end",
} as const satisfies Record<StatusGroup, string>;

/** Variant A's strip on a running campaign: the leads in each group, then the sentence on what goes out on its own. */
export function GroupStrip({ measures, sentence }: { measures: CampaignMeasures; sentence: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-box border border-line bg-base-100 px-4 py-3 text-[14px]">
      <ul aria-label="Leads in each status group" className="flex flex-wrap gap-x-[18px] gap-y-1.5">
        {STATUS_GROUPS.map((group) => (
          <li key={group} className={`inline-flex items-center gap-1.5 before:size-[7px] before:rounded-full before:bg-current before:content-[''] ${GROUP_TONE[group]}`}>
            <b className="font-semibold tabular-nums text-base-content">{measures.groups[group]}</b>
            {groupCountText(group)}
          </li>
        ))}
      </ul>
      <span className="text-[13.5px] text-muted">{sentence}</span>
    </div>
  );
}

/** "Outreach so far": per channel, then the two rates, then how each figure is counted. */
export function MeasuresPanel({ measures: m }: { measures: CampaignMeasures }) {
  const id = useId();
  const notesId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const reply = replyRateText(m.replyRate);
  const connect = connectRateText(m.connectRate);
  const callsOnly = m.channels.length > 0 && m.channels.every((c) => c === "call");
  const messagesOnly = !m.channels.includes("call");
  return (
    <section aria-labelledby={id} className="rounded-box border border-line bg-base-100 px-4 py-3 text-[14px]">
      <h2 id={id} className="text-[14px] font-semibold">
        Outreach so far
      </h2>
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1">
        {measureRows(m).map((row) => (
          <div key={row.channel} className="contents">
            <dt className="text-[13px] font-semibold text-muted">{row.label}</dt>
            <dd className="text-ink-2 [overflow-wrap:anywhere]">{row.line}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-3">
        {!callsOnly && (
          <div>
            <dt className="text-[13px] font-semibold text-muted">Reply rate</dt>
            <dd>
              <b className="font-semibold tabular-nums">{reply.figure}</b> <span className="text-ink-2">{reply.says}</span>
            </dd>
          </div>
        )}
        {!messagesOnly && (
          <div>
            <dt className="text-[13px] font-semibold text-muted">Connect rate</dt>
            <dd>
              <b className="font-semibold tabular-nums">{connect.figure}</b> <span className="text-ink-2">{connect.says}</span>
            </dd>
          </div>
        )}
      </dl>
      {/* A button disclosure, not <details>: a details element is a "group" to assistive technology, the role every page
          gives its in-page confirmation alone (ticket 17b), so a second group beside it would be ambiguous. */}
      <div className="mt-2 text-[13.5px]">
        <button type="button" aria-expanded={notesOpen} aria-controls={notesId} onClick={() => setNotesOpen((open) => !open)} className="inline-flex cursor-pointer items-center gap-1.5 text-muted hover:text-base-content">
          <Icon name="forward" className={`size-3.5 transition-transform ${notesOpen ? "rotate-90" : ""}`} />
          How these are counted
        </button>
        {notesOpen && (
          <ul id={notesId} className="mt-1.5 flex max-w-[72ch] list-disc flex-col gap-1 pl-5 text-ink-2">
            {MEASURE_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
