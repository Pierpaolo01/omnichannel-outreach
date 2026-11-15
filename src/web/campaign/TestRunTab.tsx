import { useId, useRef, useState, type SyntheticEvent } from "react";
import type { TestRunRead, TestRunTab as TestRunTabView, TestStepRow } from "../../shared/api.ts";
import { ApiRequestError, postJson, putJson } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { useLiveRead } from "../controls/useLiveRead.ts";
import { Icon, type IconName } from "../icons.tsx";
import { endingDetail, endingTitle, progressText, stepDetail, stepStateText, timeIn } from "./testRunWording.ts";
import type { SequenceEditor } from "./useSequence.ts";

/**
 * The Test run tab (ticket 21; campaign editor variant A, `shots/a-10-test.png`): the user's own test contacts, the
 * lead the test's copy is written for, Run test and Stop test, and the latest run step by step, from the server's read.
 */
export function TestRunTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const { read, refresh } = useLiveRead<TestRunTabView>(`/api/campaigns/${encodeURIComponent(campaignId)}/test-runs`);
  if (read.state === "error") return <ErrorState title="The test run didn’t load." message={read.message} onRetry={() => void refresh()} />;
  if (read.state === "loading")
    return (
      <div role="status" aria-busy="true" aria-label="Loading the test run" className="grid grid-cols-1 gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
        <div className="skeleton h-[360px] w-full" />
        <div className="skeleton h-[420px] w-full" />
      </div>
    );
  const tab = read.data;
  return (
    <div className="grid grid-cols-1 items-start gap-4 min-[1080px]:grid-cols-[380px_minmax(0,1fr)]">
      <Contacts campaignId={campaignId} tab={tab} editor={editor} onChange={refresh} />
      <RunPanel tab={tab} />
    </div>
  );
}

/** A press kept until its answer arrives: the same request id goes again on Try again, so the server answers it once. */
interface Press {
  readonly kind: "run" | "stop";
  readonly requestId: string;
  readonly body: unknown;
  readonly path: string;
}

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function Contacts({ campaignId, tab, editor, onChange }: { campaignId: string; tab: TestRunTabView; editor: SequenceEditor; onChange: () => Promise<void> }) {
  const emailId = useId();
  const mobileId = useId();
  const leadId = useId();
  const [email, setEmail] = useState(tab.contacts.email ?? "");
  const [mobile, setMobile] = useState(tab.contacts.mobile ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: "email" | "mobile"; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renderAs, setRenderAs] = useState<string | null>(null);
  const [press, setPress] = useState<Press | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const said = useRef<HTMLParagraphElement>(null);

  const dirty = email.trim() !== (tab.contacts.email ?? "") || mobile.trim() !== (tab.contacts.mobile ?? "");
  const lead = tab.leads.find((l) => l.id === renderAs) ?? tab.leads[0] ?? null;
  const running = tab.run?.running === true;
  const noContact = tab.contacts.email === null && tab.contacts.mobile === null;

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setFieldError(null);
    setSaveError(null);
    try {
      await putJson(`/api/campaigns/${encodeURIComponent(campaignId)}/test-contacts`, { email, mobile });
      await onChange();
      setSaved(true);
    } catch (error) {
      const body = error instanceof ApiRequestError ? (error.body as { error?: { field?: "email" | "mobile"; message?: string } } | null) : null;
      if (body?.error?.field) setFieldError({ field: body.error.field, message: body.error.message ?? "" });
      else setSaveError(error instanceof Error ? error.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  };

  const send = async (p: Press) => {
    setPress(p);
    setPending(true);
    setRefusal(null);
    try {
      await postJson(p.path, p.body);
      setPress(null);
      await onChange();
      said.current?.focus();
    } catch (error) {
      // A refusal is the server's answer: the press is done. A failure with no answer keeps the press for Try again.
      if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
        setPress(null);
        setRefusal(error.message);
        await onChange();
      } else setRefusal(`${error instanceof Error ? error.message : "The request failed."} It may or may not have arrived: Try again sends the same request, which the server answers once.`);
    } finally {
      setPending(false);
    }
  };

  const runTest = () => {
    if (!lead) return;
    const requestId = newRequestId();
    // Built once, from what the page shows: the lead, and the version of the sequence on the page. Try again resends it unchanged.
    void send({ kind: "run", requestId, path: `/api/campaigns/${encodeURIComponent(campaignId)}/test-runs`, body: { requestId, renderAs: lead.id, expect: { definitionVersion: editor.view.definitionVersion } } });
  };

  return (
    <section aria-labelledby="test-contacts" className="flex min-w-0 flex-col gap-3.5 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4">
      <h2 id="test-contacts" className="text-[19px]">
        Test contacts
      </h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
        <ContactField id={emailId} label="Your email" icon="email" value={email} onChange={(v) => { setEmail(v); setSaved(false); }} type="email" placeholder="you@example.com" error={fieldError?.field === "email" ? fieldError.message : tab.contacts.emailIsALead ? "A lead has this email now, so tests can’t use it. Use another of your own." : null} />
        <ContactField id={mobileId} label="Your mobile, for texts and the test call" icon="sms" value={mobile} onChange={(v) => { setMobile(v); setSaved(false); }} type="tel" placeholder="+44 7700 900000" error={fieldError?.field === "mobile" ? fieldError.message : tab.contacts.mobileIsALead ? "A lead has this number now, so tests can’t use it. Use another of your own." : null} />
        <p className="text-[13.5px] text-muted">Only contacts that are your own. They are never leads: a lead’s email or number is refused.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-sm border-line-strong bg-base-100 font-medium" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save contacts"}
          </button>
          <span className="text-[13px] text-muted" aria-live="polite">
            {saved && !dirty ? "Saved." : ""}
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
        {running ? (
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
                const requestId = newRequestId();
                void send({ kind: "stop", requestId, path: `/api/test-runs/${encodeURIComponent(tab.run.id)}/stop`, body: { requestId } });
              }}
            >
              {pending && press?.kind === "stop" ? "Stopping…" : "Stop test"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn border-line-strong bg-base-100 font-medium"
            disabled={!pending && (noContact || dirty || lead === null || editor.unsaved)}
            aria-disabled={pending}
            onClick={() => {
              if (pending) return;
              runTest();
            }}
          >
            {pending && press?.kind === "run" ? "Starting…" : tab.run ? "Run test again" : "Run test"}
          </button>
        )}
      </div>
      <p ref={said} tabIndex={-1} className="text-[13.5px] text-muted outline-offset-4" aria-live="polite">
        {noContact ? "Add your email or mobile, and save them, to run a test." : dirty ? "Save your contacts to run a test with them." : editor.unsaved ? "Your latest change to the sequence isn’t saved yet; a test runs the saved version." : ""}
      </p>
      {refusal !== null && (
        <div className="flex flex-wrap items-start gap-2.5 rounded-field bg-crit-soft px-3.5 py-3 text-[14px]">
          <Icon name="bad" className="mt-0.5 size-[18px] text-crit" />
          <span className="min-w-0 flex-[1_1_220px] [overflow-wrap:anywhere]">{refusal}</span>
          {press !== null && (
            <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => void send(press)}>
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

function RunPanel({ tab }: { tab: TestRunTabView }) {
  const run = tab.run;
  return (
    <section aria-labelledby="test-run-heading" className="flex min-w-0 flex-col gap-3 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4">
      {run === null ? (
        <>
          <h2 id="test-run-heading" className="text-[19px]">
            No test yet
          </h2>
          <p className="text-[14px] text-ink-2">A test sends the whole sequence to your own email and mobile, and puts its calls on your Calls list. It is optional: you can launch without one.</p>
        </>
      ) : (
        <RunRead run={run} tab={tab} />
      )}
      {tab.noTestSinceEdit && run !== null && (
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
          {run.running ? `Started at ${started}` : run.ending ? `${endingTitle(run.ending)}${run.endedAt ? ` at ${timeIn(tab.zone, run.endedAt, tab.at)}` : ""}` : `Started at ${started}`}
        </h2>
        <span className="flex items-center gap-2 text-[13.5px] text-muted">
          {run.running && <span className="size-[7px] rounded-full bg-you" aria-hidden="true" />}
          {progressText(run)}
        </span>
      </div>
      <p className="-mt-1.5 text-[13.5px] text-muted [overflow-wrap:anywhere]">
        {run.running ? "" : `Started at ${started}. `}Copy written for {run.renderAs.name}.{run.ending ? ` ${endingDetail(run.ending)}` : ""}
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
