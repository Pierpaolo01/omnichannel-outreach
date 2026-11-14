import { useId, useState } from "react";
import type { ActivityEntry, ActivityView } from "../shared/api.ts";
import { useApi } from "./api.ts";
import { ErrorState, Section } from "./components.tsx";
import { OUTCOME_TITLE, dateIn, dialledLine } from "./calls/wording.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useNow } from "./time.ts";

/**
 * The record's Activity: one timeline across campaigns, newest first, as in the approved
 * daily-workspace prototype. Sent emails and texts expand to the copy that went; a reply shows its channel
 * and date only. Calls show each logged outcome with the number dialled and its note (ticket 14b).
 * The note box arrives with the ticket that adds notes.
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
  no_mobile: "No mobile of their own.",
  company_lead: "A company lead is never texted: a main line isn’t a mobile.",
  block_list: "The address is on Instantly’s block list.",
  "invalid address": "Instantly refused the address as invalid. It is marked wrong.",
  "invalid number": "The number was refused as invalid. It is marked wrong.",
};

const PLAIN = "bg-raised text-muted shadow-[inset_0_0_0_1px_var(--color-line)]";
const CRIT = "bg-crit-soft text-crit";
const HAND = "bg-hand-soft text-hand";
const CALL = "bg-call-soft text-call";

/** "the email track", "SMS track 2": a track label inside a sentence. */
const inSentence = (label: { label: string; several: boolean }) => (label.several ? label.label : `the ${label.label.startsWith("SMS") ? label.label : label.label.toLowerCase()}`);

/**
 * What one timeline entry says. `track` names the entry's track when its campaign has several on
 * that channel, so two email tracks never read alike (ticket 13b). Exported for its tests.
 */
export function describeEntry(entry: ActivityEntry): { icon: IconName; tone: string; title: string; body: string | null; track: string | null } {
  if (entry.kind === "replied")
    return {
      icon: "reply",
      tone: HAND,
      title: entry.channel === "email" ? "Replied by email" : "Replied by text",
      body: entry.channel === "email" ? "Automation stopped in this campaign. Read and answer the reply in Instantly." : "Automation stopped in this campaign. Answer the reply on your phone.",
      track: null,
    };
  if (entry.kind === "ended")
    return entry.status === "sequence_finished_no_response"
      ? { icon: "system", tone: PLAIN, title: "Sequence finished with no response", body: null, track: null }
      : { icon: "system", tone: PLAIN, title: "Finished, no usable channel", body: "Nothing is left to reach them on in this campaign.", track: null };
  if (entry.channel === "call") {
    const track = entry.track.several ? entry.track.label : null;
    switch (entry.kind) {
      case "call":
        // The number dialled and the call's note, after what the call did to the lead's calls (ticket 15b); a skip for now has no number.
        return { icon: "call", tone: CALL, title: OUTCOME_TITLE[entry.outcome], body: [callMeaning(entry), dialledLine(entry.number), entry.note.trim()].filter(Boolean).join(". ") || null, track };
      case "skipped":
        if (entry.reason === "unworked") {
          const limit = entry.limitDays === 1 ? "a day" : `${entry.limitDays} days`;
          return { icon: "system", tone: PLAIN, title: `${entry.track.label} skipped, not called`, body: `Not called within ${limit} of its due date, ${dateIn(localZone(), entry.dueAt)}, so the call was skipped. The tracks after it started.`, track: null };
        }
        return { icon: "system", tone: PLAIN, title: `${entry.track.label} skipped`, body: "No good number to call: every number is missing or marked wrong.", track: null };
      case "released":
        return { icon: "system", tone: PLAIN, title: `${entry.track.label} started`, body: `It starts after ${inSentence(entry.after)}, which ${releasedWhy(entry.because, entry.after.label)}.`, track: null };
      case "callback_overdue":
        return {
          icon: "bad",
          tone: CRIT,
          title: "Callback overdue",
          body: `They asked for ${at(entry.callbackAt, entry.zone)} their time. It stays on your call list, flagged overdue, and their automated outreach in this campaign stays held until you log what happened.`,
          track,
        };
    }
  }
  const sms = entry.channel === "sms";
  const noun = sms ? "Text" : "Email";
  const track = entry.track.several ? entry.track.label : null;
  const icon: IconName = sms ? "sms" : "email";
  switch (entry.kind) {
    case "sent":
      return { icon, tone: PLAIN, title: `${noun} ${entry.stepNumber} sent`, body: null, track };
    case "failed":
      return { icon: "bad", tone: CRIT, title: `${noun} ${entry.stepNumber} failed`, body: `${entry.to}: ${REASON[entry.reason] ?? entry.reason}`, track };
    case "skipped":
      return { icon: "system", tone: PLAIN, title: entry.stepNumber === null ? `${entry.track.label} skipped` : `${noun} ${entry.stepNumber} skipped`, body: REASON[entry.reason] ?? entry.reason, track: entry.stepNumber === null ? null : track };
    case "bounced":
      return sms
        ? { icon: "bad", tone: CRIT, title: entry.stepNumber === null ? "Bad number" : `Text ${entry.stepNumber}: bad number`, body: `${entry.to} was reported invalid and is marked wrong. Nothing more is texted to it.`, track }
        : { icon: "bad", tone: CRIT, title: entry.stepNumber === null ? "Email bounced" : `Email ${entry.stepNumber} bounced`, body: `${entry.to} is marked wrong. Nothing more is sent to it.`, track };
    case "address_bad":
      return { icon: "system", tone: PLAIN, title: `${entry.track.label} ended`, body: `${entry.to} is marked wrong, so nothing more is sent to it.`, track: null };
    case "released":
      return {
        icon: "system",
        tone: PLAIN,
        title: `${entry.track.label} started`,
        body: `It starts after ${inSentence(entry.after)}, which ${releasedWhy(entry.because, entry.after.label)}.`,
        track: null,
      };
  }
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeIn = (zone: string, iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** "Thu 5 Nov at 14:30" in the prospect's zone. */
const at = (iso: string, zone: string) => `${dateIn(zone, iso)} at ${timeIn(zone, iso)}`;

function releasedWhy(because: "skipped" | "failed" | "unworked", after: string): string {
  if (because === "unworked") return "was skipped: its call wasn’t made within its skip limit";
  return because === "skipped" ? "was skipped for this lead" : `ended on a bad ${after.startsWith("SMS") ? "number" : "address"}`;
}

/** What a logged call did to the lead's calls (ticket 15b): a redial, a callback asked for, or the callback it answered. */
function callMeaning(entry: Extract<ActivityEntry, { kind: "call"; channel: "call" }>): string | null {
  if (entry.outcome === "callback_requested" && entry.callbackAt !== null) {
    const lead = entry.onCallback === null ? "Call back" : "Callback moved to";
    return `${lead} ${at(entry.callbackAt, entry.zone)} their time; automated outreach in this campaign is held until its outcome is logged`;
  }
  if (entry.onCallback !== null) {
    return entry.outcome === "skip_for_now" ? `The callback for ${at(entry.onCallback, entry.zone)} their time stays open` : `The callback they asked for, ${at(entry.onCallback, entry.zone)} their time; its hold on automated outreach ended`;
  }
  return entry.redial ? "Redial asked for: back on the next day’s list, with its skip limit still counted from its due date" : null;
}

function Line({ entry }: { entry: ActivityEntry }) {
  const now = useNow();
  const { icon, tone, title, body, track } = describeEntry(entry);
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-line py-3 [&+&]:border-t">
      <span className={`grid size-8 place-items-center rounded-full ${tone}`}>
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0 pt-[5px] font-medium [overflow-wrap:anywhere]">
        {title}{" "}
        <span className="text-[13px] font-normal text-muted">
          {track ? `${track}, ` : ""}in {entry.campaign.name}
        </span>
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

export function when(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  if (at.toDateString() === now.toDateString()) return `Today, ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
  return `${day}, ${time}`;
}
