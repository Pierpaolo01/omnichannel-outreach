import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation, useSearch } from "wouter";
import { MERGE_FIELDS } from "../../domain/sequence/copy.ts";
import type { BeforeLaunchView, CampaignDefinition, EmailProviderStatus, StepDefinition, TrackDefinition } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { campaignPath } from "../pages/CampaignPage.tsx";
import {
  WEEK,
  emailTrackOf,
  fallbackIn,
  fieldLabel,
  fieldsOf,
  hourLabel,
  liveSteps,
  newEmailTrack,
  newStep,
  removeStep,
  setWindow,
  threadSubjectOf,
  stepBlockers,
  trackSummary,
  windowHours,
  withFallback,
} from "./model.ts";
import type { SequenceEditor } from "./useSequence.ts";

const LATER = "SMS and phone tracks, and connecting tracks together or after one another, arrive with later releases.";

/** The Sequence tab: the canvas, and the selected track's inspector beside it. */
export function SequenceTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const track = emailTrackOf(editor.draft);
  const selected = track && params.get("track") === track.id ? track : undefined;
  const openStep = params.get("step");
  const select = (trackId: string | null, stepId?: string) =>
    navigate(trackId ? `${campaignPath(campaignId)}?track=${encodeURIComponent(trackId)}${stepId ? `&step=${encodeURIComponent(stepId)}` : ""}` : campaignPath(campaignId), { replace: true });
  // Focus moves deliberately when the control holding it goes away (PR 41 verification, F3):
  // closing the inspector returns it to the track, and adding the first track moves it to
  // Email 1's subject.
  const node = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<{ to: "node" } | { to: "subject"; stepId: string } | null>(null);
  useEffect(() => {
    if (!focusNext) return;
    const target = focusNext.to === "node" ? node.current : document.getElementById(`subject-${focusNext.stepId}`);
    if (target) {
      target.focus();
      setFocusNext(null);
    }
  }, [focusNext, selected, openStep]);
  const coverage = useApi<BeforeLaunchView>(`/api/campaigns/${encodeURIComponent(campaignId)}/before-launch?v=${editor.view.definitionVersion}`);
  const facts = coverage.result.state === "ready" ? coverage.result.data : coverage.result.state === "loading" ? null : null;

  if (!track) {
    return (
      <div className={`rounded-box border border-line bg-raised bg-[radial-gradient(var(--color-line-strong)_1px,transparent_1px)] bg-[length:18px_18px] px-6 py-14 h-[max(470px,calc(100dvh-306px))]`}>
        <div className="mx-auto flex max-w-[520px] flex-col items-start gap-2.5">
          <h2 className="text-[19px]">Add the first channel track</h2>
          <p className="text-ink-2">A track is one channel’s first message and its follow-ups.</p>
          {facts && (
            <p className="flex flex-wrap gap-x-4 text-[13px] text-muted">
              <span>
                <b className="font-semibold text-base-content">{facts.coverage.email}</b> {facts.coverage.email === 1 ? "lead has" : "leads have"} an email
              </span>
              <span>
                <b className="font-semibold text-base-content">{facts.coverage.mobile}</b> a mobile
              </span>
              <span>
                <b className="font-semibold text-base-content">{facts.coverage.phone}</b> a phone number
              </span>
            </p>
          )}
          {editor.launched ? (
            <p className="text-[14px] text-muted">This campaign launched with no track.</p>
          ) : (
            <>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn gap-1.5 border-line-strong bg-base-100 font-medium"
                  onClick={() => {
                    const added = newEmailTrack();
                    editor.update((d) => ({ ...d, tracks: [...d.tracks, added] }));
                    select(added.id, added.steps[0]?.id);
                    if (added.steps[0]) setFocusNext({ to: "subject", stepId: added.steps[0].id });
                  }}
                >
                  <Icon name="email" className="size-4" />
                  Email track
                </button>
                <button type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled aria-describedby="later-tracks">
                  <Icon name="sms" className="size-4" />
                  SMS track
                </button>
                <button type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled aria-describedby="later-tracks">
                  <Icon name="call" className="size-4" />
                  Phone track
                </button>
              </div>
              <p id="later-tracks" className="text-[13px] text-muted">
                {LATER}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 items-start gap-4 ${selected ? "min-[1020px]:grid-cols-[minmax(0,1fr)_430px]" : ""}`}>
      <Canvas track={track} selected={selected !== undefined} editor={editor} node={node} onSelect={() => select(selected ? null : track.id)} />
      {selected && (
        <Inspector
          track={selected}
          editor={editor}
          facts={facts}
          factsFailed={coverage.result.state === "error"}
          onRetryFacts={coverage.retry}
          openStep={openStep ?? liveSteps(selected)[0]?.id ?? null}
          onOpenStep={(stepId) => select(selected.id, stepId ?? undefined)}
          onClose={() => {
            select(null);
            setFocusNext({ to: "node" });
          }}
        />
      )}
    </div>
  );
}

function Canvas({ track, selected, editor, node, onSelect }: { track: TrackDefinition; selected: boolean; editor: SequenceEditor; node: RefObject<HTMLButtonElement | null>; onSelect: () => void }) {
  const steps = liveSteps(track);
  const issues = new Set(steps.flatMap((s) => stepBlockers(s, editor.view.launch.blockers)).map((b) => JSON.stringify(b))).size + editor.view.launch.blockers.filter((b) => b.kind === "no_sender").length;
  return (
    <div data-testid="canvas" className={`flex min-w-0 flex-col rounded-box border border-line bg-raised bg-[radial-gradient(var(--color-line-strong)_1px,transparent_1px)] bg-[length:18px_18px] h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p id="later-tracks" className="max-w-[56ch] text-[12.5px] text-muted">
          {LATER}
        </p>
        <button type="button" className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium" disabled aria-describedby="later-tracks">
          <Icon name="plus" className="size-4" />
          Add track
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pb-10 pt-4">
        <span className="rounded-full bg-base-content px-3.5 py-1 text-[12.5px] font-semibold text-base-100">Launch</span>
        <span className="h-5 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        <span className="rounded-full border border-line-strong bg-base-100 px-2 text-[12px] text-ink-2">{editor.launched ? "at launch" : "starts at launch"}</span>
        <span className="h-5 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        <button
          ref={node}
          type="button"
          aria-pressed={selected}
          aria-label={`Email track: ${trackSummary(track)}${issues > 0 ? `, ${issues} to fix` : ""}. ${selected ? "Close" : "Open"} it in the inspector.`}
          onClick={onSelect}
          className={`flex w-[250px] max-w-full cursor-pointer flex-col gap-[3px] rounded-[11px] border bg-base-100 px-3 pb-3 pt-2.5 text-left hover:border-ink-2 ${
            selected ? "border-base-content shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-base-content)_14%,transparent)]" : issues > 0 ? "border-crit" : "border-line-strong"
          }`}
        >
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Icon name="email" className="size-[15px]" />
            Email
            {issues > 0 && <span className="ml-auto flex items-center gap-1 font-semibold text-crit before:size-[7px] before:rounded-full before:bg-current before:content-['']">{issues} to fix</span>}
          </span>
          <span className="text-[14.5px] font-semibold leading-[1.3]">Email track</span>
          <span className="text-[12.5px] text-muted">{trackSummary(track)}</span>
          <span className="mt-[5px] flex gap-[3px]" aria-hidden="true">
            {steps.map((s) => (
              <i key={s.id} className={`h-1 flex-1 rounded-sm ${s.body.trim() ? "bg-line-strong" : "shadow-[inset_0_0_0_1px_var(--color-crit)]"}`} />
            ))}
          </span>
        </button>
      </div>
    </div>
  );
}

interface InspectorProps {
  track: TrackDefinition;
  editor: SequenceEditor;
  facts: BeforeLaunchView | null;
  factsFailed: boolean;
  onRetryFacts: () => void;
  openStep: string | null;
  onOpenStep: (stepId: string | null) => void;
  onClose: () => void;
}

function Inspector({ track, editor, facts, factsFailed, onRetryFacts, openStep, onOpenStep, onClose }: InspectorProps) {
  const steps = liveSteps(track);
  const titleId = useId();
  const locked = editor.launched;
  const changeTrack = (change: (t: TrackDefinition) => TrackDefinition) =>
    editor.update((d: CampaignDefinition) => ({ ...d, tracks: d.tracks.map((t) => (t.id === track.id ? change(t) : t)) }));
  const changeStep = (stepId: string, change: (s: StepDefinition) => StepDefinition) => changeTrack((t) => ({ ...t, steps: t.steps.map((s) => (s.id === stepId ? change(s) : s)) }));
  return (
    <aside aria-labelledby={titleId} data-testid="inspector" className={`flex min-w-0 flex-col rounded-box border border-line bg-base-100 min-[1020px]:h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex items-start justify-between gap-2.5 border-b border-line px-[18px] pb-3.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-[18px]">
            Email track
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12.5px] text-ink-2">
            <Icon name="email" className="size-3.5" />
            {trackSummary(track)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SaveStatus editor={editor} />
          <button type="button" className="btn btn-sm btn-ghost px-1.5" onClick={onClose} aria-label="Close the email track">
            <Icon name="close" className="size-4" />
          </button>
        </div>
      </div>
      {/* Side by side, both panels fill the view below the tabs (at least 470px, as variant A), and the
          inspector scrolls on its own, so the canvas stays in view. The 306px are the campaign
          header, the tabs and the main area's bottom padding. */}
      <div data-testid="inspector-body" className="relative flex min-h-0 flex-1 flex-col gap-[18px] px-[18px] pb-5 pt-4 min-[1020px]:overflow-y-auto">
        {editor.save.kind === "error" && <ErrorState title="Your last change wasn’t saved." message={editor.save.message} onRetry={editor.retrySave} />}
        {editor.problems.length > 0 && (
          <p role="alert" className="rounded-field bg-crit-soft px-3 py-2 text-[13.5px] text-crit">
            {editor.problems.join(" ")} Nothing is saved until this is fixed.
          </p>
        )}
        {locked && <p className="rounded-field bg-raised px-3 py-2 text-[13.5px] text-ink-2">This campaign is running. Editing a running campaign arrives with a later release.</p>}
        {factsFailed && <ErrorState title="Lead counts for the fallbacks didn’t load." message="The copy still saves." onRetry={onRetryFacts} />}
        {/* Only the editing controls lock on a running campaign; every email still opens. */}
        <div role="group" aria-label="Emails" className="flex min-w-0 flex-col">
          {steps.map((step, i) => (
            <StepBlock
              key={step.id}
              step={step}
              index={i}
              steps={steps}
              open={openStep === step.id}
              facts={facts}
              editor={editor}
              onToggle={() => onOpenStep(openStep === step.id ? null : step.id)}
              onChange={(change) => changeStep(step.id, change)}
              locked={locked}
              onRemove={() => changeTrack((t) => removeStep(t, step.id))}
            />
          ))}
          {!locked && (
            <div className="mt-3">
              <button
                type="button"
                className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium"
                onClick={() => {
                  const added = newStep(steps.length === 0);
                  changeTrack((t) => ({ ...t, steps: [...t.steps, added] }));
                  onOpenStep(added.id);
                }}
              >
                <Icon name="plus" className="size-4" />
                {steps.length === 0 ? "Add the first email" : "Add follow-up"}
              </button>
            </div>
          )}
        </div>
        <TimingAndSender track={track} editor={editor} onWindow={(window) => changeTrack((t) => ({ ...t, window }))} />
      </div>
    </aside>
  );
}

function SaveStatus({ editor }: { editor: SequenceEditor }) {
  const text = editor.launched ? "" : editor.save.kind === "saving" ? "Saving…" : editor.save.kind === "saved" ? "Saved" : "";
  return (
    <span role="status" className="text-[12.5px] text-muted">
      {text}
    </span>
  );
}

interface StepProps {
  step: StepDefinition;
  index: number;
  steps: readonly StepDefinition[];
  open: boolean;
  facts: BeforeLaunchView | null;
  editor: SequenceEditor;
  onToggle: () => void;
  onChange: (change: (s: StepDefinition) => StepDefinition) => void;
  onRemove: () => void;
  locked: boolean;
}

function StepBlock({ step, index, steps, open, facts, editor, onToggle, onChange, onRemove, locked }: StepProps) {
  const name = `Email ${index + 1}`;
  const first = index === 0;
  const issues = stepBlockers(step, editor.view.launch.blockers).length;
  const bodyId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [waitText, setWaitText] = useState<string | null>(null);
  const threadSubject = threadSubjectOf(steps, index);
  const summary = first ? step.subject || "No subject yet" : step.threading === "continue_thread" ? "Continues the thread" : `New subject: ${step.subject || "none yet"}`;

  const insertField = (field: string) => {
    const el = textarea.current;
    const token = `{{${field}}}`;
    const at = el ? el.selectionStart : step.body.length;
    const end = el ? el.selectionEnd : step.body.length;
    onChange((s) => ({ ...s, body: s.body.slice(0, at) + token + s.body.slice(end) }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <>
      {!first && (
        <div className="relative flex flex-wrap items-center gap-2 py-[7px] pl-3.5 text-[13px] text-muted before:absolute before:bottom-0 before:left-[5px] before:top-0 before:border-l-[1.5px] before:border-dashed before:border-line-strong">
          <Icon name="clock" className="size-[15px]" />
          <label className="flex items-center gap-2">
            Wait
            <input
              disabled={locked}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              className="input input-sm w-[62px] border-line-strong text-right"
              value={waitText ?? String(step.waitDays)}
              onChange={(e) => {
                setWaitText(e.target.value);
                const n = e.target.value.trim() === "" ? Number.NaN : Number(e.target.value);
                onChange((s) => ({ ...s, waitDays: n }));
              }}
              onBlur={() => setWaitText(null)}
              aria-label={`Days to wait before ${name}`}
            />
          </label>
          days after Email {index}
        </div>
      )}
      <div className={`rounded-field border bg-base-100 ${open ? "border-line-strong" : "border-line"} ${first ? "" : ""}`}>
        <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="text-[14px] font-semibold">{name}</span>
          {!open && <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{summary}</span>}
          {open && <span className="flex-1" />}
          {issues > 0 && <span className="whitespace-nowrap text-[12.5px] font-semibold text-crit">{issues} to fix</span>}
          <Icon name="chevron" className={`size-4 text-muted ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <fieldset id={bodyId} disabled={locked} className="flex min-w-0 flex-col gap-2.5 px-3 pb-3.5 pt-0.5">
            <legend className="sr-only">{name}</legend>
            {!first && (
              <div role="radiogroup" aria-label={`How ${name} is sent`} className="flex flex-wrap gap-1.5">
                {(["continue_thread", "new_subject"] as const).map((mode) => (
                  <label
                    key={mode}
                    className={`flex cursor-pointer items-center gap-[7px] rounded-full py-[5px] pl-[9px] pr-[11px] text-[13.5px] ${
                      step.threading === mode ? "font-medium shadow-[inset_0_0_0_1.5px_var(--color-base-content)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
                    }`}
                  >
                    <input type="radio" className="radio radio-xs" name={`threading-${step.id}`} checked={step.threading === mode} onChange={() => onChange((s) => ({ ...s, threading: mode }))} />
                    {mode === "continue_thread" ? "Continue thread" : "New subject"}
                  </label>
                ))}
              </div>
            )}
            {first || step.threading === "new_subject" ? (
              <label className="flex items-center gap-2 text-[14px]">
                <span className="w-[54px] flex-none text-[13px] text-muted">Subject</span>
                <input
                  id={`subject-${step.id}`}
                  type="text"
                  className={`input min-w-0 flex-1 border-line-strong ${step.subject.trim() ? "" : "border-crit"}`}
                  value={step.subject}
                  onChange={(e) => onChange((s) => ({ ...s, subject: e.target.value }))}
                  aria-label={`${name} subject`}
                />
              </label>
            ) : (
              <div className="flex items-center gap-2 text-[14px]">
                <span className="w-[54px] flex-none text-[13px] text-muted">Subject</span>
                <span className="min-w-0 flex-1 rounded-field border border-dashed border-line-strong bg-raised px-2.5 py-1.5 text-muted [overflow-wrap:anywhere]">Re: {threadSubject || "the subject of the thread it continues"}</span>
              </div>
            )}
            <textarea
              ref={textarea}
              className={`textarea min-h-[150px] w-full [field-sizing:content] border-line-strong text-[14px] leading-[1.55] ${step.body.trim() ? "" : "border-crit bg-crit-soft/40"}`}
              value={step.body}
              placeholder="Write this email. Launch is blocked while it’s empty."
              onChange={(e) => onChange((s) => ({ ...s, body: e.target.value }))}
              aria-label={`${name} copy`}
            />
            <MergeFieldMenu onPick={insertField} />
            {/* Once launched the counts would leave out leads that ended, so none is shown (PR 41 council, item 4). */}
            <Fallbacks step={step} facts={locked ? null : facts} onChange={onChange} />
            {steps.length > 1 && !locked && (
              <div>
                <button type="button" className="btn btn-sm btn-ghost px-2 font-medium text-muted" onClick={onRemove}>
                  Remove {name}
                </button>
              </div>
            )}
          </fieldset>
        )}
      </div>
    </>
  );
}

function MergeFieldMenu({ onPick }: { onPick: (field: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className="btn btn-sm btn-ghost gap-1.5 px-2 font-medium" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" className="size-4" />
        Merge field
      </button>
      {open && (
        <ul id={menuId} aria-label="Insert a merge field" className="flex flex-wrap gap-1.5">
          {MERGE_FIELDS.map((field) => (
            <li key={field}>
              <button
                type="button"
                className="cursor-pointer rounded-[5px] bg-hand-soft px-1.5 py-0.5 text-[12.5px] font-semibold text-hand"
                onClick={() => {
                  onPick(field);
                  setOpen(false);
                }}
              >
                {fieldLabel(field)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Fallbacks({ step, facts, onChange }: { step: StepDefinition; facts: BeforeLaunchView | null; onChange: (change: (s: StepDefinition) => StepDefinition) => void }) {
  const fields = fieldsOf(step);
  if (fields.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]" aria-label="Merge fields in this email">
      {fields.map((field) => {
        const missing = facts?.mergeFields.find((f) => f.field === field)?.leadsMissing ?? null;
        const fallback = fallbackIn(step, field);
        const blocks = fallback === "" && missing !== null && missing > 0;
        return (
          <li key={field} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5">
            <span className={`rounded-[5px] px-1.5 text-[12.5px] font-semibold ${blocks ? "bg-crit-soft text-crit" : "bg-hand-soft text-hand"}`}>{fieldLabel(field)}</span>
            {facts !== null && missing === 0 ? (
              <span className="text-muted">Every lead has it</span>
            ) : (
              <span className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${blocks ? "text-crit" : "text-muted"}`}>
                <input
                  type="text"
                  className={`input input-sm w-[110px] ${blocks ? "border-crit" : "border-line-strong"}`}
                  placeholder="Fallback"
                  value={fallback}
                  onChange={(e) => onChange((s) => ({ ...s, subject: withFallback(s.subject, field, e.target.value), body: withFallback(s.body, field, e.target.value) }))}
                  aria-label={`Fallback for ${fieldLabel(field)}`}
                />
                {missing === null ? null : blocks ? (
                  <b className="font-semibold">
                    {missing} {missing === 1 ? "lead doesn’t" : "leads don’t"} have it. Add a fallback or remove the field.
                  </b>
                ) : (
                  <>for {missing} {missing === 1 ? "lead" : "leads"} without one</>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TimingAndSender({ track, editor, onWindow }: { track: TrackDefinition; editor: SequenceEditor; onWindow: (window: TrackDefinition["window"]) => void }) {
  const hours = windowHours(track.window);
  const days = track.window.map((w) => w.day);
  const locked = editor.launched;
  const zones = timeZones(editor.draft.timezone);
  const accounts = editor.view.accounts;
  return (
    <section aria-label="Timing and sender" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-muted">Timing and sender</h3>
      <dl className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-[9px] text-[14px] max-[480px]:grid-cols-1">
        <dt className="text-[13px] text-muted">Starts</dt>
        <dd>At launch</dd>
        <dt className="text-[13px] text-muted">Sends from</dt>
        <dd className="min-w-0">
          {accounts.length === 0 ? (
            <>
              <span className="font-semibold text-crit">No connected sender inbox.</span>
              <ProviderReason />
              <div className="text-[12.5px] text-muted">This track can’t send until an inbox is connected. Launch is blocked.</div>
            </>
          ) : (
            <>
              <ul>
                {accounts.map((a) => (
                  <li key={a.id} className="[overflow-wrap:anywhere]">
                    {a.label}
                    {!a.healthy && <span className="text-crit"> (disconnected)</span>}
                  </li>
                ))}
              </ul>
              <div className="text-[12.5px] text-muted">Each lead keeps one inbox for the whole campaign.</div>
            </>
          )}
        </dd>
        <dt className="text-[13px] text-muted">Sending window</dt>
        <dd>
          <fieldset disabled={locked} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <legend className="sr-only">Sending window</legend>
            <span role="group" aria-label="Sending days" className="inline-flex flex-wrap gap-[3px]">
              {WEEK.map((d) => {
                const on = days.includes(d.day);
                return (
                  <button
                    key={d.day}
                    type="button"
                    aria-pressed={on}
                    aria-label={d.name}
                    className={`grid h-6 w-7 cursor-pointer place-items-center rounded-[5px] text-[12px] font-semibold ${on ? "bg-base-content text-base-200" : "text-muted shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
                    onClick={() => onWindow(setWindow(on ? days.filter((x) => x !== d.day) : [...days, d.day], hours))}
                  >
                    {d.letter}
                  </button>
                );
              })}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[13.5px]">
              <select className="select select-sm w-[88px] border-line-strong" aria-label="Sending starts at" value={hours.start} onChange={(e) => onWindow(setWindow(days, { ...hours, start: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              to
              <select className="select select-sm w-[88px] border-line-strong" aria-label="Sending ends at" value={hours.end} onChange={(e) => onWindow(setWindow(days, { ...hours, end: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </span>
          </fieldset>
        </dd>
        <dt className="text-[13px] text-muted">Time zone</dt>
        <dd className="min-w-0">
          The lead’s local time
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
            <label htmlFor="campaign-zone">From the lead’s or company’s location, otherwise</label>
            <select
              id="campaign-zone"
              disabled={locked}
              className="select select-sm max-w-full border-line-strong text-[13px]"
              value={editor.draft.timezone}
              onChange={(e) => editor.update((d) => ({ ...d, timezone: e.target.value }))}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </dd>
      </dl>
    </section>
  );
}

/** One line on why no inbox is connected, from GET /api/email-provider; nothing if it is unknown. */
function ProviderReason() {
  const { result } = useApi<EmailProviderStatus>("/api/email-provider");
  if (result.state !== "ready") return null;
  const { provider, sending } = result.data;
  const reason = provider === "none" ? "No email provider is set up on this machine." : sending === "off" ? "Sending through Instantly is turned off for this run." : null;
  return reason ? <div className="text-[12.5px] text-ink-2">{reason}</div> : null;
}

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

export function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-line-strong bg-base-100 px-2 text-[12px] text-ink-2">{children}</span>;
}
