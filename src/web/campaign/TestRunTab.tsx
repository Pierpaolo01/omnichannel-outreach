import { useCallback, useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { contactsUnsaved } from "../../domain/test-contacts.ts";
import type { TestRunRead, TestRunTab as TestRunTabView, TestStepRow } from "../../shared/api.ts";
import { ApiRequestError, postJson, putJson } from "../api.ts";
import { browserStorage } from "../calls/storage.ts";
import { ErrorState } from "../components.tsx";
import { useLiveRead } from "../controls/useLiveRead.ts";
import { Icon, type IconName } from "../icons.tsx";
import { useFocusRescue } from "../focusRescue.ts";
import { answered, isTestRunPressKey, keepPress, pendingPress, type TestRunPress } from "./testRunPress.ts";
import { ConfirmStrip } from "../controls/ControlViews.tsx";
import { testReplyHelper, WITHDRAWAL_ANSWERS } from "./linkedin-wording.ts";
import { endingDetail, endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";
import type { SequenceEditor } from "./useSequence.ts";

/**
 * The Test run tab (ticket 21; campaign editor variant A, `shots/a-10-test.png`): the user's own test contacts, the
 * lead the test's copy is written for, Run test and Stop test, and the latest run step by step, from the server's read.
 * A Run or Stop press is kept with its request id until the server answers it, across a reload too (`testRunPress.ts`).
 */
export function TestRunTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  // One order for every read sent and every control answer received (review bot on f7cdc66): what is shown is the
  // newest of them, so an older read, a control's own or the page's, never replaces a newer answer.
  const order = useRef(0);
  const issue = useCallback(() => ++order.current, []);
  const { read, refresh } = useLiveRead<TestRunTabView>(`/api/campaigns/${encodeURIComponent(campaignId)}/test-runs`, issue);
  const presses = usePresses(campaignId, refresh, issue);
  if (read.state === "error") return <ErrorState title="The test run didn’t load." message={read.message} onRetry={() => void refresh()} />;
  if (read.state === "loading")
    return (
      <div role="status" aria-busy="true" aria-label="Loading the test run" className="grid grid-cols-1 gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
        <div className="skeleton h-[360px] w-full" />
        <div className="skeleton h-[420px] w-full" />
      </div>
    );
  // A control's answer shows until a successful read sent after it lands; a failed read replaces nothing.
  const tab = presses.latest !== null && presses.latest.issued > read.issued ? presses.latest.view : read.data;
  return (
    <div className="grid grid-cols-1 items-start gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
      <Contacts campaignId={campaignId} tab={tab} editor={editor} onChange={refresh} presses={presses} />
      <RunPanel tab={tab} starting={presses.press?.kind === "run"} presses={presses} />
    </div>
  );
}

/** A disabled secondary button, as the app's others: no slab, muted text that meets AA in both themes. */
const DISABLED = "disabled:border-line disabled:bg-transparent disabled:text-muted";

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * What an answered press did, said where focus goes, from the press and its answer only (council on dee365d, item 10): a
 * mark or a withdrawal answer names the run it was confirmed on, and says the test stopped only when that run was running
 * and is the one the answer shows.
 */
export function pressDone(p: Pick<TestRunPress, "kind" | "runId" | "wasRunning">, shown: TestRunTabView["run"]): string {
  const same = p.runId !== undefined && shown?.id === p.runId;
  switch (p.kind) {
    case "run":
      return "The test started. Its steps are on the right.";
    case "stop":
      return "The test is stopped. Nothing more goes to your test contacts.";
    case "reply":
      if (!same) return "Marked the earlier test replied on LinkedIn. The test shown now is a newer one.";
      return p.wasRunning === true ? "Marked replied on LinkedIn. The test stopped, as a lead’s outreach stops at your mark." : "Marked replied on LinkedIn.";
    case "withdrawn":
      return same ? WITHDRAWAL_ANSWERS[0].done : "Marked the earlier test’s invite withdrawn. The test shown now is a newer one.";
    case "kept":
      return same ? WITHDRAWAL_ANSWERS[1].done : "Marked the earlier test’s invite still there. The test shown now is a newer one.";
    default: {
      const unhandled: never = p.kind;
      throw new Error(`A test press with no answer: ${String(unhandled)}`);
    }
  }
}

interface Presses {
  /** The newest control answer, numbered as it arrived in the page's one order with the reads. */
  readonly latest: { readonly view: TestRunTabView; readonly issued: number } | null;
  /** The press waiting for its answer: this page's, or one kept from before a reload or by another tab. */
  readonly press: TestRunPress | null;
  /** This page is sending it now. */
  readonly sending: boolean;
  /** The server's refusal, or why no answer came. */
  readonly refusal: string | null;
  /** What the last answered press did, said where focus goes; `n` moves focus there again for the same words. */
  readonly said: { readonly text: string; readonly n: number } | null;
  readonly press_: (kind: TestRunPress["kind"], path: string, body: Record<string, unknown>, about?: { readonly runId: string; readonly wasRunning: boolean }) => void;
  readonly retry: () => void;
}

/**
 * Run and Stop presses: kept at the press, sent, and cleared only by the server's answer to their id. A press found kept
 * when the page opens (a reload while it waited, another visit) is sent again with the same id and body, so the page shows
 * it pending until the server has answered it, never the state from before it.
 */
function usePresses(campaignId: string, refresh: () => Promise<void>, issue: () => number): Presses {
  const store = useMemo(() => browserStorage(() => window.localStorage), []);
  const [press, setPress] = useState<TestRunPress | null>(() => pendingPress(store, campaignId));
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; n: number } | null>(null);
  const [latest, setLatest] = useState<Presses["latest"]>(null);

  const send = useCallback(
    async (p: TestRunPress) => {
      setPress(p);
      setSending(true);
      setRefusal(null);
      try {
        // The answer is the tab as of the press's effect, numbered as it arrives: shown until a successful read sent after
        // it lands (verifier re-check, item 15; review bot on f7cdc66). Nothing here clears it, and an older press's
        // continuation cannot: each press sets only its own pending state and result, at its own answer.
        const view = (await postJson(p.path, p.body)) as TestRunTabView;
        const issued = issue();
        answered(store, campaignId, p.requestId);
        setLatest((prev) => (prev === null || issued > prev.issued ? { view, issued } : prev));
        setPress((now) => (now?.requestId === p.requestId ? null : now));
        setSaid((prev) => ({ text: pressDone(p, view.run), n: (prev?.n ?? 0) + 1 }));
        await refresh();
      } catch (error) {
        // A refusal is the server's answer: the press is done. A failure with no answer keeps it for Try again.
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
          answered(store, campaignId, p.requestId);
          setPress((now) => (now?.requestId === p.requestId ? null : now));
          setRefusal(error.message);
          await refresh();
        } else setRefusal(`${error instanceof Error ? error.message : "The request failed."} It may or may not have arrived: Try again sends the same request, which the server answers once.`);
      } finally {
        setSending(false);
      }
    },
    [campaignId, issue, refresh, store],
  );

  // A press kept from before this page opened is sent again, with its own id and body (after the effect, so a development
  // re-run of it cancels the first and sends once).
  useEffect(() => {
    const kept = pendingPress(store, campaignId);
    if (!kept) return undefined;
    const timer = setTimeout(() => void send(kept), 0);
    return () => clearTimeout(timer);
    // Only when the page opens on a campaign: a press made here is sent by its own press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, store]);

  // Another tab's press, or its answer, shows here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!isTestRunPressKey(e.key)) return;
      setPress(pendingPress(store, campaignId));
      void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [campaignId, refresh, store]);

  return {
    latest,
    press,
    sending,
    refusal,
    said,
    press_: (kind, path, body, about) => {
      const requestId = newRequestId();
      const p: TestRunPress = { v: 1, kind, requestId, path, body: { requestId, ...body }, pressedAt: Date.now(), ...(about ? { runId: about.runId, wasRunning: about.wasRunning } : {}) };
      // Kept before it is sent; if storage refuses, the press still goes and this page alone knows it.
      keepPress(store, campaignId, p);
      void send(p);
    },
    retry: () => {
      if (press) void send(press);
    },
  };
}

function Contacts({ campaignId, tab, editor, onChange, presses }: { campaignId: string; tab: TestRunTabView; editor: SequenceEditor; onChange: () => Promise<void>; presses: Presses }) {
  const emailId = useId();
  const mobileId = useId();
  const leadId = useId();
  const [email, setEmail] = useState(tab.contacts.email ?? "");
  const [mobile, setMobile] = useState(tab.contacts.mobile ?? "");
  const linkedinId = useId();
  const [linkedin, setLinkedin] = useState(tab.contacts.linkedin ?? "");
  // The test profile is asked for while the sequence has a LinkedIn track, or one is saved (ticket 24b).
  const asksLinkedin = editor.view.definition.tracks.some((t) => !t.removed && t.channel === "linkedin") || tab.contacts.linkedin !== null;
  const inmailOn = editor.view.definition.tracks.some((t) => !t.removed && t.channel === "linkedin" && t.steps.some((s) => s.role === "inmail" && !s.removed));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ n: number; focus: boolean }>({ n: 0, focus: false });
  const [fieldError, setFieldError] = useState<{ field: "email" | "mobile" | "linkedin"; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renderAs, setRenderAs] = useState<string | null>(null);
  const savedRef = useRef<HTMLSpanElement>(null);
  const saidRef = useRef<HTMLParagraphElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  const { press, sending, refusal, said } = presses;

  // Compared by the server's own reading of a contact (review bot on 55d6ac6): "+447700900456" is the stored "+44 7700 900456".
  const typed = asksLinkedin ? { email, mobile, linkedin } : { email, mobile };
  const dirty = contactsUnsaved(typed, tab.contacts);
  const lead = tab.leads.find((l) => l.id === renderAs) ?? tab.leads[0] ?? null;
  const running = tab.run?.running === true;
  const noContact = tab.contacts.email === null && tab.contacts.mobile === null && tab.contacts.linkedin === null;
  // A kept press blocks another until the server answers it (Try again resends it): it is never replaced, so never orphaned.
  const pending = press !== null;

  // Focus goes where the words say what happened (verifier F4 on 55d6ac6): Saved, the press's result, or its refusal.
  useEffect(() => {
    if (saved.focus) savedRef.current?.focus();
  }, [saved]);
  useEffect(() => {
    if (said) saidRef.current?.focus();
  }, [said]);
  useEffect(() => {
    if (refusal !== null) refusalRef.current?.focus();
  }, [refusal]);

  // One save at a time (review bot on ffa202c; verifier R1): a save asked for while one waits is queued, the latest draft
  // only, and sent after that one's answer, so an older answer can never land after a newer save. The fields take only
  // the answer to the newest save, and only where they still hold what it sent.
  type Typed = { email: string; mobile: string; linkedin?: string };
  const current = useRef<Typed>(typed);
  useEffect(() => {
    current.current = asksLinkedin ? { email, mobile, linkedin } : { email, mobile };
  }, [email, mobile, linkedin, asksLinkedin]);
  const inFlight = useRef(false);
  const queued = useRef<Typed | null>(null);
  const [queuedNext, setQueuedNext] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const send = async (sent: Typed): Promise<void> => {
    inFlight.current = true;
    setSaving(true);
    setFieldError(null);
    setSaveError(null);
    let ok = false;
    try {
      const stored = (await putJson(`/api/campaigns/${encodeURIComponent(campaignId)}/test-contacts`, sent)) as TestRunTabView;
      ok = true;
      if (queued.current === null) {
        // The fields show what was stored, as the server wrote it, unless they were edited while it was saving.
        setEmail((now) => (now === sent.email ? (stored.contacts.email ?? "") : now));
        setMobile((now) => (now === sent.mobile ? (stored.contacts.mobile ?? "") : now));
        if (sent.linkedin !== undefined) setLinkedin((now) => (now === sent.linkedin ? (stored.contacts.linkedin ?? "") : now));
      }
    } catch (error) {
      const body = error instanceof ApiRequestError ? (error.body as { error?: { field?: "email" | "mobile" | "linkedin"; message?: string } } | null) : null;
      if (queued.current === null) {
        if (body?.error?.field) setFieldError({ field: body.error.field, message: body.error.message ?? "" });
        else setSaveError(error instanceof Error ? error.message : "Saving failed.");
      }
    }
    const next = queued.current;
    queued.current = null;
    setQueuedNext(false);
    if (next) return send(next);
    inFlight.current = false;
    setSaving(false);
    await onChange();
    if (ok) {
      // Focus moves to "Saved." only when the user is not typing past the save (item 16): the fields still hold what it
      // sent, and focus is not in one of them.
      const typing = form.current?.contains(document.activeElement) === true && document.activeElement instanceof HTMLInputElement;
      const edited = current.current.email !== sent.email || current.current.mobile !== sent.mobile || current.current.linkedin !== sent.linkedin;
      setSaved((prev) => ({ n: prev.n + 1, focus: !typing && !edited }));
    }
  };

  const save = (e: SyntheticEvent) => {
    e.preventDefault();
    const draft = { ...current.current };
    if (inFlight.current) {
      queued.current = draft;
      setQueuedNext(true);
      return;
    }
    // The submit button is disabled while saving: if it had focus, focus goes to the line that says what is happening.
    if (document.activeElement instanceof HTMLButtonElement && form.current?.contains(document.activeElement)) savedRef.current?.focus();
    void send(draft);
  };

  const hint = noContact ? (asksLinkedin ? "Add your email, mobile or LinkedIn profile, and save them, to run a test." : "Add your email or mobile, and save them, to run a test.") : dirty ? "Save your contacts to run a test with them." : editor.unsaved ? "Your latest change to the sequence isn’t saved yet; a test runs the saved version." : "";
  const status = pending ? (press.kind === "reply" ? `Marking the test replied: ${sending ? "waiting for the server’s answer" : "no answer yet"}.` : press.kind === "withdrawn" || press.kind === "kept" ? `Marking the test’s invite: ${sending ? "waiting for the server’s answer" : "no answer yet"}.` : press.kind === "run" ? `Starting the test: ${sending ? "waiting for the server’s answer" : "no answer yet"}.` : `Stopping the test: ${sending ? "waiting for the server’s answer" : "no answer yet"}.`) : (said?.text ?? hint);

  return (
    <section aria-labelledby="test-contacts" className="flex min-w-0 flex-col gap-3.5 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4">
      <h2 id="test-contacts" className="text-[19px]">
        Test contacts
      </h2>
      <form
        ref={form}
        className="flex flex-col gap-3"
        onSubmit={save}
        // Enter in a field saves, and queues behind a save on its way: the disabled button would otherwise block it.
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) save(e);
        }}
        noValidate
      >
        <ContactField id={emailId} label="Your email" icon="email" value={email} onChange={setEmail} type="email" placeholder="you@example.com" error={fieldError?.field === "email" ? fieldError.message : tab.contacts.emailIsALead ? "A lead has this email now, so tests can’t use it. Use another of your own." : null} />
        <ContactField id={mobileId} label="Your mobile, for texts and the test call" icon="sms" value={mobile} onChange={setMobile} type="tel" placeholder="+44 7700 900000" error={fieldError?.field === "mobile" ? fieldError.message : tab.contacts.mobileIsALead ? "A lead has this number now, so tests can’t use it. Use another of your own." : null} />
        {asksLinkedin && (
          <ContactField
            id={linkedinId}
            label="Your LinkedIn profile, for the invite and messages"
            icon="linkedin"
            value={linkedin}
            onChange={setLinkedin}
            type="url"
            placeholder="https://www.linkedin.com/in/your-profile"
            error={fieldError?.field === "linkedin" ? fieldError.message : tab.contacts.linkedinIsALead ? "A lead has this profile now, so tests can’t use it. Use another of your own." : null}
          />
        )}
        <p className="text-[13.5px] text-muted">Only contacts that are your own. They are never leads: a lead’s email{asksLinkedin ? ", number or profile" : " or number"} is refused.</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Disabled while a save waits: a second press is queued by Enter in a field, never sent beside it. */}
          <button type="submit" className={`btn btn-sm border-line-strong bg-base-100 font-medium ${DISABLED}`} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save contacts"}
          </button>
          <span ref={savedRef} tabIndex={-1} className="rounded-field text-[13px] text-muted outline-offset-4" aria-live="polite">
            {saving ? (queuedNext ? "Saving… Your latest change saves next." : "Saving…") : saved.n > 0 && !dirty ? "Saved." : ""}
          </span>
        </div>
        {saveError !== null && <p className="text-[13.5px] text-crit">{saveError}</p>}
      </form>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3.5">
        <label htmlFor={leadId} className="text-[13px] font-semibold text-muted">
          Copy written for
        </label>
        {tab.leads.length === 0 ? (
          <p className="text-[14px] text-ink-2">No leads yet. A test writes its copy for a real lead, so import leads first.</p>
        ) : (
          <select id={leadId} className="select w-full border-line-strong" value={lead?.id ?? ""} onChange={(e) => setRenderAs(e.target.value)} disabled={running}>
            {tab.leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.kind === "company" ? " (company lead)" : ""}
              </option>
            ))}
          </select>
        )}
        <p className="text-[13.5px] text-muted">Their merge fields fill the copy. Nothing is sent to them.</p>
      </div>

      <p className="text-[14px] text-ink-2">
        Sends every step of the current sequence to you, in order, from the real sender accounts. Each wait is cut to about a minute
        {asksLinkedin ? ", except the wait for you to accept the LinkedIn invite on your test profile, which you do by hand" : ""}.
        {/* The InMail fallback in a test (ticket 27; ADR 0004 13.6): reached only by leaving the invite unaccepted. */}
        {inmailOn ? " With the InMail fallback on, the test reaches the InMail only if you leave the test invite unaccepted for the whole wait; the InMail then spends one of your session’s InMail credits." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        {running && !(pending && press.kind === "run") ? (
          <>
            <button type="button" className={`btn border-line-strong bg-base-100 font-medium ${DISABLED}`} disabled>
              Test running
            </button>
            <button
              type="button"
              className="btn btn-ghost font-medium text-crit"
              aria-disabled={pending}
              onClick={() => {
                if (pending || !tab.run) return;
                presses.press_("stop", `/api/test-runs/${encodeURIComponent(tab.run.id)}/stop`, {});
              }}
            >
              {pending && press.kind === "stop" ? "Stopping…" : "Stop test"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`btn border-line-strong bg-base-100 font-medium ${DISABLED}`}
            disabled={!pending && (noContact || dirty || lead === null || editor.unsaved)}
            aria-disabled={pending}
            onClick={() => {
              if (pending || !lead) return;
              // Built once, from what the page shows: the lead, and the version of the sequence on the page. Try again resends it unchanged.
              presses.press_("run", `/api/campaigns/${encodeURIComponent(campaignId)}/test-runs`, { renderAs: lead.id, expect: { definitionVersion: editor.view.definitionVersion } });
            }}
          >
            {pending && press.kind === "run" ? "Starting…" : tab.run ? "Run test again" : "Run test"}
          </button>
        )}
      </div>
      {status !== "" && (
        <p ref={saidRef} tabIndex={-1} className="rounded-field text-[13.5px] text-muted outline-offset-4" aria-live="polite">
          {status}
        </p>
      )}
      {refusal !== null && (
        <div ref={refusalRef} tabIndex={-1} className="flex flex-wrap items-start gap-2.5 rounded-field bg-crit-soft px-3.5 py-3 text-[14px] outline-offset-4">
          <Icon name="bad" className="mt-0.5 size-[18px] text-crit" />
          <span className="min-w-0 flex-[1_1_220px] [overflow-wrap:anywhere]">{refusal}</span>
          {press !== null && (
            <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={presses.retry}>
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ContactField({ id, label, icon, value, onChange, type, placeholder, error }: { id: string; label: string; icon: IconName; value: string; onChange: (v: string) => void; type: "email" | "tel" | "url"; placeholder: string; error: string | null }) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-muted">
        {label}
      </label>
      <span className={`input flex w-full items-center gap-2 border-line-strong ${error ? "border-crit" : ""}`}>
        <Icon name={icon} className="size-4 flex-none text-muted" />
        <input id={id} type={type} className="min-w-0 grow" value={value} placeholder={placeholder} autoComplete={type === "email" ? "email" : type === "url" ? "url" : "tel"} aria-invalid={error !== null} aria-describedby={error ? errorId : undefined} onChange={(e) => onChange(e.target.value)} />
      </span>
      {error !== null && (
        <span id={errorId} className="text-[13px] text-crit">
          {error}
        </span>
      )}
    </div>
  );
}

const STEP_ICON: Record<TestStepRow["channel"], IconName> = { email: "email", sms: "sms", call: "call", linkedin: "linkedin" };

function RunPanel({ tab, starting, presses }: { tab: TestRunTabView; starting: boolean; presses: Presses }) {
  const run = tab.run;
  return (
    <section aria-labelledby="test-run-heading" className="flex min-w-0 flex-col gap-3 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4">
      {/* While a Run press waits for its answer, a test may be starting: the run before it is not shown as the state (verifier F3). */}
      {starting && !run?.running ? (
        <>
          <h2 id="test-run-heading" className="text-[19px]">
            Starting a test…
          </h2>
          <p className="text-[14px] text-ink-2">Your Run test is waiting for the server’s answer. The test shows here as soon as it is answered.</p>
        </>
      ) : run === null ? (
        <>
          <h2 id="test-run-heading" className="text-[19px]">
            No test yet
          </h2>
          <p className="text-[14px] text-ink-2">A test sends the whole sequence to your own email and mobile, and puts its calls on your Calls list. It is optional: you can launch without one.</p>
        </>
      ) : (
        <RunRead run={run} tab={tab} />
      )}
      {/* Outside the run's own read, so a confirmation sees the shown run change under it and closes (item 10). */}
      {/* While a test is starting, the shown run is being replaced: an open confirmation closes and says so. */}
      <TestLinkedinControls run={starting && !run?.running ? null : run} presses={presses} />
      {tab.noTestSinceEdit && run !== null && !starting && (
        <p className="flex gap-2 text-[13.5px] text-ink-2">
          <Icon name="warn" className="mt-0.5 size-4 flex-none text-pause" />
          <span>No test since the last edit. That’s optional: you can launch without one.</span>
        </p>
      )}
      <p className="border-t border-line pt-3 text-[13px] text-muted">
        Reply to any test message from your email or mobile to check that it stops the test{run?.linkedinReply ? "; a LinkedIn reply is never detected, so mark it here once you have answered on your test profile" : ""}. Email shows sent or failed only: Instantly doesn’t report delivery, and a sent email is not proof it reached the inbox. Test sends count against each sender’s daily limit like any send.
      </p>
    </section>
  );
}

function RunRead({ run, tab }: { run: TestRunRead; tab: TestRunTabView }) {
  const started = timeIn(tab.zone, run.startedAt, tab.at);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="test-run-heading" className="text-[19px]">
          {run.running ? `Started at ${started}` : run.ending ? `${endingTitle(run.ending, run)}${run.endedAt ? ` at ${timeIn(tab.zone, run.endedAt, tab.at)}` : ""}` : `Started at ${started}`}
        </h2>
        <span className="flex items-center gap-2 text-[13.5px] text-muted">
          {run.running && <span className="size-[7px] rounded-full bg-you" aria-hidden="true" />}
          {progressText(run)}
        </span>
      </div>
      <p className="-mt-1.5 text-[13.5px] text-muted [overflow-wrap:anywhere]">
        {run.running ? "" : `Started at ${started}. `}Copy written for {run.renderAs.name}.{run.ending ? ` ${endingDetail(run.ending, run)}` : ""}
        {!run.running && run.mayStillSend > 0 ? ` ${run.mayStillSend} ${run.mayStillSend === 1 ? "message was" : "messages were"} already with a provider and may still arrive.` : ""}
      </p>
      <ol className="flex flex-col" aria-label="The test’s steps, in order">
        {run.steps.map((s) => {
          const done = s.state === "sent" || s.state === "logged";
          const now = s.state === "due" || s.state === "on_your_list" || s.state === "with_provider";
          const state = stepStateText(s, tab.zone, tab.at);
          return (
            <li key={s.stepId} className="flex items-start gap-3 border-line py-2.5 [&+&]:border-t">
              <span
                className={`mt-0.5 grid size-7 flex-none place-items-center rounded-full ${done ? "bg-base-content text-base-100" : now ? "bg-you-soft text-you shadow-[inset_0_0_0_1.5px_currentColor]" : s.state === "failed" ? "bg-crit-soft text-crit" : "text-muted shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
                aria-hidden="true"
              >
                <Icon name={done ? "ok" : s.state === "failed" ? "bad" : s.branch === "win_back" && s.state === "not_reached" ? "reply" : STEP_ICON[s.channel]} className="size-[15px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[14.5px] ${s.state === "not_reached" ? "text-ink-2" : "font-medium"}`}>
                  {s.track} · {s.name}
                </span>
                <span className="block text-[13px] text-muted [overflow-wrap:anywhere]">{stepDetail(s, run)}</span>
              </span>
              {/* A long state (a LinkedIn acceptance wait, ticket 24b) wraps beside the step rather than widen a narrow page. */}
              {state !== "" && <span className={`${state.length > 32 ? "max-w-[46%] text-right" : "whitespace-nowrap"} text-[13.5px] ${now ? "font-medium text-you" : s.state === "failed" ? "text-crit" : "text-muted"}`}>{state}</span>}
            </li>
          );
        })}
      </ol>

    </>
  );
}

/** A confirmation on the tab, a snapshot of the read it opened on and of the run it was opened for (council on dee365d, item 10). */
type TestConfirmation = { readonly kind: "reply"; readonly runId: string; readonly status: TestRunRead["status"]; readonly wasRunning: boolean } | { readonly kind: "withdrawn" | "kept"; readonly runId: string; readonly trackId: string; readonly wasRunning: boolean };

/** Why an open confirmation no longer applies to what the tab shows, or null while it does. */
export function testConfirmationGone(c: TestConfirmation, run: TestRunRead | null): string | null {
  if (run === null || run.id !== c.runId) return "The test shown here changed since you opened this, so it was closed. Nothing was marked.";
  if (c.kind === "reply") return run.linkedinReply?.allowed === true && run.status === c.status ? null : "This test changed since you opened this, so it was closed. Nothing was marked.";
  return run.linkedinTracks.some((t) => t.trackId === c.trackId && t.view.withdrawalStuck) ? null : "The withdrawal was settled since you opened this, so it was closed. Nothing was marked.";
}

const CONFIRM_TEXT = {
  reply: "Mark this test replied on LinkedIn? It stops the test, as a reply stops a lead’s outreach in this campaign. Carry on the conversation on LinkedIn.",
  withdrawn: "Mark the test invite withdrawn? Do this only once LinkedIn no longer shows it as pending on your test profile. The app stops asking LinkedIn about it.",
  kept: "Mark the test invite still there? The app stops asking LinkedIn to withdraw it and leaves it open on your test profile.",
} as const;

/**
 * The run's LinkedIn reply mark and its stuck withdrawal's two answers (ticket 24b; ADR 0004 sections 3.3 and 7): offered
 * while the read allows them, a refusal said in their place, each confirmed in place against the read and the run it was
 * opened on. A confirmation whose run is no longer the one shown, or whose press the read no longer offers, closes and says
 * why; its press names its run in its route, so a late one is applied to that run only and says so (item 10).
 */
function TestLinkedinControls({ run, presses }: { run: TestRunRead | null; presses: Presses }) {
  const [opened, setOpened] = useState<TestConfirmation | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  // Buttons by key, so a cancelled confirmation returns focus to the one that opened it once it is drawn again (item 12).
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusBack = useRef<string | null>(null);
  const closedRef = useRef<HTMLParagraphElement>(null);
  const rescue = useFocusRescue();
  // After each render: a cancelled confirmation's button, once it is drawn again, takes focus back.
  useEffect(() => {
    const key = focusBack.current;
    if (key === null) return;
    const el = buttons.current.get(key);
    if (el?.isConnected) {
      el.focus();
      focusBack.current = null;
    }
  });
  const pending = presses.press !== null;
  const gone = opened === null ? null : testConfirmationGone(opened, run);
  if (opened !== null && gone !== null) {
    setOpened(null);
    setClosed(gone);
  }
  useEffect(() => {
    if (closed !== null) closedRef.current?.focus();
  }, [closed]);
  if (run === null)
    return closed === null ? null : (
      <div ref={rescue}>
        <p ref={closedRef} tabIndex={-1} role="status" className="text-[13.5px] text-ink-2 outline-offset-4">
          {closed}
        </p>
      </div>
    );
  const mark = run.linkedinReply;
  const stuck = run.linkedinTracks.filter((t) => t.view.withdrawalStuck);
  if (mark === null && stuck.length === 0 && closed === null) return null;
  const keyOf = (c: TestConfirmation) => (c.kind === "reply" ? "reply" : `${c.kind}:${c.trackId}`);
  function open(c: TestConfirmation): void {
    setClosed(null);
    setOpened(c);
  }
  return (
    <div ref={rescue} className="flex flex-col gap-2 border-t border-line pt-3">
      {closed !== null && (
        <p ref={closedRef} tabIndex={-1} data-rescue="1" role="status" className="rounded-field bg-pause-soft px-3 py-2 text-[13.5px] text-base-content outline-offset-4">
          {closed}
        </p>
      )}
      {opened ? (
        <ConfirmStrip
          text={CONFIRM_TEXT[opened.kind]}
          action={opened.kind === "reply" ? "Mark replied" : WITHDRAWAL_ANSWERS[opened.kind === "withdrawn" ? 0 : 1].label}
          busy={pending ? "Another change to this test is on its way." : null}
          onConfirm={() => {
            const about = { runId: opened.runId, wasRunning: opened.wasRunning };
            if (opened.kind === "reply") presses.press_("reply", `/api/test-runs/${encodeURIComponent(opened.runId)}/replies`, { channel: "linkedin", expect: { status: opened.status } }, about);
            else presses.press_(opened.kind, `/api/test-runs/${encodeURIComponent(opened.runId)}/invite-withdrawal`, { trackId: opened.trackId, answer: opened.kind === "withdrawn" ? "withdrawn" : "kept" }, about);
            setOpened(null);
          }}
          onCancel={() => {
            focusBack.current = keyOf(opened);
            setOpened(null);
          }}
        />
      ) : (
        <>
          {stuck.map((t) => (
            <div key={t.trackId} className="flex flex-col gap-1.5">
              {/* The expiry's own line says LinkedIn hasn't answered (council on a6c1700, item 7): only the question here. */}
              <p className="text-[13.5px] text-ink-2">Was the test invite withdrawn from your test profile?</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Was the test invite withdrawn?">
                {(["withdrawn", "kept"] as const).map((kind, i) => (
                  <button
                    key={kind}
                    ref={(el) => {
                      if (el) buttons.current.set(`${kind}:${t.trackId}`, el);
                    }}
                    data-rescue="2"
                    type="button"
                    className={`btn btn-sm border-line-strong bg-base-100 font-medium ${DISABLED}`}
                    disabled={pending}
                    onClick={() => open({ kind, runId: run.id, trackId: t.trackId, wasRunning: run.running })}
                  >
                    {WITHDRAWAL_ANSWERS[i]?.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {mark !== null && !mark.allowed && <p className="text-[13.5px] text-muted">{mark.reason}</p>}
          {mark?.allowed && (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                ref={(el) => {
                  if (el) buttons.current.set("reply", el);
                }}
                data-rescue="2"
                type="button"
                className={`btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium ${DISABLED}`}
                disabled={pending}
                onClick={() => open({ kind: "reply", runId: run.id, status: run.status, wasRunning: run.running })}
              >
                <Icon name="linkedin" className="size-4" />
                Mark replied on LinkedIn
              </button>
              {/* Worded for what has gone (council on a6c1700, item 7): a message, or only the invite. */}
              <span className="text-[13px] text-muted">{testReplyHelper(mark.work)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
