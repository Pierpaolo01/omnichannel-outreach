import { useEffect, useId } from "react";
import { STATUS_GROUPS, type StatusGroup } from "../../domain/outreach-status.ts";
import type { CampaignMeasures } from "../../shared/api.ts";
import { ErrorState } from "../components.tsx";
import type { LiveRead } from "../controls/useLiveRead.ts";
import { connectRateText, groupCountText, MEASURE_NOTES, measureRows, replyRateText } from "./measuresWording.ts";

/**
 * The campaign measures (ticket 22). **Provisional** (ADR 0003 Q32): variant A draws only the five group counts in a strip
 * under a running campaign's header; the per-channel figures and the rates are the most restrained form, one bordered
 * panel under it. Everything shown is the server's read, worded by `measuresWording.ts`.
 */

const GROUP_TONE = {
  running: "text-ink-2",
  waiting_on_you: "text-you",
  handed_to_you: "text-hand",
  paused: "text-pause",
  ended: "text-end",
} as const satisfies Record<StatusGroup, string>;

/** Variant A's strip on a running campaign: the leads in each group, then the sentence on what goes out on its own. */
export function GroupStrip({ read, sentence }: { read: LiveRead<CampaignMeasures>; sentence: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-box border border-line bg-base-100 px-4 py-3 text-[14px]">
      {read.state === "ready" ? (
        <ul aria-label="Leads in each status group" className="flex flex-wrap gap-x-[18px] gap-y-1.5">
          {STATUS_GROUPS.map((group) => (
            <li key={group} className={`inline-flex items-center gap-1.5 before:size-[7px] before:rounded-full before:bg-current before:content-[''] ${GROUP_TONE[group]}`}>
              <b className="font-semibold tabular-nums text-base-content">{read.data.groups[group]}</b>
              {groupCountText(group)}
            </li>
          ))}
        </ul>
      ) : read.state === "loading" ? (
        <span role="status" aria-label="Loading the leads in each status group" className="skeleton h-4 w-80 max-w-full" />
      ) : null}
      <span className="text-[13.5px] text-muted">{sentence}</span>
    </div>
  );
}

/** "Outreach so far": per channel, then the two rates, then how each figure is counted. */
export function MeasuresPanel({ read, onRetry }: { read: LiveRead<CampaignMeasures>; onRetry: () => void }) {
  const id = useId();
  if (read.state === "error") return <ErrorState title="The campaign’s figures didn’t load." message={read.message} onRetry={onRetry} />;
  if (read.state === "loading")
    return (
      <div role="status" aria-busy="true" aria-label="Loading the campaign’s figures" className="rounded-box border border-line bg-base-100 px-4 py-3">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton mt-3 h-4 w-full max-w-[520px]" />
        <div className="skeleton mt-2 h-4 w-full max-w-[420px]" />
      </div>
    );
  const m = read.data;
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
      <details className="mt-2 text-[13.5px]">
        <summary className="cursor-pointer text-muted hover:text-base-content">How these are counted</summary>
        <ul className="mt-1.5 flex max-w-[72ch] list-disc flex-col gap-1 pl-5 text-ink-2">
          {MEASURE_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** Reads the measures again whenever the campaign's own read does (a pause, a resume, a control elsewhere). */
export function useFollow(reads: number, refresh: () => Promise<void>): void {
  useEffect(() => {
    if (reads > 1) void refresh();
  }, [reads, refresh]);
}
