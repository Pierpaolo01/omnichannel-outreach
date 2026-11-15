import { useCallback, useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { contactsUnsaved } from "../../domain/test-contacts.ts";
import type { TestRunRead, TestRunTab as TestRunTabView, TestStepRow } from "../../shared/api.ts";
import { ApiRequestError, postJson, putJson } from "../api.ts";
import { browserStorage } from "../calls/storage.ts";
import { ErrorState } from "../components.tsx";
import { useLiveRead } from "../controls/useLiveRead.ts";
import { Icon, type IconName } from "../icons.tsx";
import { answered, isTestRunPressKey, keepPress, pendingPress, type TestRunPress } from "./testRunPress.ts";
import { endingDetail, endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";
import type { SequenceEditor } from "./useSequence.ts";

/**
 * The Test run tab (ticket 21; campaign editor variant A, `shots/a-10-test.png`): the user's own test contacts, the
 * lead the test's copy is written for, Run test and Stop test, and the latest run step by step, from the server's read.
 * A Run or Stop press is kept with its request id until the server answers it, across a reload too (`testRunPress.ts`).
 */
export function TestRunTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const { read, refresh } = useLiveRead<TestRunTabView>(`/api/campaigns/${encodeURIComponent(campaignId)}/test-runs`);
  const presses = usePresses(campaignId, refresh);
  if (read.state === "error") return <ErrorState title="The test run didn’t load." message={read.message} onRetry={() => void refresh()} />;
  if (read.state === "loading")
    return (
      <div role="status" aria-busy="true" aria-label="Loading the test run" className="grid grid-cols-1 gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
        <div className="skeleton h-[360px] w-full" />
        <div className="skeleton h-[420px] w-full" />
      </div>
    );
  const tab = presses.latest ?? read.data;
  return (
    <div className="grid grid-cols-1 items-start gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
      <Contacts campaignId={campaignId} tab={tab} editor={editor} onChange={refresh} presses={presses} />
      <RunPanel tab={tab} starting={presses.press?.kind === "run"} />
    </div>
  );
}

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`);

interface Presses {
  /** A press's answer, until the read after it has landed. */
  readonly latest: TestRunTabView | null;
  /** The press waiting for its answer: this page's, or one kept from before a reload or by another tab. */
  readonly press: TestRunPress | null;
  /** This page is sending it now. */
  readonly sending: boolean;
  /** The server's refusal, or why no answer came. */
  readonly refusal: string | null;
  /** What the last answered press did, said where focus goes; `n` moves focus there again for the same words. */
  readonly said: { readonly text: string; readonly n: number } | null;
  readonly press_: (kind: TestRunPress["kind"], path: string, body: Record<string, unknown>) => void;
  readonly retry: () => void;
}

/**
 * Run and Stop presses: kept at the press, sent, and cleared only by the server's answer to their id. A press found kept
 * when the page opens (a reload while it waited, another visit) is sent again with the same id and body, so the page shows
 * it pending until the server has answered it, never the state from before it.
 */
function usePresses(campaignId: string, refresh: () => Promise<void>): Presses {
  const store = useMemo(() => browserStorage(() => window.localStorage), []);
  const [press, setPress] = useState<TestRunPress | null>(() => pendingPress(store, campaignId));
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; n: number } | null>(null);
  const [latest, setLatest] = useState<TestRunTabView | null>(null);

  const send = useCallback(
    async (p: TestRunPress) => {
      setPress(p);
      setSending(true);
      setRefusal(null);
      try {
        // The answer is the tab as of the press's effect: shown until the read asked for after it has landed, so the run
        // before it never shows again in between (verifier re-check, item 15).
        const answer = (await postJson(p.path, p.body)) as TestRunTabView;
        answered(store, campaignId, p.requestId);
        setLatest(answer);
        setPress(null);
        await refresh();
        setLatest(null);
        setSaid((prev) => ({ text: p.kind === "run" ? "The test started. Its steps are on the right." : "The test is stopped. Nothing more goes to your test contacts.", n: (prev?.n ?? 0) + 1 }));
      } catch (error) {
        // A refusal is the server's answer: the press is done. A failure with no answer keeps it for Try again.
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
          answered(store, campaignId, p.requestId);
          setPress(null);
          setRefusal(error.message);
          await refresh();
        } else setRefusal(`${error instanceof Error ? error.message : "The request failed."} It may or may not have arrived: Try again sends the same request, which the server answers once.`);
      } finally {
        setSending(false);
      }
    },
    [campaignId, refresh, store],
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
    press_: (kind, path, body) => {
      const requestId = newRequestId();
      const p: TestRunPress = { v: 1, kind, requestId, path, body: { requestId, ...body }, pressedAt: Date.now() };
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ n: number; focus: boolean }>({ n: 0, focus: false });
  const [fieldError, setFieldError] = useState<{ field: "email" | "mobile"; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renderAs, setRenderAs] = useState<string | null>(null);
  const savedRef = useRef<HTMLSpanElement>(null);
  const saidRef = useRef<HTMLParagraphElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  const { press, sending, refusal, said } = presses;

  // Compared by the server's own reading of a contact (review bot on 55d6ac6): "+447700900456" is the stored "+44 7700 900456".
  const dirty = contactsUnsaved({ email, mobile }, tab.contacts);
  const lead = tab.leads.find((l) => l.id === renderAs) ?? tab.leads[0] ?? null;
  const running = tab.run?.running === true;
  const noContact = tab.contacts.email === null && tab.contacts.mobile === null;
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
  const current = useRef({ email, mobile });
  useEffect(() => {
    current.current = { email, mobile };
  }, [email, mobile]);
  const inFlight = useRef(false);
  const queued = useRef<{ email: string; mobile: string } | null>(null);
  const [queuedNext, setQueuedNext] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const send = async (sent: { email: string; mobile: string }): Promise<void> => {
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
      }
    } catch (error) {
      const body = error instanceof ApiRequestError ? (error.body as { error?: { field?: "email" | "mobile"; message?: string } } | null) : null;
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
      const edited = current.current.email !== sent.email || current.current.mobile !== sent.mobile;
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

  const hint = noContact ? "Add your email or mobile, and save them, to run a test." : dirty ? "Save your contacts to run a test with them." : editor.unsaved ? "Your latest change to the sequence isn’t saved yet; a test runs the saved version." : "";
  const status = pending ? (press.kind === "run" ? `Starting the test: ${sending ? "waiting for the server’s answer" : "no answer yet"}.` : `Stopping the test: ${sending ? "waiting for the server’s answer" : "no answer yet"}.`) : (said?.text ?? hint);

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
        <p className="text-[13.5px] text-muted">Only contacts that are your own. They are never leads: a lead’s email or number is refused.</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Disabled while a save waits: a second press is queued by Enter in a field, never sent beside it. */}
          <button type="submit" className="btn btn-sm border-line-strong bg-base-100 font-medium" disabled={saving || !dirty}>
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

      <p className="text-[14px] text-ink-2">Sends every step of the current sequence to you, in order, from the real sender accounts. Each wait is cut to about a minute.</p>
      <div className="flex flex-wrap items-center gap-2.5">
        {running && !(pending && press.kind === "run") ? (
          <>
            <button type="button" className="btn border-line-strong bg-base-100 font-medium" disabled>
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
            className="btn border-line-strong bg-base-100 font-medium"
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

function ContactField({ id, label, icon, value, onChange, type, placeholder, error }: { id: string; label: string; icon: IconName; value: string; onChange: (v: string) => void; type: "email" | "tel"; placeholder: string; error: string | null }) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-muted">
        {label}
      </label>
      <span className={`input flex w-full items-center gap-2 border-line-strong ${error ? "border-crit" : ""}`}>
        <Icon name={icon} className="size-4 flex-none text-muted" />
        <input id={id} type={type} className="min-w-0 grow" value={value} placeholder={placeholder} autoComplete={type === "email" ? "email" : "tel"} aria-invalid={error !== null} aria-describedby={error ? errorId : undefined} onChange={(e) => onChange(e.target.value)} />
      </span>
      {error !== null && (
        <span id={errorId} className="text-[13px] text-crit">
          {error}
        </span>
      )}
    </div>
  );
}

const STEP_ICON: Record<TestStepRow["channel"], IconName> = { email: "email", sms: "sms", call: "call" };

function RunPanel({ tab, starting }: { tab: TestRunTabView; starting: boolean }) {
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
      {tab.noTestSinceEdit && run !== null && !starting && (
        <p className="flex gap-2 text-[13.5px] text-ink-2">
          <Icon name="warn" className="mt-0.5 size-4 flex-none text-pause" />
          <span>No test since the last edit. That’s optional: you can launch without one.</span>
        </p>
      )}
      <p className="border-t border-line pt-3 text-[13px] text-muted">
        Reply to any test message from your email or mobile to check that it stops the test. Email shows sent or failed only: Instantly doesn’t report delivery, and a sent email is not proof it reached the inbox. Test sends count against each sender’s daily limit like any send.
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
              {state !== "" && <span className={`whitespace-nowrap text-[13.5px] ${now ? "font-medium text-you" : s.state === "failed" ? "text-crit" : "text-muted"}`}>{state}</span>}
            </li>
          );
        })}
      </ol>
    </>
  );
}
