import { useId, useState } from "react";
import type { ActivityEntry, ActivityView } from "../shared/api.ts";
import { useApi } from "./api.ts";
import { ErrorState, Section } from "./components.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { useNow } from "./time.ts";

/**
 * The record's Activity: one timeline across campaigns, newest first, as in the approved
 * daily-workspace prototype. Sent emails expand to the copy that went; a reply shows its channel
 * and date only. The note box arrives with the ticket that adds notes.
 */
export function Activity({ path }: { path: string }) {
  const { result, retry } = useApi<ActivityView>(path);
  const [campaign, setCampaign] = useState("");
  const filterId = useId();
  const entries = result.state === "ready" ? result.data.entries : null;
  const campaigns = entries ? [...new Map(entries.map((e) => [e.campaign.id, e.campaign.name])).entries()] : [];
  const shown = entries?.filter((e) => campaign === "" || e.campaign.id === campaign) ?? [];
  return (
    <Section
      title="Activity"
      aside={
        campaigns.length > 1 ? (
          <span className="flex items-center gap-2">
            <label htmlFor={filterId} className="sr-only">
              Show activity from
            </label>
            <select id={filterId} className="select select-sm border-line-strong" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">All campaigns</option>
              {campaigns.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </span>
        ) : undefined
      }
    >
      {result.state === "error" ? (
        <ErrorState title="The activity didn’t load." message={result.message} onRetry={retry} />
      ) : entries === null ? (
        <div role="status" aria-busy="true" aria-label="Loading the activity" className="flex flex-col gap-3 py-3">
          <div className="skeleton h-9 w-full" />
          <div className="skeleton h-9 w-full" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-3 text-[14px] text-muted">Nothing has happened yet.</p>
      ) : (
        <ul>
          {shown.map((entry, i) => (
            <Line key={`${entry.at}-${i}`} entry={entry} />
          ))}
        </ul>
      )}
    </Section>
  );
}

const REASON: Readonly<Record<string, string>> = {
  no_email: "No email address.",
  block_list: "The address is on Instantly’s block list.",
  "invalid address": "Instantly refused the address as invalid. It is marked wrong.",
};

const PLAIN = "bg-raised text-muted shadow-[inset_0_0_0_1px_var(--color-line)]";
const CRIT = "bg-crit-soft text-crit";
const HAND = "bg-hand-soft text-hand";

/** What one timeline entry says. Exported for its tests. */
export function describeEntry(entry: ActivityEntry): { icon: IconName; tone: string; title: string; body: string | null } {
  switch (entry.kind) {
    case "sent":
      return { icon: "email", tone: PLAIN, title: `Email ${entry.stepNumber} sent`, body: null };
    case "failed":
      return { icon: "bad", tone: CRIT, title: `Email ${entry.stepNumber} failed`, body: `${entry.to}: ${REASON[entry.reason] ?? entry.reason}` };
    case "skipped":
      return { icon: "system", tone: PLAIN, title: entry.stepNumber === null ? "Email skipped" : `Email ${entry.stepNumber} skipped`, body: REASON[entry.reason] ?? entry.reason };
    case "bounced":
      return { icon: "bad", tone: CRIT, title: entry.stepNumber === null ? "Email bounced" : `Email ${entry.stepNumber} bounced`, body: `${entry.to} is marked wrong. Nothing more is sent to it.` };
    case "address_bad":
      return { icon: "system", tone: PLAIN, title: "Email track ended", body: `${entry.to} is marked wrong, so nothing more is sent to it.` };
    case "replied":
      return {
        icon: "reply",
        tone: HAND,
        title: entry.channel === "email" ? "Replied by email" : "Replied by text",
        body: entry.channel === "email" ? "Automation stopped in this campaign. Read and answer the reply in Instantly." : "Automation stopped in this campaign. Answer the reply on your phone.",
      };
    case "ended":
      return entry.status === "sequence_finished_no_response"
        ? { icon: "system", tone: PLAIN, title: "Sequence finished with no response", body: null }
        : { icon: "system", tone: PLAIN, title: "Finished, no usable channel", body: "Nothing is left to reach them on in this campaign." };
  }
}

function Line({ entry }: { entry: ActivityEntry }) {
  const now = useNow();
  const { icon, tone, title, body } = describeEntry(entry);
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-line py-3 [&+&]:border-t">
      <span className={`grid size-8 place-items-center rounded-full ${tone}`}>
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0 pt-[5px] font-medium [overflow-wrap:anywhere]">
        {title} <span className="text-[13px] font-normal text-muted">in {entry.campaign.name}</span>
      </div>
      <time dateTime={entry.at} className="whitespace-nowrap pt-1.5 text-right text-[13px] text-muted">
        {when(entry.at, now)}
      </time>
      {(body || (entry.kind === "sent" && entry.copy)) && (
        <div className="col-start-2 col-end-4 min-w-0">
          {body && <div className="mt-[3px] text-[14px] text-ink-2 [overflow-wrap:anywhere]">{body}</div>}
          {entry.kind === "sent" && entry.copy && (
            <details className="group">
              <summary className="mt-1 w-fit cursor-pointer list-none text-[13px] text-muted underline decoration-line-strong underline-offset-[3px] [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">Show message</span>
                <span className="hidden group-open:inline">Hide message</span>
              </summary>
              <div className="mt-2 whitespace-pre-wrap rounded-field bg-raised px-3.5 py-3 text-[14px] leading-[1.55] text-ink-2 [overflow-wrap:anywhere]">
                <span className="mb-1 block text-[12.5px] text-muted">
                  From {entry.from} to {entry.to}
                </span>
                {entry.copy.subject && <span className="mb-2 block font-semibold text-base-content">{entry.copy.subject}</span>}
                {entry.copy.body}
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

function when(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  if (at.toDateString() === now.toDateString()) return `Today, ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
  return `${day}, ${time}`;
}
