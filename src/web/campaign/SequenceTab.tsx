import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation, useSearch } from "wouter";
import { MERGE_FIELDS } from "../../domain/sequence/copy.ts";
import type { BeforeLaunchView, CampaignDefinition, EmailProviderStatus, LaunchBlocker, SmsProviderStatus, StepDefinition, TrackDefinition } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { campaignPath } from "../pages/CampaignPage.tsx";
import { arrange, type ArrangeOperation } from "./arrangement.ts";
import {
  STEP_NOUN,
  WEEK,
  fallbackIn,
  fieldLabel,
  fieldsOf,
  hourLabel,
  liveSteps,
  newStep,
  removeStep,
  setWindow,
  threadSubjectOf,
  stepBlockers,
  trackName,
  trackSummary,
  trackTitle,
  windowHours,
  withFallback,
} from "./model.ts";
import { saveWording } from "./saveWording.ts";
import type { SequenceEditor } from "./useSequence.ts";

/** The address for every email collapsed. */
const NO_STEP = "none";

/** One wording, everywhere, for an inbox the provider reports cannot send (PR 41 council, item 7). */
export const CANNOT_SEND = "can’t send: the provider reports it unavailable";

const PHONE_LATER = "Phone tracks arrive with a later release.";

type FocusTarget =
  | { readonly to: "node"; readonly trackId: string }
  | { readonly to: "first" }
  | { readonly to: "add" }
  | { readonly to: "subject" | "toggle" | "body"; readonly stepId: string };

const liveMain = (def: CampaignDefinition) => def.tracks.filter((t) => !t.removed && t.branch === "main");

/** The Sequence tab: the canvas with every track and how they connect, and the selected track's inspector beside it. */
export function SequenceTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const tracks = liveMain(editor.draft);
  const selected = tracks.find((t) => t.id === params.get("track"));
  // `step=none` is every message collapsed, apart from no `step` at all, which opens the first.
  const openStep = params.get("step");
  const select = (trackId: string | null, stepId?: string) =>
    navigate(trackId ? `${campaignPath(campaignId)}?track=${encodeURIComponent(trackId)}${stepId ? `&step=${encodeURIComponent(stepId)}` : ""}` : campaignPath(campaignId), { replace: true });
  // Focus moves deliberately when the control holding it goes away (PR 41 verification, F3):
  // closing the inspector returns it to the track; adding a track moves it to the track's first
  // message; removing a track moves it to Add track.
  const focusTarget = useRef<FocusTarget | null>(null);
  const [, rendered] = useState(0);
  const setFocusNext = (target: FocusTarget) => {
    focusTarget.current = target;
    rendered((n) => n + 1);
  };
  // After every render: the control asked for, once it exists, takes focus.
  useEffect(() => {
    const next = focusTarget.current;
    if (!next) return;
    const first = selected ? liveSteps(selected)[0] : undefined;
    let target: HTMLElement | null;
    if (next.to === "node") target = document.getElementById(nodeId(next.trackId));
    else if (next.to === "add") target = document.getElementById(ADD_TRACK_ID);
    else if (next.to === "first") target = first ? (document.getElementById(`subject-${first.id}`) ?? document.getElementById(`body-${first.id}`) ?? document.getElementById(`step-toggle-${first.id}`)) : null;
    else target = document.getElementById(`${next.to === "toggle" ? "step-toggle" : next.to}-${next.stepId}`) ?? (next.to === "subject" ? document.getElementById(`body-${next.stepId}`) : null);
    if (target) {
      target.focus();
      focusTarget.current = null;
    }
  });
  const coverage = useApi<BeforeLaunchView>(`/api/campaigns/${encodeURIComponent(campaignId)}/before-launch?load=0&v=${editor.view.definitionVersion}`);
  const facts = coverage.result.state === "ready" ? coverage.result.data : null;

  /** Adds a track through the arrangement rule, opens it, and moves focus to its first message. */
  const add = (channel: "email" | "sms") => {
    let added: TrackDefinition | undefined;
    editor.update((d) => {
      const out = arrange(d, { kind: "add", channel });
      if (!out.ok) return d;
      added = out.added;
      return out.definition;
    });
    const first = added?.steps[0];
    if (!added || !first) return;
    select(added.id, first.id);
    setFocusNext({ to: channel === "email" ? "subject" : "body", stepId: first.id });
  };

  if (tracks.length === 0) {
    return (
      <div className={`rounded-box border border-line bg-raised bg-[radial-gradient(var(--color-line-strong)_1px,transparent_1px)] bg-[length:18px_18px] px-6 py-14 h-[max(470px,calc(100dvh-306px))]`}>
        <div className="mx-auto flex max-w-[520px] flex-col items-start gap-2.5">
          <h2 className="text-[19px]">Add the first channel track</h2>
          <p className="text-ink-2">A track is one channel’s first message and its follow-ups. Add one, then connect the next to it, together or after a delay.</p>
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
                <button id={ADD_TRACK_ID} type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled={editor.locked} onClick={() => add("email")}>
                  <Icon name="email" className="size-4" />
                  Email track
                </button>
                <button type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled={editor.locked} onClick={() => add("sms")}>
                  <Icon name="sms" className="size-4" />
                  SMS track
                </button>
                <button type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled aria-describedby="later-tracks">
                  <Icon name="call" className="size-4" />
                  Phone track
                </button>
              </div>
              <p id="later-tracks" className="text-[13px] text-muted">
                {PHONE_LATER}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 items-start gap-4 ${selected ? "min-[1020px]:grid-cols-[minmax(0,1fr)_430px]" : ""}`}>
      <Canvas tracks={tracks} selectedId={selected?.id ?? null} editor={editor} onSelect={(id) => select(selected?.id === id ? null : id)} onAdd={add} />
      {selected?.channel === "call" && (
        <PhoneTrackPanel
          track={selected}
          editor={editor}
          onClose={() => {
            select(null);
            setFocusNext({ to: "node", trackId: selected.id });
          }}
        />
      )}
      {selected && selected.channel !== "call" && (
        <Inspector
          key={selected.id}
          track={selected}
          editor={editor}
          facts={facts}
          factsFailed={coverage.result.state === "error"}
          onRetryFacts={coverage.retry}
          openStep={openStep === NO_STEP ? null : (openStep ?? liveSteps(selected)[0]?.id ?? null)}
          onOpenStep={(stepId) => select(selected.id, stepId ?? NO_STEP)}
          onFocusStep={(stepId) => setFocusNext({ to: "toggle", stepId })}
          onLoadedStored={() => setFocusNext({ to: "first" })}
          onClose={() => {
            select(null);
            setFocusNext({ to: "node", trackId: selected.id });
          }}
          onRemoved={() => {
            select(null);
            setFocusNext({ to: "add" });
          }}
        />
      )}
    </div>
  );
}

const ADD_TRACK_ID = "add-track";
/** The width one track node takes beside another: the node and the space around it. */
const NODE_SPAN = 230 + 24;

/** An element's content width, kept current as it resizes; null until measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry ? entry.contentRect.width : null));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
/**
 * One of several tracks hanging from the same point: a line joins it to its neighbours at the top,
 * so tracks that start together read as one fork.
 */
const JOINED =
  "relative px-3 before:absolute before:left-0 before:right-1/2 before:top-0 before:border-t-[1.5px] before:border-line-strong after:absolute after:left-1/2 after:right-0 after:top-0 after:border-t-[1.5px] after:border-line-strong first:before:hidden last:after:hidden";
const nodeId = (trackId: string) => `track-node-${trackId}`;
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** How a track starts, in words: "at launch", or "after the email track finishes, plus 2 days". */
export function startsText(def: CampaignDefinition, track: TrackDefinition): string {
  if (track.start.kind === "entry") return "at launch";
  const before = def.tracks.find((t) => t.id === (track.start as { trackId: string }).trackId);
  return `after ${before ? trackName(def, before) : "another track"} finishes, plus ${days(track.start.delayDays)}`;
}

/** The launch blockers on one track: empty copy and fields with no fallback in its messages, and no connected sender. */
export function trackIssues(track: TrackDefinition, blockers: readonly LaunchBlocker[]): number {
  return new Set(liveSteps(track).flatMap((s) => stepBlockers(s, blockers).filter((b) => b.kind !== "empty_copy" || b.trackId === track.id)).map((b) => JSON.stringify(b))).size + blockers.filter((b) => b.kind === "no_sender" && b.trackId === track.id).length;
}

/**
 * The canvas: the Launch point, every track that starts at launch hanging from it ("together" when
 * there are several), and every track that starts after another hanging from that one with its
 * delay. Two tracks that start at the same point are together (ADR 0003, ticket 13b).
 */
function Canvas({ tracks, selectedId, editor, onSelect, onAdd }: { tracks: readonly TrackDefinition[]; selectedId: string | null; editor: SequenceEditor; onSelect: (trackId: string) => void; onAdd: (channel: "email" | "sms") => void }) {
  const live = new Set(tracks.map((t) => t.id));
  const roots = tracks.filter((t) => t.start.kind === "entry" || !live.has(t.start.trackId));
  const childrenOf = (id: string) => tracks.filter((t) => t.start.kind === "after" && t.start.trackId === id);
  const rootLabel = roots.length > 1 ? "together" : editor.launched ? "at launch" : "starts at launch";
  // Side by side while the widest row of tracks fits the canvas; stacked in one column otherwise,
  // so nothing scrolls sideways or clips at any width (DESIGN.md, Layout).
  const leaves = (t: TrackDefinition, depth = 0): number => (depth > tracks.length ? 1 : Math.max(1, childrenOf(t.id).reduce((n, c) => n + leaves(c, depth + 1), 0)));
  const needed = roots.reduce((n, t) => n + leaves(t), 0) * NODE_SPAN + 16;
  const area = useRef<HTMLDivElement>(null);
  const width = useWidth(area);
  const stacked = width !== null && needed > width;
  const row = stacked ? "flex flex-col items-center" : "flex justify-center";
  const joined = stacked ? "" : JOINED;
  const branch = (track: TrackDefinition, label: string, depth: number): ReactNode => {
    const children = depth > tracks.length ? [] : childrenOf(track.id);
    return (
      <div className="flex flex-col items-center">
        <span className="h-3 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        <Pill>{label}</Pill>
        <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        <TrackNode track={track} def={editor.draft} selected={selectedId === track.id} blockers={editor.view.launch.blockers} launched={editor.launched} onSelect={() => onSelect(track.id)} />
        {children.length > 0 && (
          <>
            <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
            <ul aria-label={`Tracks after ${trackName(editor.draft, track)}`} className={row}>
              {children.map((c) => (
                <li key={c.id} className={joined}>
                  {branch(c, `after · ${c.start.kind === "after" ? days(c.start.delayDays) : ""}`, depth + 1)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  };
  return (
    <div data-testid="canvas" className={`flex min-w-0 flex-col rounded-box border border-line bg-raised bg-[radial-gradient(var(--color-line-strong)_1px,transparent_1px)] bg-[length:18px_18px] h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          <span className="w-4 border-t-[1.5px] border-line-strong" aria-hidden="true" />
          together or after
        </p>
        {!editor.launched && <AddTrackMenu disabled={editor.locked} onAdd={onAdd} />}
      </div>
      {/* Centred while the tracks fit side by side; stacked in one column when they would not. */}
      <div ref={area} className="min-h-0 flex-1 overflow-auto px-1 pb-10 pt-4">
        <div className={`mx-auto flex flex-col items-center ${stacked ? "" : "w-max"}`}>
          <span className="rounded-full bg-base-content px-3.5 py-1 text-[12.5px] font-semibold text-base-100">Launch</span>
          <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
          <ul aria-label="Tracks that start at launch" className={row}>
            {roots.map((t) => (
              <li key={t.id} className={joined}>
                {branch(t, rootLabel, 0)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function TrackNode({ track, def, selected, blockers, launched, onSelect }: { track: TrackDefinition; def: CampaignDefinition; selected: boolean; blockers: readonly LaunchBlocker[]; launched: boolean; onSelect: () => void }) {
  const steps = liveSteps(track);
  const issues = launched ? 0 : trackIssues(track, blockers);
  const title = trackTitle(def, track);
  return (
    <button
      id={nodeId(track.id)}
      type="button"
      aria-pressed={selected}
      aria-label={`${title}: ${trackSummary(track)}${issues > 0 ? `, ${issues} to fix` : ""}. Starts ${startsText(def, track)}. ${selected ? "Close" : "Open"} it in the inspector.`}
      onClick={onSelect}
      className={`flex w-[230px] max-w-full cursor-pointer flex-col gap-[3px] rounded-[11px] border bg-base-100 px-3 pb-3 pt-2.5 text-left hover:border-ink-2 ${
        selected ? "border-base-content shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-base-content)_14%,transparent)]" : issues > 0 ? "border-crit" : "border-line-strong"
      }`}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
        <Icon name={track.channel === "call" ? "call" : track.channel === "sms" ? "sms" : "email"} className="size-[15px]" />
        {track.channel === "call" ? "Phone" : track.channel === "sms" ? "SMS" : "Email"}
        {issues > 0 && <span className="ml-auto flex items-center gap-1 font-semibold text-crit before:size-[7px] before:rounded-full before:bg-current before:content-['']">{issues} to fix</span>}
      </span>
      <span className="text-[14.5px] font-semibold leading-[1.3]">{title}</span>
      <span className="text-[12.5px] text-muted">{trackSummary(track)}</span>
      <span className="mt-[5px] flex gap-[3px]" aria-hidden="true">
        {steps.map((s) => (
          <i key={s.id} className={`h-1 flex-1 rounded-sm ${s.body.trim() || track.channel === "call" ? "bg-line-strong" : "shadow-[inset_0_0_0_1px_var(--color-crit)]"}`} />
        ))}
      </span>
    </button>
  );
}

/** Add track: a short menu of the channels a track can use. Phone tracks arrive later. */
function AddTrackMenu({ disabled, onAdd }: { disabled: boolean; onAdd: (channel: "email" | "sms") => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && open && close()}>
      <button ref={button} id={ADD_TRACK_ID} type="button" className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium" disabled={disabled} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" className="size-4" />
        Add track
      </button>
      {open && (
        <ul id={menuId} aria-label="Add a track" className="absolute right-0 top-[calc(100%+6px)] z-10 flex w-[240px] flex-col gap-0.5 rounded-field border border-line-strong bg-base-100 p-1.5">
          {(["email", "sms"] as const).map((channel) => (
            <li key={channel}>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[14px] hover:bg-raised"
                onClick={() => {
                  setOpen(false);
                  onAdd(channel);
                }}
              >
                <Icon name={channel} className="size-4 text-muted" />
                {channel === "email" ? "Email track" : "SMS track"}
              </button>
            </li>
          ))}
          <li>
            <button type="button" disabled aria-describedby="phone-later" className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[14px] text-muted">
              <Icon name="call" className="size-4" />
              Phone track
            </button>
            <p id="phone-later" className="px-2.5 pb-1.5 text-[12.5px] text-muted">
              {PHONE_LATER}
            </p>
          </li>
        </ul>
      )}
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
  onFocusStep: (stepId: string) => void;
  onLoadedStored: () => void;
  onClose: () => void;
  onRemoved: () => void;
}

function Inspector({ track, editor, facts, factsFailed, onRetryFacts, openStep, onOpenStep, onFocusStep, onLoadedStored, onClose, onRemoved }: InspectorProps) {
  const steps = liveSteps(track);
  const titleId = useId();
  const sms = track.channel === "sms";
  const noun = STEP_NOUN[sms ? "sms" : "email"];
  // One lock from the editor state, read by every authoring control (PR 41 council, items 9 and 12).
  const locked = editor.locked;
  const [removal, setRemoval] = useState<string | null>(null);
  const changeTrack = (change: (t: TrackDefinition) => TrackDefinition) =>
    editor.update((d: CampaignDefinition) => ({ ...d, tracks: d.tracks.map((t) => (t.id === track.id ? change(t) : t)) }));
  const changeStep = (stepId: string, change: (s: StepDefinition) => StepDefinition) => changeTrack((t) => ({ ...t, steps: t.steps.map((s) => (s.id === stepId ? change(s) : s)) }));
  const name = trackName(editor.draft, track);
  return (
    <aside aria-labelledby={titleId} data-testid="inspector" className={`flex min-w-0 flex-col rounded-box border border-line bg-base-100 min-[1020px]:h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex items-start justify-between gap-2.5 border-b border-line px-[18px] pb-3.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-[18px]">
            {trackTitle(editor.draft, track)}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12.5px] text-ink-2">
            <Icon name={sms ? "sms" : "email"} className="size-3.5" />
            {trackSummary(track)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SaveStatus editor={editor} />
          <button type="button" className="btn btn-sm btn-ghost px-1.5" onClick={onClose} aria-label={`Close ${name}`}>
            <Icon name="close" className="size-4" />
          </button>
        </div>
      </div>
      {/* Side by side, both panels fill the view below the tabs (at least 470px, as variant A), and the
          inspector scrolls on its own, so the canvas stays in view. The 306px are the campaign
          header, the tabs and the main area's bottom padding. */}
      <div data-testid="inspector-body" className="relative flex min-h-0 flex-1 flex-col gap-[18px] px-[18px] pb-5 pt-4 min-[1020px]:overflow-y-auto">
        {editor.save.kind === "error" && <ErrorState title="Your last change wasn’t saved." message={editor.save.message} onRetry={editor.retrySave} />}
        {editor.save.kind === "conflict" && <ConflictNotice editor={editor} onLoaded={onLoadedStored} />}
        {editor.problems.length > 0 && (
          <p role="alert" className="rounded-field bg-crit-soft px-3 py-2 text-[13.5px] text-crit">
            {editor.problems.join(" ")} Nothing is saved until this is fixed.
          </p>
        )}
        {editor.launched && <p className="rounded-field bg-raised px-3 py-2 text-[13.5px] text-ink-2">This campaign is running. Editing a running campaign arrives with a later release.</p>}
        {(editor.launching || editor.loading) && (
          <p role="status" className="rounded-field bg-raised px-3 py-2 text-[13.5px] text-ink-2">
            {editor.launching ? "Launching. Editing is paused until the launch answers." : "Loading the saved version. Editing is paused until it arrives."}
          </p>
        )}
        {factsFailed && <ErrorState title="Lead counts for the fallbacks didn’t load." message="The copy still saves." onRetry={onRetryFacts} />}
        {/* Only the editing controls lock on a running campaign; every message still opens. */}
        <div role="group" aria-label={sms ? "Texts" : "Emails"} className="flex min-w-0 flex-col">
          {steps.map((step, i) => (
            <StepBlock
              key={step.id}
              channel={sms ? "sms" : "email"}
              step={step}
              index={i}
              steps={steps}
              open={openStep === step.id}
              facts={facts}
              editor={editor}
              onToggle={() => onOpenStep(openStep === step.id ? null : step.id)}
              onChange={(change) => changeStep(step.id, change)}
              locked={locked}
              onRemove={() => {
                // Focus goes to the message that takes this one's place, or the one before the last.
                const survivor = steps[i + 1] ?? steps[i - 1];
                changeTrack((t) => removeStep(t, step.id));
                if (survivor) onFocusStep(survivor.id);
              }}
            />
          ))}
          {!locked && (
            <div className="mt-3">
              <button
                type="button"
                className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium"
                onClick={() => {
                  const added = newStep(steps.length === 0);
                  changeTrack((t) => ({ ...t, steps: [...t.steps, sms ? { ...added, threading: "new_subject" } : added] }));
                  onOpenStep(added.id);
                }}
              >
                <Icon name="plus" className="size-4" />
                {steps.length === 0 ? `Add the first ${noun.toLowerCase()}` : "Add follow-up"}
              </button>
            </div>
          )}
        </div>
        <TimingAndSender track={track} editor={editor} onWindow={(window) => changeTrack((t) => ({ ...t, window }))} />
        {!editor.launched && (
          <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3.5">
            <button
              type="button"
              className="btn btn-sm border-line-strong bg-base-100 font-medium"
              disabled={locked}
              aria-describedby={removal ? `${titleId}-removal` : undefined}
              onClick={() => {
                const out = arrange(editor.draft, { kind: "remove", trackId: track.id });
                if (!out.ok) {
                  setRemoval(out.reason);
                  return;
                }
                editor.update((d) => {
                  const again = arrange(d, { kind: "remove", trackId: track.id });
                  return again.ok ? again.definition : d;
                });
                onRemoved();
              }}
            >
              Remove {name.replace(/^the /, "this ")}
            </button>
            {removal && (
              <p id={`${titleId}-removal`} role="alert" className="text-[13px] font-medium text-crit">
                {removal}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * A phone track, defined over HTTP since ticket 14a: shown truthfully, and not editable here until
 * the phone track's editor arrives. Other tracks may start after it; it holds them until its call is
 * logged (ADR 0003, ticket 13b).
 */
function PhoneTrackPanel({ track, editor, onClose }: { track: TrackDefinition; editor: SequenceEditor; onClose: () => void }) {
  const titleId = useId();
  const name = trackName(editor.draft, track);
  const days = WEEK.filter((d) => track.window.some((w) => w.day === d.day)).map((d) => d.name);
  const hours = windowHours(track.window);
  return (
    <aside aria-labelledby={titleId} data-testid="inspector" className="flex min-w-0 flex-col rounded-box border border-line bg-base-100 min-[1020px]:h-[max(470px,calc(100dvh-306px))]">
      <div className="flex items-start justify-between gap-2.5 border-b border-line px-[18px] pb-3.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-[18px]">
            {trackTitle(editor.draft, track)}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12.5px] text-ink-2">
            <Icon name="call" className="size-3.5" />
            {trackSummary(track)}
          </span>
        </div>
        <button type="button" className="btn btn-sm btn-ghost px-1.5" onClick={onClose} aria-label={`Close ${name}`}>
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-[18px] px-[18px] pb-5 pt-4">
        <p className="rounded-field bg-raised px-3 py-2 text-[13.5px] text-ink-2">Phone tracks are edited with a later release. This one is shown as it was set up: one call, placed on your list when it is due. The tracks after it start once you log the call.</p>
        <dl className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-[9px] text-[14px] max-[480px]:grid-cols-1">
          <dt className="text-[13px] text-muted">Starts</dt>
          <dd>{capitalise(startsText(editor.draft, track))}</dd>
          <dt className="text-[13px] text-muted">Calling hours</dt>
          <dd>
            {days.join(", ") || "No days"}, {hourLabel(hours.start)} to {hourLabel(hours.end)}, the lead’s local time
          </dd>
        </dl>
      </div>
    </aside>
  );
}

function SaveStatus({ editor }: { editor: SequenceEditor }) {
  const text = saveWording(editor.save, editor.launched).label ?? "";
  return (
    <span role="status" className="text-[12.5px] text-muted">
      {text}
    </span>
  );
}

interface StepProps {
  channel: "email" | "sms";
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

function StepBlock({ channel, step, index, steps, open, facts, editor, onToggle, onChange, onRemove, locked }: StepProps) {
  const sms = channel === "sms";
  const noun = STEP_NOUN[channel];
  const name = `${noun} ${index + 1}`;
  const first = index === 0;
  const issues = stepBlockers(step, editor.view.launch.blockers).length;
  const bodyId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [waitText, setWaitText] = useState<string | null>(null);
  const threadSubject = threadSubjectOf(steps, index);
  const summary = sms ? step.body.trim() || "No message yet" : first ? step.subject || "No subject yet" : step.threading === "continue_thread" ? "Continues the thread" : `New subject: ${step.subject || "none yet"}`;

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
          days after {noun} {index}
        </div>
      )}
      <div className={`rounded-field border bg-base-100 ${open ? "border-line-strong" : "border-line"} ${first ? "" : ""}`}>
        <button id={`step-toggle-${step.id}`} type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="text-[14px] font-semibold">{name}</span>
          {!open && <span className="line-clamp-1 min-w-0 flex-1 text-[13px] text-muted [overflow-wrap:anywhere]">{summary}</span>}
          {open && <span className="flex-1" />}
          {issues > 0 && <span className="whitespace-nowrap text-[12.5px] font-semibold text-crit">{issues} to fix</span>}
          <Icon name="chevron" className={`size-4 text-muted ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <fieldset id={bodyId} disabled={locked} className="flex min-w-0 flex-col gap-2.5 px-3 pb-3.5 pt-0.5">
            <legend className="sr-only">{name}</legend>
            {!first && !sms && (
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
            {sms ? null : first || step.threading === "new_subject" ? (
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
              id={`body-${step.id}`}
              className={`textarea ${sms ? "min-h-[96px]" : "min-h-[150px]"} w-full [field-sizing:content] border-line-strong text-[14px] leading-[1.55] ${step.body.trim() ? "" : "border-crit bg-crit-soft/40"}`}
              value={step.body}
              placeholder={`Write this ${noun.toLowerCase()}. Launch is blocked while it’s empty.`}
              onChange={(e) => onChange((s) => ({ ...s, body: e.target.value }))}
              aria-label={`${name} ${sms ? "message" : "copy"}`}
              aria-describedby={sms ? `${bodyId}-count` : undefined}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MergeFieldMenu onPick={insertField} />
              {sms && (
                <span id={`${bodyId}-count`} className="text-[12.5px] text-muted">
                  {step.body.length.toLocaleString("en-GB")} {step.body.length === 1 ? "character" : "characters"}, before merge fields are filled in
                </span>
              )}
            </div>
            {/* Once launched the counts would leave out leads that ended, so none is shown (PR 41 council, item 4). */}
            <Fallbacks step={step} noun={noun} facts={locked ? null : facts} onChange={onChange} />
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

function Fallbacks({ step, noun, facts, onChange }: { step: StepDefinition; noun: string; facts: BeforeLaunchView | null; onChange: (change: (s: StepDefinition) => StepDefinition) => void }) {
  const fields = fieldsOf(step);
  if (fields.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]" aria-label={`Merge fields in this ${noun.toLowerCase()}`}>
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
  const locked = editor.locked;
  const zones = timeZones(editor.draft.timezone);
  const sms = track.channel === "sms";
  const accounts = editor.view.accounts.filter((a) => a.channel === (sms ? "sms" : "email"));
  return (
    <section aria-label="Timing and sender" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-muted">Timing and sender</h3>
      <dl className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-[9px] text-[14px] max-[480px]:grid-cols-1">
        <dt className="text-[13px] text-muted">Starts</dt>
        <dd className="min-w-0">
          <StartsControl track={track} editor={editor} />
        </dd>
        <dt className="text-[13px] text-muted">Sends from</dt>
        <dd className="min-w-0">
          {accounts.length === 0 ? (
            <>
              <span className="font-semibold text-crit">{sms ? "No connected SMS number." : "No connected sender inbox."}</span>
              {sms ? <SmsProviderReason /> : <ProviderReason />}
              <div className="text-[12.5px] text-muted">This track can’t send until {sms ? "a number" : "an inbox"} is connected. Launch is blocked.</div>
            </>
          ) : (
            <>
              <ul>
                {accounts.map((a) => (
                  <li key={a.id} className="[overflow-wrap:anywhere]">
                    {a.label}
                    {sms && <span className="text-muted"> · at most {a.capacity} texts a day across campaigns</span>}
                    {!a.healthy && <span className="text-crit"> {CANNOT_SEND}</span>}
                  </li>
                ))}
              </ul>
              <div className="text-[12.5px] text-muted">Each lead keeps one {sms ? "number" : "inbox"} for the whole campaign.</div>
            </>
          )}
          {sms && (
            <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] text-muted" aria-label="What limits texts">
              <li>Texts go only to a decision maker’s own mobile. A lead without one, and every company lead, skips this track, and the tracks after it start.</li>
              <li>A text has no subject.</li>
              <li>A mobile already in another campaign’s conversation with a number is texted from another number. If none is free, this track waits for that lead and shows in Needs attention.</li>
            </ul>
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

/**
 * How a track starts: at launch, or after another track has finished all its steps, plus a delay in
 * days. Every change goes through the arrangement rule; a refused one (a cycle) is said beside the
 * control, which keeps focus, and the draft does not change (ADR 0003, ticket 13b).
 */
function StartsControl({ track, editor }: { track: TrackDefinition; editor: SequenceEditor }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [delayText, setDelayText] = useState<string | null>(null);
  const refusalId = useId();
  const others = liveMain(editor.draft).filter((t) => t.id !== track.id);
  const run = (op: ArrangeOperation): boolean => {
    const out = arrange(editor.draft, op);
    if (!out.ok) {
      setRefusal(out.reason);
      return false;
    }
    setRefusal(null);
    editor.update((d) => {
      const again = arrange(d, op);
      return again.ok ? again.definition : d;
    });
    return true;
  };
  if (editor.launched) return <>{capitalise(startsText(editor.draft, track))}</>;
  const after = track.start.kind === "after" ? track.start : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13.5px]">
        <select
          aria-label="How this track starts"
          aria-describedby={refusal ? refusalId : undefined}
          disabled={editor.locked}
          className="select select-sm w-auto max-w-full border-line-strong"
          value={after ? after.trackId : "entry"}
          onChange={(e) => {
            const value = e.target.value;
            setDelayText(null);
            run({ kind: "start", trackId: track.id, start: value === "entry" ? { kind: "entry" } : { kind: "after", trackId: value, delayDays: after?.delayDays ?? 0 } });
          }}
        >
          <option value="entry">At launch</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              After {trackName(editor.draft, o)}
            </option>
          ))}
        </select>
        {after && (
          <label className="flex items-center gap-1.5">
            finishes, plus
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              disabled={editor.locked}
              className="input input-sm w-[62px] border-line-strong text-right"
              value={delayText ?? String(after.delayDays)}
              aria-label="Days after that track finishes"
              aria-describedby={refusal ? refusalId : undefined}
              onChange={(e) => {
                setDelayText(e.target.value);
                const n = e.target.value.trim() === "" ? Number.NaN : Number(e.target.value);
                run({ kind: "delay", trackId: track.id, days: n });
              }}
              onBlur={() => {
                setDelayText(null);
                if (refusal?.startsWith("The delay")) setRefusal(null);
              }}
            />
            days
          </label>
        )}
      </div>
      {refusal && (
        <p id={refusalId} role="alert" className="text-[13px] font-medium text-crit">
          {refusal}
        </p>
      )}
      {after && !refusal && <p className="text-[12.5px] text-muted">Counted from when that track has sent its last step, or was skipped for the lead.</p>}
    </div>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why no SMS number is connected, from GET /api/sms-provider: the running app has no SMS provider. */
function SmsProviderReason() {
  const { result } = useApi<SmsProviderStatus>("/api/sms-provider");
  if (result.state !== "ready" || result.data.provider !== "none") return null;
  return <div className="text-[12.5px] text-ink-2">No SMS provider is set up, so no number can be connected yet.</div>;
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

/**
 * Another page changed the campaign since this one loaded it (ADR 0003 1.1.1): what was typed here
 * is kept, not saved, until the user loads the stored version.
 */
/**
 * The conflict and its one way out. Loading the stored version locks authoring until it arrives
 * (the editor's pending state, not this component's); once loaded, the alert and its button go, so
 * `onLoaded` moves focus somewhere stable (PR 41 re-check, F8).
 */
export function ConflictNotice({ editor, onLoaded }: { editor: SequenceEditor; onLoaded?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-box bg-crit-soft px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-[1_1_320px]">
        <b className="font-semibold text-crit">This campaign was changed elsewhere since this page loaded it.</b>{" "}
        <span className="text-ink-2">{saveWording(editor.save, editor.launched).conflict}</span>
      </span>
      <button
        type="button"
        className="btn btn-sm border-line-strong bg-base-100 font-medium"
        disabled={editor.loading}
        onClick={() => {
          void editor.loadStored().then((loaded) => {
            if (loaded) onLoaded?.();
          });
        }}
      >
        {editor.loading ? "Loading…" : "Load the saved version"}
      </button>
    </div>
  );
}

