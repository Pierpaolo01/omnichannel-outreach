import { useEffect, useId, useRef, useState } from "react";
import { REPLY_WORDS } from "./controls/wording.ts";
import type { ActivityEntry, ActivityNote, ActivityView, DependentTrackState, NoteAnswer } from "../shared/api.ts";
import { ApiRequestError, postJson } from "./api.ts";
import { useLiveRead } from "./controls/useLiveRead.ts";
import { ErrorState, Section } from "./components.tsx";
import { DECLINED_PATH_LINE, OUTCOME_TITLE, dateIn, declineTrackLine, dialledLine } from "./calls/wording.ts";
import { dayLabel } from "./calls/callbackTime.ts";
import { Icon, type IconName } from "./icons.tsx";
import { lowerLabel, stepTitle } from "../shared/track-label.ts";
import { useNow, clockTime } from "./time.ts";
import { conversationTaken } from "./campaign/sms-wording.ts";

/**
 * The record's Activity: one timeline across campaigns, newest first, as in the approved
 * daily-workspace prototype. Sent emails and texts expand to the copy that went; a reply shows its channel
 * and date only. Calls show each logged outcome with the number dialled and its note (ticket 14b).
 * Ticket 18: the note box (a person note, or a company note shown for everyone at the company), and the record's notes on
 * the timeline, shown whatever campaign the filter picks, since a note belongs to no campaign.
 */
export function Activity({ path, reads, notes }: { path: string; reads: number; notes: NoteBoxProps }) {
  // Read live (ticket 17b), and again each time the record reads: a control's entry shows once it is applied.
  const { read: result, refresh } = useLiveRead<ActivityView>(path);
  const retry = () => void refresh();
  useEffect(() => {
    if (reads > 0) void refresh();
  }, [reads, refresh]);
  const [campaign, setCampaign] = useState("");
  const filterId = useId();
  const entries = result.state === "ready" ? result.data.entries : null;
  // Every day and time Activity says is in the user's zone as the server reads it, never the browser's (council on 32454ea, C).
  const userZone = result.state === "ready" ? result.data.userZone : null;
  const campaigns = entries ? [...new Map(entries.map((e) => [e.campaign.id, e.campaign.name])).entries()] : [];
  const shown = entries?.filter((e) => campaign === "" || e.campaign.id === campaign) ?? [];
  const noteRows = result.state === "ready" ? result.data.notes : [];
  const timeline: ({ kind: "entry"; at: string; entry: ActivityEntry } | { kind: "note"; at: string; note: ActivityNote })[] = [
    ...shown.map((entry) => ({ kind: "entry" as const, at: entry.at, entry })),
    ...noteRows.map((note) => ({ kind: "note" as const, at: note.at, note })),
  ].sort((a, b) => b.at.localeCompare(a.at));
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
      <NoteBox {...notes} onAdded={retry} storedIds={result.state === "ready" ? result.data.notes.map((n) => n.id) : null} />
      {result.state === "error" ? (
        <ErrorState title="The activity didn’t load." message={result.message} onRetry={retry} />
      ) : entries === null ? (
        <div role="status" aria-busy="true" aria-label="Loading the activity" className="flex flex-col gap-3 py-3">
          <div className="skeleton h-9 w-full" />
          <div className="skeleton h-9 w-full" />
        </div>
      ) : timeline.length === 0 ? (
        <p className="py-3 text-[14px] text-muted">Nothing has happened yet.</p>
      ) : (
        <ul className="mt-2">
          {timeline.map((row, i) =>
            userZone === null ? null : row.kind === "note" ? (
              <NoteLine key={row.note.id} note={row.note} userZone={userZone} />
            ) : (
              <Line key={`${row.at}-${i}`} entry={row.entry} userZone={userZone} />
            ),
          )}
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
  // LinkedIn (ticket 24b; ADR 0004 sections 3 and 5).
  no_profile: "No LinkedIn member profile in the import.",
  already_connected: "Your LinkedIn session was already connected to them, so no invite was needed.",
  "profile unreachable": "LinkedIn refused the profile as unreachable. It is marked wrong.",
  // Q37: the connection is gone (they removed it); the profile stays theirs and is not marked wrong.
  "not connected": "LinkedIn refused the message: they are no longer connected. The profile isn’t marked wrong.",
  // The InMail fallback (ticket 27; ADR 0004 13.3).
  "inmail refused": "LinkedIn refused the InMail for this person. The profile isn’t marked wrong.",
  inmail_instead: "Not sent: the InMail went instead.",
  accepted: "No InMail: they accepted the invite before it went.",
};

const PLAIN = "bg-raised text-muted shadow-[inset_0_0_0_1px_var(--color-line)]";
const CRIT = "bg-crit-soft text-crit";
const HAND = "bg-hand-soft text-hand";
const CALL = "bg-call-soft text-call";

/** "the email track", "SMS track 2": a track label inside a sentence. */
const inSentence = (label: { label: string; several: boolean }) => (label.several ? label.label : `the ${lowerLabel(label.label)}`);

/**
 * What one timeline entry says. `track` names the entry's track when its campaign has several on
 * that channel, so two email tracks never read alike (ticket 13b). Exported for its tests.
 */
export function describeEntry(entry: ActivityEntry, userZone: string): { icon: IconName; tone: string; title: string; body: string | null; track: string | null } {
  if (entry.kind === "replied")
    return {
      icon: "reply",
      tone: HAND,
      title: REPLY_WORDS[entry.channel].title,
      body: `Automation stopped in this campaign. ${REPLY_WORDS[entry.channel].activity}`,
      track: null,
    };
  if (entry.kind === "ended")
    return entry.status === "sequence_finished_no_response"
      ? { icon: "system", tone: PLAIN, title: "Sequence finished with no response", body: null, track: null }
      : { icon: "system", tone: PLAIN, title: "Finished, no usable channel", body: "Nothing is left to reach them on in this campaign.", track: null };
  // The controls the user applied (ticket 17b): what happened then, never a state since (a pause may still hold).
  if (entry.kind === "campaign_paused") return { icon: "system", tone: PLAIN, title: "Campaign paused", body: "Its calls left your list and its waits froze.", track: null };
  if (entry.kind === "campaign_resumed") return { icon: "system", tone: PLAIN, title: "Campaign resumed", body: null, track: null };
  if (entry.kind === "control") return controlEntry(entry);
  if (entry.channel === "call") {
    const track = entry.track.several ? entry.track.label : null;
    switch (entry.kind) {
      case "call":
        // What a decline did (its stored path, ticket 16, and each remaining track as the server's read holds it now, ticket 16c),
        // what the call did to the lead's calls (ticket 15b), the number dialled and the call's note; a skip for now has no number.
        return {
          icon: "call",
          tone: CALL,
          title: OUTCOME_TITLE[entry.outcome],
          body:
            [
              entry.declinedPath ? DECLINED_PATH_LINE[entry.declinedPath].slice(0, -1) : null,
              ...entry.afterDecline.map((a) => declineTrackLine(a, "record", userZone).slice(0, -1)),
              callMeaning(entry),
              dialledLine(entry.number),
              entry.note.trim(),
            ]
              .filter(Boolean)
              .join(". ") || null,
          track,
        };
      case "skipped":
        if (entry.reason === "unworked") {
          const limit = entry.limitDays === 1 ? "a day" : `${entry.limitDays} days`;
          // What each track after it has done at this read, from the server: never a start that has not happened (verifier on eac9f6c, F2).
          // An ended lead's track never starts; a held one has no day yet (council on 32454ea, D).
          const after = entry.after.map((a) => dependentLine(a, userZone));
          // The engine's own calendar date, said as a date: never re-derived from an instant (council on 32454ea, C).
          return { icon: "system", tone: PLAIN, title: `${entry.track.label} skipped, not called`, body: [`Not called within ${limit} of its due date, ${dayLabel(entry.dueDate)}, so the call was skipped.`, ...after].join(" "), track: null };
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
  // What a step is called comes from its track's label, so a win-back step reads "Win-back email 1" (council on 4fd9ca4, item 5),
  // and a LinkedIn step by its role, "Connection invite" (ticket 24b).
  const named = (n: number) => stepTitle(entry.track, entry.channel, n, entry.role);
  const track = entry.track.several ? entry.track.label : null;
  const icon: IconName = entry.channel === "linkedin" ? "linkedin" : sms ? "sms" : "email";
  switch (entry.kind) {
    case "sent":
      return { icon, tone: PLAIN, title: `${named(entry.stepNumber)} sent`, body: null, track };
    case "failed":
      return { icon: "bad", tone: CRIT, title: `${named(entry.stepNumber)} failed`, body: `${entry.to}: ${REASON[entry.reason] ?? entry.reason}`, track };
    case "skipped": {
      // A taken conversation names the campaign that keeps it (question Q7 answered), through the one wording function.
      const body = entry.reason === "sms_conversation_taken" ? `${conversationTaken(entry.owners ?? [], entry.channel).replace(/^t/, "T")}, so a reply couldn’t show which campaign it answers.` : (REASON[entry.reason] ?? entry.reason);
      return { icon: "system", tone: PLAIN, title: entry.stepNumber === null ? `${entry.track.label} skipped` : `${named(entry.stepNumber)} skipped`, body, track: entry.stepNumber === null ? null : track };
    }
    case "bounced":
      return sms
        ? { icon: "bad", tone: CRIT, title: entry.stepNumber === null ? "Bad number" : `${named(entry.stepNumber)}: bad number`, body: `${entry.to} was reported invalid and is marked wrong. Nothing more is texted to it.`, track }
        : { icon: "bad", tone: CRIT, title: entry.stepNumber === null ? "Email bounced" : `${named(entry.stepNumber)} bounced`, body: `${entry.to} is marked wrong. Nothing more is sent to it.`, track };
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

/** What a skipped call step was, from the server's record of its attempts then (council on 57d874f, item 8). */
function callSkipHistory(call: { readonly attempts: number; readonly callback: boolean } | null): string | null {
  if (call === null) return null;
  if (call.callback) return "No further call was made on this phone track.";
  return call.attempts > 0 ? "Its remaining attempts were skipped: no further call was made on this phone track." : "It was never made.";
}

/** One control the user applied, as history: the step it named is said by its track's own name for a step. */
function controlEntry(entry: Extract<ActivityEntry, { kind: "control" }>): { icon: IconName; tone: string; title: string; body: string | null; track: string | null } {
  const step = entry.step;
  const name = step === null ? null : step.channel === "call" ? (step.call?.callback ? "Callback" : "Call") : stepTitle(step.track, step.channel, step.number);
  const track = step?.track.several ? step.track.label : null;
  const at = name === null ? null : name === "Call" ? "the call" : name.charAt(0).toLowerCase() + name.slice(1);
  const plain = (title: string, body: string | null = null) => ({ icon: "system" as const, tone: PLAIN, title, body, track });
  switch (entry.action) {
    case "pause":
      return plain("Paused by you", "Their waits froze.");
    case "resume":
      return plain("Resumed by you");
    case "skip":
      return plain(`${name ?? "Step"} skipped by you`, step?.channel === "call" ? callSkipHistory(step.call) : "It was never sent.");
    case "stop":
      return plain("Stopped by you");
    case "resume_from_next_step":
      return plain("Resumed from the next step by you", at ? `They resumed at ${at}.` : null);
    case "move_to_win_back":
      return plain("Moved to win-back by you", `Their remaining main-sequence steps were dropped${at ? `, and they started at ${at}` : ""}.`);
    default: {
      const unhandled: never = entry.action;
      throw new Error(`A control with no timeline entry: ${String(unhandled)}`);
    }
  }
}

const timeIn = (zone: string, iso: string) => clockTime(zone, iso);
/** "Thu 5 Nov at 14:30" in the prospect's zone. */
const at = (iso: string, zone: string) => `${dateIn(zone, iso)} at ${timeIn(zone, iso)}`;

function releasedWhy(because: "skipped" | "failed" | "unworked", after: string): string {
  if (because === "unworked") return "was skipped: its call wasn’t made within its skip limit";
  return because === "skipped" ? "was skipped for this lead" : `ended on a bad ${after.startsWith("SMS") ? "number" : "address"}`;
}

/**
 * What Activity says of a track that starts after an unworked skip, from the state the server read (verifier on
 * 2027f24): one sentence per state, in an exhaustive switch, so a state a later ticket adds fails typecheck until it
 * has one. Only `waiting` and `held` say the track will start, because the server read says so.
 */
export function dependentLine(a: { readonly track: { readonly label: string } } & DependentTrackState, userZone: string): string {
  const name = a.track.label;
  switch (a.state) {
    case "started":
      return `${name} started after it.`;
    case "finished":
      return `${name} has finished.`;
    case "waiting":
      return `${name} starts after its delay, on ${dateIn(userZone, a.startsAt)}.`;
    case "held":
      return `${name} starts after its delay, once their outreach is no longer held.`;
    case "dropped_for_win_back":
      return `${name} will not start: they moved to this campaign’s win-back branch.`;
    case "skipped_declined":
      return `${name} was skipped: they declined on a call.`;
    case "skipped_unworked":
      return `${name} was skipped: its call wasn’t made within its skip limit.`;
    case "skipped_no_channel":
      return `${name} was skipped: there is nothing to reach them on for it.`;
    case "skipped_conversation_taken":
      return `${name} was skipped: ${conversationTaken(a.owners, a.channel)}.`;
    case "skipped":
      return `${name} was skipped.`;
    case "stopped":
      return `${name} did not start: their outreach in this campaign stopped.`;
    case "stopped_after_start":
      return `${name} started after it, then stopped: their outreach in this campaign stopped.`;
    case "started_held":
      return `${name} started after it, and is waiting while their outreach is held.`;
    case "no_more_calls":
      return `${name} will not call them: they declined on a call.`;
    case "not_started":
      return `${name} has not started.`;
    default: {
      const unhandled: never = a;
      throw new Error(`A track state Activity has no sentence for: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * What a logged call did to the lead's calls (ticket 15b): a redial, a callback asked for, or the callback it answered.
 * History, in the past tense; a present state (a callback still open and holding outreach) only when the server's read
 * says so (`callbackPending` and `callbackListed`, verifier re-check H; ticket 22), and a day only from the server (`redialListedFrom`, council C).
 */
function callMeaning(entry: Extract<ActivityEntry, { kind: "call"; channel: "call" }>): string | null {
  if (entry.outcome === "callback_requested" && entry.callbackAt !== null) {
    const asked = `${entry.onCallback === null ? "Callback asked for" : "Callback moved to"}, ${at(entry.callbackAt, entry.zone)} their time`;
    // Pending and listed are two facts of the server's read (ticket 22, verifier F2): a paused lead's callback is pending
    // (the campaign's figures count it) but off the list.
    if (!entry.callbackPending) return asked;
    return entry.callbackListed ? `${asked}; their automated outreach in this campaign is held until you log how it went` : `${asked}; still pending, and off your call list while their outreach is paused`;
  }
  if (entry.onCallback !== null) {
    return entry.outcome === "skip_for_now" ? `Skipped for now on the callback for ${at(entry.onCallback, entry.zone)} their time` : `The callback they asked for, ${at(entry.onCallback, entry.zone)} their time; its hold on automated outreach ended`;
  }
  if (!entry.redial) return null;
  return entry.redialListedFrom ? `Redial asked for: listed again from ${dayLabel(entry.redialListedFrom)}` : "Redial asked for";
}

function Line({ entry, userZone }: { entry: ActivityEntry; userZone: string }) {
  const now = useNow();
  const { icon, tone, title, body, track } = describeEntry(entry, userZone);
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
        {when(entry.at, now, userZone)}
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

/** A note on the timeline: a person's own, or a company note, which shows for everyone at the company. */
function NoteLine({ note, userZone }: { note: ActivityNote; userZone: string }) {
  const now = useNow();
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-line py-3 [&+&]:border-t">
      <span className="grid size-8 place-items-center rounded-full bg-pause-soft text-pause">
        <Icon name="file" className="size-4" />
      </span>
      <div className="min-w-0 pt-[5px] font-medium">{note.scope === "company" ? "Company note" : "Note"}</div>
      <time dateTime={note.at} className="whitespace-nowrap pt-1.5 text-right text-[13px] text-muted">
        {when(note.at, now, userZone)}
      </time>
      <div className="col-start-2 col-end-4 mt-[3px] min-w-0 whitespace-pre-wrap text-[14px] text-ink-2 [overflow-wrap:anywhere]">{note.body}</div>
    </li>
  );
}

const NOTE_MAX = 10_000;

/** Whose record the note box is on: a person (person note, or a company note) or a company lead (company notes only). */
export type NoteBoxProps = { readonly kind: "person"; readonly path: string; readonly firstName: string; readonly company: string } | { readonly kind: "company"; readonly path: string; readonly company: string };

type NoteSend = { readonly requestId: string; readonly body: string; readonly scope: "person" | "company" };

/** A failed note send: refused by the server (a definite 4xx answer), or no answer, when it may have been stored. */
export function noteSendFailure(error: unknown): "refused" | "no_answer" {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500 ? "refused" : "no_answer";
}

/**
 * The press of Add note (review bot on 9daf7c0): the unchanged note of a send that had no answer keeps its request id, so
 * the server stores it once whether the first send arrived or not; a changed note or scope is a new note.
 */
export function nextNotePress(unanswered: NoteSend | null, text: string, scope: NoteSend["scope"], newId: () => string): NoteSend {
  const body = text.trim();
  return unanswered !== null && unanswered.body === body && unanswered.scope === scope ? unanswered : { requestId: newId(), body, scope };
}

/**
 * The prototype's note box: a note about the person, or, ticked, a company note shown for everyone at the company. A
 * company lead's notes are company notes. The request id is fixed at the press, so Try again stores the note once.
 */
function NoteBox(props: NoteBoxProps & { onAdded: () => void; /** The ids of the notes the record's last read holds. */ storedIds: readonly string[] | null }) {
  const fieldId = useId();
  const shareId = useId();
  const [text, setText] = useState("");
  const [share, setShare] = useState(props.kind === "company");
  const [sending, setSending] = useState<NoteSend | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "saved"; scope: "person" | "company" } | { kind: "failed"; message: string } | { kind: "unconfirmed" }>({ kind: "idle" });
  const field = useRef<HTMLTextAreaElement | null>(null);
  const statusRef = useRef<HTMLElement | null>(null);
  const tooLong = text.length > NOTE_MAX;
  const send = (press: NoteSend) => {
    setSending(press);
    setState({ kind: "saving" });
    const body = props.kind === "company" ? { requestId: press.requestId, body: press.body } : press;
    postJson(`${props.path}/notes`, body)
      .then((answer) => {
        const { note } = answer as NoteAnswer;
        setSending(null);
        setText((t) => (t === press.body ? "" : t));
        setState({ kind: "saved", scope: note.scope });
        props.onAdded();
      })
      .catch((e: unknown) => {
        // Only the server's refusal says the note was not added; with no answer it may be stored (verifier F1 on 4363270).
        if (noteSendFailure(e) === "refused") setState({ kind: "failed", message: e instanceof Error ? e.message : "" });
        else {
          setState({ kind: "unconfirmed" });
          props.onAdded();
        }
      });
  };
  // A send with no answer is settled by the next read that holds it: the note was added, once.
  const { storedIds } = props;
  if (state.kind === "unconfirmed" && sending && storedIds?.includes(`record-note:${sending.requestId}`)) {
    setState({ kind: "saved", scope: sending.scope });
    setSending(null);
    if (text.trim() === sending.body) setText("");
  }
  useEffect(() => {
    if (state.kind === "saved" || state.kind === "failed" || state.kind === "unconfirmed") statusRef.current?.focus();
  }, [state]);
  const setStatusRef = (el: HTMLElement | null) => {
    statusRef.current = el;
  };
  const saving = state.kind === "saving";
  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-box border border-line bg-base-100 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (saving || tooLong || text.trim() === "") return;
        send(nextNotePress(sending, text, props.kind === "company" || share ? "company" : "person", () => crypto.randomUUID()));
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        {props.kind === "person" ? `A note about ${props.firstName}` : `A note about ${props.company}`}
      </label>
      <textarea
        id={fieldId}
        ref={field}
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={saving}
        rows={2}
        placeholder={props.kind === "person" ? `Add a note about ${props.firstName}` : `Add a note about ${props.company}`}
        aria-describedby={tooLong ? `${fieldId}-long` : undefined}
        className="textarea min-h-[64px] w-full resize-y border-line-strong bg-base-100 text-[14.5px] focus:border-call focus:outline-none"
      />
      {tooLong && (
        <p id={`${fieldId}-long`} className="text-[13px] text-crit">
          A note can be at most 10,000 characters. This one has {text.length.toLocaleString("en-GB")}.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {props.kind === "person" ? (
          <label htmlFor={shareId} className="flex items-start gap-2 text-[14px] text-ink-2">
            <input id={shareId} type="checkbox" className="checkbox checkbox-sm mt-0.5 border-line-strong checked:border-call checked:bg-call checked:text-base-100" checked={share} disabled={saving} onChange={(e) => setShare(e.target.checked)} />
            <span>Show for everyone at {props.company}</span>
          </label>
        ) : (
          <p className="text-[13px] text-muted">Notes on a company lead are company notes, shown for everyone at {props.company}.</p>
        )}
        <button type="submit" className="btn btn-sm border-line-strong bg-base-100 font-medium" disabled={saving || tooLong || text.trim() === ""}>
          {saving ? "Adding…" : "Add note"}
        </button>
      </div>
      {state.kind === "saved" && (
        <p role="status" tabIndex={-1} ref={setStatusRef} className="rounded-field bg-you-soft px-3 py-2 text-[14px] text-base-content outline-offset-2">
          {state.scope === "company" ? `Company note added. It shows for everyone at ${props.company}.` : "Note added."}
        </p>
      )}
      {state.kind === "unconfirmed" && sending && (
        <div role="status" tabIndex={-1} ref={setStatusRef} className="flex flex-wrap items-center gap-3 rounded-field bg-pause-soft px-3 py-2 text-[14px] outline-offset-2">
          <span className="min-w-0 flex-[1_1_240px] text-base-content">
            <b className="font-semibold">Not confirmed yet.</b> The server didn’t answer, so the note may already be saved. Trying again sends the same note, and it is added only once.
          </span>
          <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => send(sending)}>
            Try again
          </button>
        </div>
      )}
      {state.kind === "failed" && sending && (
        <div role="alert" tabIndex={-1} ref={setStatusRef} className="flex flex-wrap items-center gap-3 rounded-field bg-crit-soft px-3 py-2 text-[14px] outline-offset-2">
          <span className="min-w-0 flex-[1_1_240px]">
            <b className="font-semibold text-crit">The note wasn’t added.</b> <span className="text-ink-2">{state.message}</span>
          </span>
          <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => send(sending)}>
            Try again
          </button>
        </div>
      )}
    </form>
  );
}

/** "Today, 10:00" or "Mon 9 Nov, 10:00", in `zone`: the user's, as the server reads it (council on 32454ea, C). */
export function when(iso: string, now: Date, zone: string): string {
  const date = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const at = new Date(iso);
  const time = clockTime(zone, at);
  if (date(at) === date(now)) return `Today, ${time}`;
  return `${dateIn(zone, iso)}, ${time}`;
}
