import { useId, useRef, type ReactNode } from "react";
import { Link } from "wouter";
import type { CallColleagueView, CallOutcomeApi, CallQueueItem, CallsView, CallTaskView, NoteView, TouchView } from "../../shared/api.ts";
import { when } from "../activity.tsx";
import { CallDesk, NOTE_MAX, whoOf, type DeskSnapshot } from "../calls/callDesk.ts";
import { useCallDesk } from "../calls/useCallDesk.ts";
import {
  CAPACITY_USED,
  OUTCOME_LABEL,
  OUTCOME_TITLE,
  callingHoursLine,
  capacityLine,
  clockLine,
  dialledLine,
  loggedLine,
  numberKind,
  numberProblemLine,
  offListLine,
  pendingLine,
  reasonLine,
  recoveringLine,
  refusedRecordLine,
} from "../calls/wording.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { StatusBadge } from "../status.tsx";
import { useNow } from "../time.ts";

/** The outcomes this release offers, in the prototype's order. Callback requested and not interested arrive later. */
const OFFERED: readonly CallOutcomeApi[] = ["no_answer", "voicemail", "gatekeeper", "wrong_number", "interested", "skip_for_now"];

const TONE = { muted: "text-muted", pause: "text-pause", crit: "text-crit" } as const;

/** Calls: one focused call with the whole queue beside it (ADR 0003 4.4.1). */
export function CallsPage() {
  const { desk, snap } = useCallDesk();
  const placeFocus = useKeyboardFocus(snap);
  const queue = snap.queue;
  return (
    <div className="grid grid-cols-1 items-start gap-7 min-[901px]:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)]">
      <Queue snap={snap} />
      <div className="flex min-w-0 flex-col gap-3">
        <Status snap={snap} />
        <Records desk={desk} snap={snap} />
        {queue.state === "error" ? (
          <ErrorState title="The call list didn’t load." message={queue.message} onRetry={() => void desk.refresh()} />
        ) : queue.state === "loading" ? (
          <SheetSkeleton />
        ) : snap.focus === null ? (
          <NothingToCall view={queue.view} listDone={snap.logged !== null} placeFocus={placeFocus} />
        ) : snap.task === null || snap.task.state === "loading" ? (
          <SheetSkeleton />
        ) : snap.task.state === "error" ? (
          <ErrorState title="This call didn’t load." message={snap.task.message} onRetry={() => void desk.refresh()} retryRef={(el) => placeFocus(el, "error")} />
        ) : (
          <Sheet desk={desk} snap={snap} task={snap.task.view} userZone={queue.view.userZone} placeFocus={placeFocus} />
        )}
      </div>
    </div>
  );
}

/**
 * Where keyboard focus goes after a transition that replaces the controls under it: an outcome logged
 * (the next call's number, or the empty state's link), the queue moving on, a refusal (Open the next
 * call, or the number to choose again). A focus found gone on a refresh moves it only if the control
 * that had it is now locked.
 */
function useKeyboardFocus(snap: DeskSnapshot): (el: HTMLElement | null, role: "next" | "away" | "number" | "empty" | "error") => void {
  const handled = useRef<number | null>(null);
  const want = snap.transition;
  return (el, role) => {
    if (!el || !want || handled.current === want.seq) return;
    const matches =
      ((want.kind === "logged" || want.kind === "moved") && (role === "number" || role === "empty" || role === "error")) ||
      (want.kind === "refused" && (role === "away" || (role === "number" && snap.away === null))) ||
      (want.kind === "away" && role === "away" && (document.activeElement === document.body || document.activeElement?.closest("[data-locks]") !== null));
    if (!matches) return;
    handled.current = want.seq;
    el.focus({ preventScroll: false });
  };
}

function Status({ snap }: { snap: DeskSnapshot }) {
  const text = snap.pending ? pendingLine(snap.pending) : snap.logged ? loggedLine(snap.logged) : "";
  return (
    <>
      <p role="status" className={text ? `rounded-field px-4 py-2.5 text-[14px] ${snap.pending?.unconfirmed ? "bg-pause-soft text-base-content" : "bg-you-soft text-base-content"}` : "sr-only"}>
        {text}
      </p>
      <div aria-live="polite" className={snap.recovering.length > 0 ? "flex flex-col gap-1.5" : "sr-only"}>
        {snap.recovering.map((e) => (
          <p key={e.body.requestId} className="rounded-field bg-pause-soft px-4 py-2.5 text-[14px] text-base-content">
            {recoveringLine(e.who)}
          </p>
        ))}
      </div>
    </>
  );
}

/** Refusals no page showed on its call: kept, with the note typed, until the user dismisses them. */
function Records({ desk, snap }: { desk: CallDesk; snap: DeskSnapshot }) {
  if (snap.refusedRecords.length === 0) return null;
  return (
    <ul aria-label="Outcomes not logged" className="flex flex-col gap-2">
      {snap.refusedRecords.map((r) => (
        <li key={r.entry.body.requestId} className="flex flex-col gap-2 rounded-field bg-crit-soft px-4 py-3 text-[14px]">
          <p role="alert" className="text-base-content [overflow-wrap:anywhere]">
            {refusedRecordLine(r)}
          </p>
          {r.entry.body.note.trim() !== "" && (
            <p className="text-ink-2 [overflow-wrap:anywhere]">
              Your note wasn’t saved: <q className="whitespace-pre-wrap">{r.entry.body.note}</q>
            </p>
          )}
          <div>
            <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => desk.dismiss(r.entry.body.requestId)}>
              Dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Queue({ snap }: { snap: DeskSnapshot }) {
  const view = snap.queue.state === "ready" ? snap.queue.view : null;
  const item = (x: CallQueueItem) => <QueueItem key={x.taskId} item={x} current={x.taskId === snap.focus} userZone={view?.userZone ?? "UTC"} />;
  return (
    <aside aria-label="Call queue" className="min-[901px]:sticky min-[901px]:top-6">
      <h2 className="mb-1.5 ml-2.5 text-[13px] font-semibold text-muted">Ready now, {view ? view.readyNow.length : "…"}</h2>
      {view && view.readyNow.length > 0 ? <ol className="mb-[22px] flex flex-col gap-0.5">{view.readyNow.map(item)}</ol> : <p className="mb-[22px] px-2.5 text-[12.5px] leading-[1.45] text-faint">{view ? "Nothing to call right now." : "Loading the list."}</p>}
      <h2 className="mb-1.5 ml-2.5 text-[13px] font-semibold text-muted">Later today, {view ? view.laterToday.length : "…"}</h2>
      {view && view.laterToday.length > 0 ? <ol className="mb-[22px] flex flex-col gap-0.5">{view.laterToday.map(item)}</ol> : <p className="mb-[22px] px-2.5 text-[12.5px] leading-[1.45] text-faint">{view ? "Nothing else today." : "Loading the list."}</p>}
      <p className="px-2.5 text-[12.5px] leading-[1.45] text-faint">Calls inside the prospect’s calling hours come first, oldest first. The next call opens when you log an outcome.</p>
      {view && (
        <p className="mt-2 px-2.5 text-[12.5px] leading-[1.45] text-faint">
          {capacityLine(view)}
          {view.capacityReached ? ` ${CAPACITY_USED}` : ""}
        </p>
      )}
    </aside>
  );
}

function QueueItem({ item, current, userZone }: { item: CallQueueItem; current: boolean; userZone: string }) {
  const why = reasonLine(item, userZone);
  return (
    <li
      aria-current={current ? "true" : undefined}
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-px rounded-field p-2.5 ${current ? "bg-base-100 shadow-[inset_3px_0_0_var(--color-call),0_0_0_1px_var(--color-line)]" : ""}`}
    >
      <span className="truncate font-semibold">{item.person?.name ?? item.company.name}</span>
      <span className="text-right text-[13px] text-muted">{item.localTime}</span>
      <span className="truncate text-[13px] text-muted">{item.company.name}</span>
      <span />
      <span className={`col-span-2 mt-[3px] text-[12.5px] font-medium ${TONE[why.tone]}`}>
        {current && <span className="sr-only">On this call. </span>}
        {why.text}
      </span>
    </li>
  );
}

function SheetSkeleton() {
  return (
    <section role="status" aria-busy="true" aria-label="Loading the call" className="overflow-clip rounded-box border border-line bg-base-100">
      <div className="flex flex-col gap-3 bg-band px-[30px] pb-7 pt-[26px]">
        <div className="skeleton h-4 w-56 bg-band-muted/30" />
        <div className="skeleton h-11 w-80 max-w-full bg-band-muted/30" />
        <div className="skeleton h-7 w-64 max-w-full bg-band-muted/30" />
      </div>
      <div className="flex flex-col gap-3 px-[30px] py-6">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-16 w-full" />
      </div>
    </section>
  );
}

function NothingToCall({ view, listDone, placeFocus }: { view: CallsView; listDone: boolean; placeFocus: ReturnType<typeof useKeyboardFocus> }) {
  const later = view.laterToday[0];
  const lines: string[] = [];
  if (listDone) lines.push("Every call ready now has an outcome.");
  if (later) lines.push(`${view.laterToday.length === 1 ? "One call opens" : `${view.laterToday.length} calls open`} later today. ${reasonLine(later, view.userZone).text}.`);
  if (view.capacityReached) lines.push(CAPACITY_USED);
  if (lines.length === 0) lines.push("Calls appear here once a launched campaign reaches a call step. You place every call yourself.");
  return (
    <section aria-labelledby="calls-empty" className="overflow-clip rounded-box border border-line bg-base-100">
      <div className="bg-band px-[30px] pb-7 pt-[26px] text-band-ink">
        <h1 id="calls-empty" className="text-[34px] leading-[1.05] tracking-[-0.03em]">
          {listDone ? "List done" : "Nothing to call right now"}
        </h1>
        {lines.map((l) => (
          <p key={l} className="mt-1.5 max-w-[60ch] text-[16px] text-band-muted">
            {l}
          </p>
        ))}
      </div>
      <div className="px-[30px] py-6">
        <Link href="/" ref={(el: HTMLAnchorElement | null) => placeFocus(el, "empty")} className="btn border-line-strong bg-base-100 font-medium">
          Back to Today
        </Link>
      </div>
    </section>
  );
}

function Sheet({ desk, snap, task, userZone, placeFocus }: { desk: CallDesk; snap: DeskSnapshot; task: CallTaskView; userZone: string; placeFocus: ReturnType<typeof useKeyboardFocus> }) {
  const who = whoOf(task);
  const recordHref = task.person ? `/leads/people/${task.person.id}` : `/leads/companies/${task.company.id}`;
  const clock = clockLine(task, userZone);
  const numbersId = useId();
  return (
    <section aria-label={`Call with ${who}`} className="overflow-clip rounded-box border border-line bg-base-100">
      <div className="bg-band px-5 pb-7 pt-[26px] text-band-ink min-[901px]:px-[30px]">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-band-muted [overflow-wrap:anywhere]">
              {task.campaign.name}, {task.track.label.toLowerCase()}
            </p>
            <h1 className="mt-2.5 text-[32px] leading-[1.05] tracking-[-0.03em] [overflow-wrap:anywhere] min-[901px]:text-[44px]">
              <Link href={recordHref} className="no-underline decoration-2 underline-offset-[6px] hover:underline">
                {who}
              </Link>
            </h1>
            <p className="mt-1.5 text-[16px] text-band-muted">
              {task.person ? (
                <>
                  {task.person.title ? `${task.person.title} at ` : ""}
                  <b className="font-medium text-band-ink">{task.company.name}</b>
                </>
              ) : (
                "Company with no named decision maker"
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[34px] font-medium leading-none tracking-[-0.02em]">{task.localTime}</div>
            <div className={`mt-1.5 text-[13px] ${clock.tone === "ok" ? "text-band-ok" : clock.tone === "warn" ? "text-band-warn" : "text-band-muted"}`}>{clock.text}</div>
            <div className="mt-0.5 text-[13px] text-band-muted">Calling hours {callingHoursLine(task.callingHours)}</div>
          </div>
        </div>
        <fieldset className="mt-6" aria-describedby={`${numbersId}-hint`} data-locks="">
          <legend className="sr-only">Number you dial</legend>
          {task.numbers.length === 0 ? (
            <p className="text-[15px] text-band-muted">No number on record.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {task.numbers.map((n, i) => {
                const primary = i === task.numbers.findIndex((x) => !x.bad);
                const checked = snap.draft.numberId === n.detailId;
                return (
                  <label key={n.detailId} className={`flex flex-wrap items-center gap-x-3.5 gap-y-1 ${n.bad ? "" : "cursor-pointer"}`}>
                    <input
                      type="radio"
                      name="dialled-number"
                      ref={checked ? (el) => placeFocus(el, "number") : undefined}
                      className="size-4 accent-[var(--color-call)]"
                      checked={checked}
                      disabled={n.bad || snap.locked}
                      onChange={() => desk.setDraft({ numberId: n.detailId })}
                    />
                    <span className={`${primary ? "text-[26px] font-medium tracking-[0.01em]" : "text-[17px] text-band-muted"} ${n.bad ? "text-band-muted line-through decoration-[1.5px]" : ""}`}>{n.value}</span>
                    <span className="text-[13px] text-band-muted">
                      {numberKind(n)}
                      {n.bad ? ", marked wrong" : n.owner === "company" ? ", the company’s" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {snap.numberProblem && (
            <p role="alert" className="mt-3 text-[14px] font-medium text-band-warn">
              {numberProblemLine(snap.numberProblem)}
            </p>
          )}
          <p id={`${numbersId}-hint`} className="mt-3 text-[13px] text-band-muted">
            Dial it on your own phone; the app never places a call. Choose the number you dial, so the outcome is logged on it.
          </p>
        </fieldset>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2">
        <section className="min-w-0 px-5 py-6 min-[901px]:px-[30px]">
          <Colleagues task={task} />
          {task.companyNotes.map((n) => (
            <p key={n.id} className="mt-3.5 rounded-field bg-raised px-3 py-2.5 text-[13.5px] [overflow-wrap:anywhere]">
              <b className="font-semibold">Company note.</b> {n.body}
            </p>
          ))}
          <details open className="group mt-[22px]">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-muted [&::-webkit-details-marker]:hidden">
              <Icon name="chevron" className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />
              Call script
            </summary>
            <div className="mt-2 whitespace-pre-wrap text-[14px] leading-[1.6] text-ink-2 [overflow-wrap:anywhere]">{task.script.trim() === "" ? "This campaign has no call script yet." : task.script}</div>
          </details>
        </section>
        <section className="min-w-0 border-line px-5 py-6 max-xl:border-t min-[901px]:px-[30px] xl:border-l">
          <h2 className="mb-2.5 text-[13px] font-semibold text-muted">What they’ve had so far</h2>
          <Touches touches={task.touches} notes={task.personNotes} />
          <Link href={recordHref} className="mt-2 inline-block text-[13px] text-muted underline decoration-line-strong underline-offset-[3px] hover:text-base-content">
            Open {who}’s full record
          </Link>
        </section>
      </div>
      <LogBar desk={desk} snap={snap} task={task} userZone={userZone} placeFocus={placeFocus} />
    </section>
  );
}

function Colleagues({ task }: { task: CallTaskView }) {
  const people: { key: string; name: ReactNode; title: string; aside: ReactNode; note: CallColleagueView["lastCallNote"] }[] = [];
  if (task.person) people.push({ key: task.person.id, name: task.person.name, title: task.person.title, aside: <span className="text-[12px] text-muted">this call</span>, note: null });
  for (const c of task.colleagues) {
    people.push({
      key: c.id,
      name: (
        <Link href={`/leads/people/${c.id}`} className="no-underline hover:underline">
          {c.name}
        </Link>
      ),
      title: c.title,
      aside:
        c.statuses.length === 0 ? (
          <span className="text-[12px] text-muted">Not in a campaign</span>
        ) : (
          c.statuses.map((s) => (
            <span key={s.campaign.id} className="inline-flex flex-wrap items-center gap-1.5">
              <StatusBadge status={s.status} />
              {c.statuses.length > 1 || s.campaign.id !== task.campaign.id ? <span className="text-[12px] text-muted [overflow-wrap:anywhere]">{s.campaign.name}</span> : null}
            </span>
          ))
        ),
      note: c.lastCallNote,
    });
  }
  return (
    <>
      <h2 className="mb-2.5 text-[13px] font-semibold text-muted">{task.person ? "People at this company" : "Who to ask for"}</h2>
      {people.length === 0 ? (
        <p className="text-[13.5px] text-muted">No decision makers are named for this company. Ask for the owner.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {people.map((p) => (
            <li key={p.key}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{p.name}</span>
                {p.aside}
              </div>
              {p.title && <div className="text-[13.5px] text-muted">{p.title}</div>}
              {p.note && <LastNote note={p.note} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function LastNote({ note }: { note: NonNullable<CallColleagueView["lastCallNote"]> }) {
  const now = useNow();
  return (
    <p className="mt-[3px] border-l-2 border-line-strong pl-2.5 text-[13.5px] text-ink-2 [overflow-wrap:anywhere]">
      {when(note.at, now)}: {note.note}
    </p>
  );
}

/** Earlier touches and notes, newest first, in the prototype's compact timeline. A call's note is shown once, on the call. */
function Touches({ touches, notes }: { touches: readonly TouchView[]; notes: readonly NoteView[] }) {
  const now = useNow();
  const onCall = new Set(touches.flatMap((t) => (t.kind === "call" && t.note ? [`${t.at}|${t.note}`] : [])));
  const rows = [
    ...touches.map((t) => ({ at: t.at, row: touchRow(t) })),
    ...notes.filter((n) => !onCall.has(`${n.at}|${n.body}`)).map((n) => ({ at: n.at, row: { icon: "file" as const, tone: "bg-pause-soft text-pause", title: "Note", body: n.body } })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (rows.length === 0) return <p className="text-[13.5px] text-muted">Nothing has happened yet.</p>;
  return (
    <ul>
      {rows.map(({ at, row }, i) => (
        <li key={`${at}-${i}`} className="grid grid-cols-[26px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-line py-[9px] [&+&]:border-t">
          <span className={`grid size-[26px] place-items-center rounded-full ${row.tone}`}>
            <Icon name={row.icon} className="size-3.5" />
          </span>
          <span className="min-w-0 pt-0.5 text-[14px] font-medium">{row.title}</span>
          <time dateTime={at} className="whitespace-nowrap pt-[3px] text-right text-[13px] text-muted">
            {when(at, now)}
          </time>
          {row.body && <span className="col-start-2 col-end-4 text-[14px] text-ink-2 [overflow-wrap:anywhere]">{row.body}</span>}
        </li>
      ))}
    </ul>
  );
}

const PLAIN = "bg-raised text-muted shadow-[inset_0_0_0_1px_var(--color-line)]";

function touchRow(t: TouchView): { icon: "email" | "sms" | "reply" | "call"; tone: string; title: string; body: string | null } {
  switch (t.kind) {
    case "email":
      return { icon: "email", tone: PLAIN, title: "Email sent", body: t.copy?.subject || null };
    case "sms":
      return { icon: "sms", tone: PLAIN, title: "Text sent", body: null };
    case "reply":
      return { icon: "reply", tone: "bg-hand-soft text-hand", title: t.channel === "email" ? "Replied by email" : "Replied by text", body: null };
    case "call":
      return { icon: "call", tone: "bg-call-soft text-call", title: OUTCOME_TITLE[t.outcome], body: [dialledLine(t.number), t.note].filter(Boolean).join(". ") || null };
  }
}

/** Keyboard focus on Log stays there while an outcome is pending: the button says so (aria-disabled) and is not removed. */
function LogBar({ desk, snap, task, userZone, placeFocus }: { desk: CallDesk; snap: DeskSnapshot; task: CallTaskView; userZone: string; placeFocus: ReturnType<typeof useKeyboardFocus> }) {
  const noteId = useId();
  const hintId = useId();
  const later = useId();
  const { draft, locked } = snap;
  const who = whoOf(task);
  const dialled = task.numbers.find((n) => n.detailId === draft.numberId);
  const away = snap.away;
  const pending = snap.pending !== null;
  const canLog = draft.outcome !== null && !snap.noteTooLong && (draft.outcome === "skip_for_now" || (dialled !== undefined && snap.numberProblem === null));
  return (
    <div className="flex flex-col gap-3.5 min-[901px]:sticky min-[901px]:bottom-0 border-t border-line bg-base-100 px-5 pb-[22px] pt-5 shadow-[0_-10px_24px_-18px_rgba(21,26,45,0.35)] min-[901px]:px-[30px]">
      {away && (
        <div role="alert" className="flex flex-col gap-2.5 rounded-field bg-crit-soft px-4 py-3 text-[14px]">
          <p className="text-base-content">{offListLine(away.who, away.offList, away.message, userZone)}</p>
          {away.note.trim() !== "" && (
            <p className="text-ink-2 [overflow-wrap:anywhere]">
              Your note wasn’t saved: <q className="whitespace-pre-wrap">{away.note}</q>
            </p>
          )}
          <div>
            <button type="button" ref={(el) => placeFocus(el, "away")} className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => void desk.moveOn()}>
              Open the next call
            </button>
          </div>
        </div>
      )}
      {snap.refusal && (
        <p role="alert" className="rounded-field bg-crit-soft px-4 py-2.5 text-[14px] text-base-content">
          Not logged: {snap.refusal.message}
        </p>
      )}
      <div className="grid grid-cols-1 gap-1.5">
        <label htmlFor={noteId} className="text-[13px] font-semibold text-muted">
          Notes from this call
        </label>
        <textarea
          id={noteId}
          className="textarea min-h-[76px] w-full resize-y border-line-strong text-[14px] leading-[1.45]"
          placeholder="What did they say?"
          value={away ? away.note : draft.note}
          readOnly={locked}
          aria-describedby={snap.noteTooLong ? `${noteId}-long` : undefined}
          onChange={(e) => desk.setDraft({ note: e.target.value })}
        />
        {snap.noteTooLong && (
          <p id={`${noteId}-long`} className="text-[13px] text-crit">
            The note is {draft.note.length.toLocaleString("en-GB")} characters; the limit is {NOTE_MAX.toLocaleString("en-GB")}. Shorten it to log the call.
          </p>
        )}
        {task.person ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] text-ink-2">
            <input type="checkbox" className="mt-[3px] size-4 accent-[var(--color-call)]" checked={draft.noteScope === "company"} disabled={locked} onChange={(e) => desk.setDraft({ noteScope: e.target.checked ? "company" : "person" })} />
            <span>Save it as a company note instead, shown for everyone at {task.company.name}</span>
          </label>
        ) : (
          <p className="text-[13px] text-muted">Notes on a company lead are company notes, shown for everyone at {task.company.name}.</p>
        )}
      </div>
      <div role="group" aria-label="Call outcome" aria-describedby={later} className="flex flex-wrap gap-2">
        {OFFERED.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={!away && draft.outcome === o}
            disabled={locked}
            onClick={() => desk.setDraft({ outcome: o })}
            className={`rounded-[20px] border px-3.5 py-[7px] text-[14px] font-medium ${!away && draft.outcome === o ? "border-base-content bg-base-content text-base-200" : "border-line-strong bg-base-100 hover:border-ink-2"} disabled:cursor-not-allowed disabled:border-line disabled:text-muted disabled:hover:border-line`}
          >
            {OUTCOME_LABEL[o]}
          </button>
        ))}
        {(["Callback requested", "Not interested"] as const).map((label) => (
          <button key={label} type="button" disabled aria-describedby={later} className="cursor-not-allowed rounded-[20px] border border-dashed border-line-strong bg-base-100 px-3.5 py-[7px] text-[14px] font-medium text-muted">
            {label}
          </button>
        ))}
      </div>
      <p id={later} className="-mt-2 text-[13px] text-muted">
        Callback requested, not interested and calling again tomorrow arrive with later releases.
      </p>
      {!away && draft.outcome && draft.outcome !== "skip_for_now" && (
        <div className="flex flex-col gap-2.5 rounded-field bg-raised px-4 py-3.5 text-[14px]">
          {draft.outcome === "wrong_number" ? (
            <p>{dialled && !snap.numberProblem ? `${dialled.value}, ${numberKind(dialled)}, the number you dial above, is marked wrong.` : "Choose the number you dialled above."}</p>
          ) : draft.outcome === "interested" ? (
            <>
              <p>
                Automation stops for {who} in {task.campaign.name}. You take it from here.
              </p>
              <p className="text-[13px] text-muted">Their other campaigns and colleagues keep running.</p>
            </>
          ) : (
            <p className="text-[13px] text-muted">{draft.outcome === "gatekeeper" ? "Add a note about who you spoke to. " : ""}Logged on {dialled && !snap.numberProblem ? `${dialled.value}, ${numberKind(dialled)}` : "the number you choose above"}.</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span id={hintId} className="text-[13px] text-muted">
          {pending ? "" : draft.outcome === null ? "Pick what happened to finish this call." : !canLog && !snap.noteTooLong ? "Choose the number you dial above." : ""}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {snap.pending?.unconfirmed && (
            <button type="button" className="btn border-line-strong bg-base-100 font-medium" onClick={() => desk.retryNow()}>
              Try again now
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary font-semibold"
            disabled={!pending && (locked || !canLog)}
            aria-disabled={pending ? "true" : undefined}
            aria-describedby={hintId}
            onClick={() => {
              if (!pending) desk.log();
            }}
          >
            {pending ? "Logging…" : "Log and open next call"}
          </button>
        </span>
      </div>
    </div>
  );
}
