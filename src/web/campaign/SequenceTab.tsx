import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation, useSearch } from "wouter";
import { skipLimitOf } from "../../domain/sequence/calls.ts";
import { MERGE_FIELDS } from "../../domain/sequence/copy.ts";
import { NO_WIN_BACK_BRANCH, declinedPathOf, winBackAvailable, type DeclinedPath } from "../../domain/sequence/definition.ts";
import type { BeforeLaunchView, CampaignDefinition, EmailProviderStatus, LaunchBlocker, SmsProviderStatus, StepDefinition, TrackDefinition } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { campaignPath } from "../pages/CampaignPage.tsx";
import { arrange, type ArrangeOperation } from "./arrangement.ts";
import { whyNoSmsNumber } from "./sms-wording.ts";
import {
  STEP_NOUN,
  WEEK,
  fallbackIn,
  fieldLabel,
  fieldsOf,
  hourLabel,
  liveSteps,
  DEFAULT_SKIP_LIMIT_DAYS,
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

type FocusTarget =
  | { readonly to: "node"; readonly trackId: string }
  | { readonly to: "script"; readonly trackId: string }
  | { readonly to: "first" }
  | { readonly to: "add" }
  | { readonly to: "add-win-back" }
  | { readonly to: "subject" | "toggle" | "body"; readonly stepId: string };

const liveMain = (def: CampaignDefinition) => def.tracks.filter((t) => !t.removed && t.branch === "main");
/** The win-back branch's live tracks (ticket 16b): drawn in their own box on the canvas, entered from a declined call. */
const liveWinBack = (def: CampaignDefinition) => def.tracks.filter((t) => !t.removed && t.branch === "win_back");
/** A branch's live tracks: a track arranges only with the tracks of its own branch (ADR 0003 7.1). */
const liveIn = (def: CampaignDefinition, branch: TrackDefinition["branch"]) => (branch === "win_back" ? liveWinBack(def) : liveMain(def));
/** What a declined call on this phone track does, as the engine reads its path (`declinedPathOf`; question Q14 for none set). */
const DECLINED_NOW: Record<DeclinedPath, string> = {
  stop: "A declined call stops the lead in this campaign.",
  continue: "After a declined call, the lead’s other channels continue, with no more calls in this campaign.",
  win_back: "A declined call moves the lead to this campaign’s win-back branch, with no more calls.",
};
/** The three paths as the reference's radio group words them (variant A, `a-05-phone.png`). */
const DECLINED_PATHS: readonly { readonly path: DeclinedPath; readonly label: string; readonly detail: string }[] = [
  { path: "stop", label: "Stop", detail: "The lead stops in this campaign." },
  { path: "continue", label: "Continue", detail: "The rest of the sequence runs on the other channels." },
  { path: "win_back", label: "Win back", detail: "The lead leaves the main sequence and gets the win-back branch instead." },
];
/** The path on a phone track's node, as the reference's card says it ("If declined: win back"). */
const DECLINED_ON_NODE: Record<DeclinedPath, string> = { stop: "stop", continue: "continue other channels", win_back: "win back" };

/** The Sequence tab: the canvas with every track and how they connect, and the selected track's inspector beside it. */
export function SequenceTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const tracks = liveMain(editor.draft);
  const branchTracks = liveWinBack(editor.draft);
  // A track of either branch opens in the inspector (ticket 16b): Before launch's blockers name branch tracks too.
  const selected = [...tracks, ...branchTracks].find((t) => t.id === params.get("track"));
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
    else if (next.to === "script") target = document.getElementById(scriptId(next.trackId));
    else if (next.to === "add") target = document.getElementById(ADD_TRACK_ID);
    else if (next.to === "add-win-back") target = document.getElementById(ADD_WIN_BACK_ID);
    else if (next.to === "first") target = first ? (document.getElementById(`subject-${first.id}`) ?? document.getElementById(`body-${first.id}`) ?? document.getElementById(`step-toggle-${first.id}`)) : null;
    else target = document.getElementById(`${next.to === "toggle" ? "step-toggle" : next.to}-${next.stepId}`) ?? (next.to === "subject" ? document.getElementById(`body-${next.stepId}`) : null);
    if (target) {
      target.focus();
      focusTarget.current = null;
    }
  });
  const coverage = useApi<BeforeLaunchView>(`/api/campaigns/${encodeURIComponent(campaignId)}/before-launch?load=0&v=${editor.view.definitionVersion}`);
  const facts = coverage.result.state === "ready" ? coverage.result.data : null;

  /**
   * Adds a track through the arrangement rule, to the main sequence or the win-back branch, opens it,
   * and moves focus to its first message, or a phone track's call script.
   */
  const add = (channel: "email" | "sms" | "call", branch: TrackDefinition["branch"] = "main") => {
    let added: TrackDefinition | undefined;
    editor.update((d) => {
      const out = arrange(d, { kind: "add", channel, branch });
      if (!out.ok) return d;
      added = out.added;
      return out.definition;
    });
    const first = added?.steps[0];
    if (!added || !first) return;
    select(added.id, channel === "call" ? undefined : first.id);
    setFocusNext(channel === "call" ? { to: "script", trackId: added.id } : { to: channel === "email" ? "subject" : "body", stepId: first.id });
  };

  if (tracks.length === 0 && branchTracks.length === 0) {
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
                <button type="button" className="btn gap-1.5 border-line-strong bg-base-100 font-medium" disabled={editor.locked} onClick={() => add("call")}>
                  <Icon name="call" className="size-4" />
                  Phone track
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 items-start gap-4 ${selected ? "min-[1020px]:grid-cols-[minmax(0,1fr)_430px]" : ""}`}>
      <Canvas tracks={tracks} branchTracks={branchTracks} selectedId={selected?.id ?? null} editor={editor} onSelect={(id) => select(selected?.id === id ? null : id)} onAdd={add} />
      {selected?.channel === "call" && (
        <PhoneInspector
          key={selected.id}
          track={selected}
          editor={editor}
          onEditBranch={() => {
            const first = branchTracks[0];
            if (!first) return;
            select(first.id);
            setFocusNext({ to: "node", trackId: first.id });
          }}
          onLoadedStored={() => setFocusNext({ to: "script", trackId: selected.id })}
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
            // A branch track's place is its branch: focus goes to the branch's own Add.
            setFocusNext({ to: selected.branch === "win_back" ? "add-win-back" : "add" });
          }}
        />
      )}
    </div>
  );
}

const ADD_TRACK_ID = "add-track";
/** The width one track node takes beside another: the node and the space around it. */
const NODE_WIDTH = 230;
const NODE_GAP = 24;
/** The outline (stacked canvas): each level's indent (11px, a 1.5px connector, 12px), and the narrowest a node may get. */
const OUTLINE_INDENT = 25;
const NODE_MIN = 176;

/** An element's content width, kept current as it resizes; null until measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  // Measured in a layout effect, so the first frame painted already has the width: measured after
  // paint, the canvas drew its tracks side by side for a frame and crossed its panel on a phone (CI
  // on 07bff24). The observer then follows every resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    setWidth(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
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
const scriptId = (trackId: string) => `call-script-${trackId}`;
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** How a track starts, in words: "at launch", or "after the email track finishes, plus 2 days". */
export function startsText(def: CampaignDefinition, track: TrackDefinition): string {
  if (track.start.kind === "entry") return track.branch === "win_back" ? "when the lead enters win-back" : "at launch";
  const before = def.tracks.find((t) => t.id === (track.start as { trackId: string }).trackId);
  return `after ${before ? trackName(def, before) : "another track"} finishes, plus ${days(track.start.delayDays)}`;
}

/** The launch blockers on one track: empty copy and fields with no fallback in its messages, and no connected sender. */
export function trackIssues(track: TrackDefinition, blockers: readonly LaunchBlocker[]): number {
  return new Set(liveSteps(track).flatMap((s) => stepBlockers(s, blockers).filter((b) => b.kind !== "empty_copy" || b.trackId === track.id)).map((b) => JSON.stringify(b))).size + blockers.filter((b) => b.kind === "no_sender" && b.trackId === track.id).length;
}

/** The layout of one branch's tracks as a tree: the tracks at its entry, and each track's children. */
function treeOf(tracks: readonly TrackDefinition[]) {
  const live = new Set(tracks.map((t) => t.id));
  const roots = tracks.filter((t) => t.start.kind === "entry" || !live.has(t.start.trackId));
  const childrenOf = (id: string) => tracks.filter((t) => t.start.kind === "after" && t.start.trackId === id);
  // A track's drawn width side by side: its node, or its row of children, each with 12px either side,
  // so every level of a chain adds 24px (review bot on 7401eb2).
  const span = (t: TrackDefinition, depth = 0): number => (depth > tracks.length ? NODE_WIDTH : Math.max(NODE_WIDTH, childrenOf(t.id).reduce((n, c) => n + span(c, depth + 1) + NODE_GAP, 0)));
  const needed = roots.reduce((n, t) => n + span(t) + NODE_GAP, 0) + 16;
  return { roots, childrenOf, needed };
}

/** The win-back box's padding and border on each side (ticket 16b): its tree has that much less room. */
const BRANCH_INSET = 18;
/** Room kept on the right of a stacked canvas for the declined edges' gutter (ticket 16b). */
const EDGE_GUTTER = 20;
/** The narrowest the win-back box is drawn side by side, so its name and empty state read on one or two lines. */
const BRANCH_MIN = 320;

/**
 * The canvas: the Launch point, every track that starts at launch hanging from it ("together" when
 * there are several), and every track that starts after another hanging from that one with its
 * delay. Two tracks that start at the same point are together (ADR 0003, ticket 13b). Below them, the
 * win-back branch (ticket 16b): a box holding its own tracks, drawn the same way from the point a lead
 * enters it, with a dashed "if declined" edge from each phone track whose declined path is win back.
 */
function Canvas({
  tracks,
  branchTracks,
  selectedId,
  editor,
  onSelect,
  onAdd,
}: {
  tracks: readonly TrackDefinition[];
  branchTracks: readonly TrackDefinition[];
  selectedId: string | null;
  editor: SequenceEditor;
  onSelect: (trackId: string) => void;
  onAdd: (channel: "email" | "sms" | "call", branch?: TrackDefinition["branch"]) => void;
}) {
  const main = treeOf(tracks);
  const branch = treeOf(branchTracks);
  // The branch is entered only from a declined call: its box shows once the campaign has a phone track,
  // or while it holds tracks (provisional, ticket 16b).
  const showBranch = branchTracks.length > 0 || tracks.some((t) => t.channel === "call");
  // The phone tracks a declined call on which moves the lead into the branch, as the engine reads each path.
  const intoBranch = branchTracks.length > 0 ? tracks.filter((t) => t.channel === "call" && declinedPathOf(t) === "win_back") : [];
  const rootLabel = main.roots.length > 1 ? "together" : editor.launched ? "at launch" : "starts at launch";
  const branchRootLabel = branch.roots.length > 1 ? "together" : "when they enter win-back";
  // Side by side while the widest row of tracks fits the canvas, the branch's within its box; stacked
  // in one column otherwise, so nothing scrolls sideways or clips at any width (DESIGN.md, Layout).
  const needed = Math.max(main.needed, showBranch ? Math.max(BRANCH_MIN, branch.needed + 2 * BRANCH_INSET) : 0);
  const area = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const width = useWidth(area);
  const stacked = width !== null && needed > width;
  // Stacked, the declined edges run down a gutter on the right, which no node may reach.
  const gutter = stacked && intoBranch.length > 0 ? EDGE_GUTTER : 0;
  const edges = useDeclinedEdges(content, intoBranch, stacked ? "stacked" : "row", gutter);
  const node = (t: TrackDefinition) => <TrackNode track={t} def={editor.draft} selected={selectedId === t.id} blockers={editor.view.launch.blockers} launched={editor.launched} onSelect={() => onSelect(t.id)} />;
  const tree = (of: ReturnType<typeof treeOf>, count: number, root: string, name: string, room: number) => <Tree of={of} count={count} node={node} rootLabel={root} name={name} def={editor.draft} stacked={stacked} room={room} />;
  const box = showBranch && (
    <WinBackBox empty={branchTracks.length === 0} launched={editor.launched} locked={editor.locked} stacked={stacked} gutter={gutter} onAdd={(channel) => onAdd(channel, "win_back")}>
      {branchTracks.length > 0 && tree(branch, branchTracks.length, branchRootLabel, "Win-back tracks that start when a lead enters the branch", (width ?? 0) - 2 * BRANCH_INSET)}
    </WinBackBox>
  );
  return (
    <div data-testid="canvas" data-layout={stacked ? "stacked" : "row"} className={`flex min-w-0 flex-col rounded-box border border-line bg-raised bg-[radial-gradient(var(--color-line-strong)_1px,transparent_1px)] bg-[length:18px_18px] h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-muted">
          <span className="flex items-center gap-2">
            <span className="w-4 border-t-[1.5px] border-line-strong" aria-hidden="true" />
            together or after
          </span>
          {showBranch && (
            <span className="flex items-center gap-2">
              <span className="w-4 border-t-[1.5px] border-dashed border-hand" aria-hidden="true" />
              declined path
            </span>
          )}
        </p>
        {!editor.launched && <AddTrackMenu disabled={editor.locked} onAdd={onAdd} />}
      </div>
      {/* A tree, centred, while the tracks fit side by side; an outline when they would not. Launch
          stays in view as the canvas scrolls. */}
      <div ref={area} className="min-h-0 flex-1 overflow-auto px-1 pb-10 pt-4">
        {stacked ? (
          <div ref={content} className="relative flex min-w-0 flex-col items-start px-3" style={{ paddingRight: 12 + gutter }}>
            <DeclinedEdges edges={edges} />
            <span data-testid="launch-point" className="sticky top-0 z-[1] rounded-full bg-base-content px-3.5 py-1 text-[12.5px] font-semibold text-base-100">
              Launch
            </span>
            {tracks.length > 0 ? tree(main, tracks.length, rootLabel, "Tracks that start at launch", width - gutter) : <NoMainTrack />}
            {box}
          </div>
        ) : (
          <div ref={content} className="relative mx-auto flex w-max flex-col items-center">
            <DeclinedEdges edges={edges} />
            <span data-testid="launch-point" className="sticky top-0 z-[1] rounded-full bg-base-content px-3.5 py-1 text-[12.5px] font-semibold text-base-100">
              Launch
            </span>
            {tracks.length > 0 ? (
              <>
                <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
                {tree(main, tracks.length, rootLabel, "Tracks that start at launch", 0)}
              </>
            ) : (
              <NoMainTrack />
            )}
            {box}
          </div>
        )}
      </div>
    </div>
  );
}

/** A canvas with win-back tracks but nothing in the main sequence (set over HTTP): said, not hidden. */
function NoMainTrack() {
  return <p className="mt-3 max-w-[420px] text-[13.5px] text-muted">No track starts at launch yet. Add one with Add track.</p>;
}

/**
 * One branch's tracks as a tree: side by side while they fit, otherwise an outline indented under the
 * track each starts after (council on 10121d3, item 2). `room` is the width the outline has; nodes
 * narrow with each level down to NODE_MIN, and a level that would make them narrower is not indented
 * further: its tracks sit at their parent's indent and their label names the parent (review bot on 7401eb2).
 */
function Tree({ of, count, node, rootLabel, name, def, stacked, room }: { of: ReturnType<typeof treeOf>; count: number; node: (t: TrackDefinition) => ReactNode; rootLabel: string; name: string; def: CampaignDefinition; stacked: boolean; room: number }) {
  const { roots, childrenOf } = of;
  const afterLabel = (t: TrackDefinition) => `after · ${t.start.kind === "after" ? days(t.start.delayDays) : ""}`;
  if (stacked) {
    const levels = Math.max(1, Math.floor((room - 24 - NODE_MIN) / OUTLINE_INDENT));
    const afterNamed = (parent: TrackDefinition) => (t: TrackDefinition) => `after ${trackName(def, parent)} · ${t.start.kind === "after" ? days(t.start.delayDays) : ""}`;
    const outline = (list: readonly TrackDefinition[], label: (t: TrackDefinition) => string, depth: number, listName: string): ReactNode => {
      const indented = depth < levels;
      return (
        <ul aria-label={listName} data-outline={indented ? "indented" : "named"} className={`flex min-w-0 flex-col gap-3 self-stretch pt-2 ${indented ? "ml-[11px] border-l-[1.5px] border-line-strong pl-3" : ""}`}>
          {list.map((t) => {
            const children = depth > count ? [] : childrenOf(t.id);
            return (
              <li key={t.id} className="flex min-w-0 flex-col items-start gap-1.5">
                <Pill>{label(t)}</Pill>
                {node(t)}
                {children.length > 0 && outline(children, depth + 1 < levels ? afterLabel : afterNamed(t), depth + 1, `Tracks after ${trackName(def, t)}`)}
              </li>
            );
          })}
        </ul>
      );
    };
    return outline(roots, () => rootLabel, 0, name);
  }
  const branch = (track: TrackDefinition, label: string, depth: number): ReactNode => {
    const children = depth > count ? [] : childrenOf(track.id);
    return (
      <div className="flex flex-col items-center">
        <span className="h-3 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        <Pill>{label}</Pill>
        <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
        {node(track)}
        {children.length > 0 && (
          <>
            <span className="h-4 border-l-[1.5px] border-line-strong" aria-hidden="true" />
            <ul aria-label={`Tracks after ${trackName(def, track)}`} className="flex justify-center">
              {children.map((c) => (
                <li key={c.id} className={JOINED}>
                  {branch(c, afterLabel(c), depth + 1)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  };
  return (
    <ul aria-label={name} className="flex justify-center">
      {roots.map((t) => (
        <li key={t.id} className={JOINED}>
          {branch(t, rootLabel, 0)}
        </li>
      ))}
    </ul>
  );
}

const ADD_WIN_BACK_ID = "add-win-back-track";

/**
 * The win-back branch on the canvas (ticket 16b; variant A draws it as a labelled box holding its own
 * tracks): a dashed box in `hand`, its name, its own Add (email or SMS: the branch holds no phone
 * track, so none is offered), and its tracks; while it has none, what it is and what makes it appear.
 */
function WinBackBox({ empty, launched, locked, stacked, gutter, onAdd, children }: { empty: boolean; launched: boolean; locked: boolean; stacked: boolean; gutter: number; onAdd: (channel: "email" | "sms") => void; children: ReactNode }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="win-back-branch"
      className={`relative z-[1] mt-12 flex min-w-0 flex-col gap-1 rounded-box border-[1.5px] border-dashed border-hand/50 bg-hand-soft px-4 pb-5 pt-3 ${stacked ? "" : "min-w-[320px] self-stretch"}`}
      // Stacked, the box reaches under the edges' gutter, so each "if declined" edge ends on it.
      style={stacked ? { width: `calc(100% + ${gutter}px)` } : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-[13px] font-semibold text-hand">
          Win-back branch <span className="font-normal text-ink-2">· for leads who decline on a call</span>
        </h3>
        {!launched && !empty && <AddTrackMenu id={ADD_WIN_BACK_ID} label="Add win-back track" channels={["email", "sms"]} disabled={locked} onAdd={(channel) => channel !== "call" && onAdd(channel)} />}
      </div>
      {empty ? (
        <div className="flex max-w-[460px] flex-col items-start gap-2 pt-1">
          <p className="text-[13.5px] text-ink-2">No tracks yet. A lead who declines on a call can move here, to email and SMS tracks of its own, with no more calls. Add one to offer win back on a phone track.</p>
          {!launched && (
            <div role="group" aria-label="Add a win-back track" className="flex flex-wrap gap-2">
              <button id={ADD_WIN_BACK_ID} type="button" className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium" disabled={locked} aria-label="Add a win-back email track" onClick={() => onAdd("email")}>
                <Icon name="email" className="size-4" />
                Email track
              </button>
              <button type="button" className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium" disabled={locked} aria-label="Add a win-back SMS track" onClick={() => onAdd("sms")}>
                <Icon name="sms" className="size-4" />
                SMS track
              </button>
            </div>
          )}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

interface DeclinedEdge {
  readonly trackId: string;
  readonly d: string;
  readonly arrow: string;
  readonly label: { readonly x: number; readonly y: number };
}

/**
 * The dashed "if declined" edges (ticket 16b), measured from the drawn canvas before paint, as the
 * canvas measures its width. Each leaves its phone track's node on the right and runs down to the
 * branch's box through space no node uses: side by side, the 12px each track's column keeps on its
 * right, which runs clear to the bottom of the tree; stacked, the gutter kept on the canvas's right.
 */
function useDeclinedEdges(content: RefObject<HTMLDivElement | null>, from: readonly TrackDefinition[], layout: "row" | "stacked", gutter: number): readonly DeclinedEdge[] {
  const [edges, setEdges] = useState<readonly DeclinedEdge[]>([]);
  const ids = from.map((t) => t.id).join(" ");
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => {
      const box = el.querySelector<HTMLElement>("[data-testid='win-back-branch']");
      const origin = el.getBoundingClientRect();
      const next: DeclinedEdge[] = [];
      if (box && ids) {
        const top = box.getBoundingClientRect().top - origin.top;
        for (const id of ids.split(" ")) {
          const button = document.getElementById(nodeId(id));
          const column = button?.closest("li");
          if (!button || !column) continue;
          const n = button.getBoundingClientRect();
          const y = n.top - origin.top + n.height / 2;
          const x0 = n.right - origin.left;
          // Stacked, the gutter is the last `gutter` pixels inside the content's 12px right padding.
          const x = layout === "row" ? column.getBoundingClientRect().right - origin.left - 6 : origin.width - 12 - gutter / 2;
          next.push({ trackId: id, d: `M ${x0} ${y} H ${x} V ${top - 6}`, arrow: `M ${x - 4} ${top - 7} L ${x + 4} ${top - 7} L ${x} ${top - 1} Z`, label: { x, y: top - 24 } });
        }
      }
      setEdges((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return edges;
}

/** The measured edges, behind nothing they cross; their meaning is on the phone track's node ("If declined: win back") and the box's name. */
function DeclinedEdges({ edges }: { edges: readonly DeclinedEdge[] }) {
  if (edges.length === 0) return null;
  return (
    <>
      <svg aria-hidden="true" data-testid="declined-edges" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-hand">
        {edges.map((e) => (
          <g key={e.trackId} data-edge-from={e.trackId}>
            <path d={e.d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 4" />
            <path d={e.arrow} fill="currentColor" />
          </g>
        ))}
      </svg>
      {edges.map((e) => (
        <span
          key={e.trackId}
          aria-hidden="true"
          data-testid="declined-label"
          // Left of its line, which runs at the right of the phone track's column: never past the canvas's edge.
          className="pointer-events-none absolute z-[1] -translate-x-full whitespace-nowrap rounded-full bg-base-100 px-2 text-[12px] text-hand shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-hand)_45%,transparent)]"
          style={{ left: e.label.x - 6, top: e.label.y }}
        >
          if declined
        </span>
      ))}
    </>
  );
}

function TrackNode({ track, def, selected, blockers, launched, onSelect }: { track: TrackDefinition; def: CampaignDefinition; selected: boolean; blockers: readonly LaunchBlocker[]; launched: boolean; onSelect: () => void }) {
  const steps = liveSteps(track);
  const issues = launched ? 0 : trackIssues(track, blockers);
  const title = trackTitle(def, track);
  // A phone track's declined path, as the reference's card says it; none chosen is said as the engine reads it (Q14).
  const declined = track.channel === "call" ? (track.declinedPath ? `If declined: ${DECLINED_ON_NODE[track.declinedPath]}` : `If declined: ${DECLINED_ON_NODE[declinedPathOf(track)]}, not chosen yet`) : null;
  return (
    <button
      id={nodeId(track.id)}
      type="button"
      aria-pressed={selected}
      aria-label={`${title}: ${trackSummary(track)}${issues > 0 ? `, ${issues} to fix` : ""}. Starts ${startsText(def, track)}.${declined ? ` ${declined}.` : ""} ${selected ? "Close" : "Open"} it in the inspector.`}
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
      {declined && <span className={`text-[12.5px] font-medium ${track.declinedPath ? "text-hand" : "text-muted"}`}>{declined}</span>}
      <span className="mt-[5px] flex gap-[3px]" aria-hidden="true">
        {steps.map((s) => (
          <i key={s.id} className={`h-1 flex-1 rounded-sm ${s.body.trim() || track.channel === "call" ? "bg-line-strong" : "shadow-[inset_0_0_0_1px_var(--color-crit)]"}`} />
        ))}
      </span>
    </button>
  );
}

/**
 * Add track: a menu button (WAI-ARIA menu button pattern; council on 10121d3, item 4). Enter, Space or
 * Down opens it on the first item and Up on the last; Up, Down, Home and End move between items; Escape
 * closes it and returns focus to the button; Tab, a click outside or focus leaving closes it.
 */
function AddTrackMenu({
  disabled,
  onAdd,
  id = ADD_TRACK_ID,
  label = "Add track",
  channels = ["email", "sms", "call"],
}: {
  disabled: boolean;
  onAdd: (channel: "email" | "sms" | "call") => void;
  id?: string;
  label?: string;
  /** What it offers: the win-back branch's menu offers no phone track (ticket 16b). */
  channels?: readonly ("email" | "sms" | "call")[];
}) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const open = focusIndex !== null;
  const menuId = useId();
  const buttonId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const entries = (
    [
      { key: "email", label: "Email track", icon: "email" },
      { key: "sms", label: "SMS track", icon: "sms" },
      { key: "call", label: "Phone track", icon: "call" },
    ] as const
  ).filter((e) => channels.includes(e.key));
  useEffect(() => {
    if (focusIndex !== null) items.current[focusIndex]?.focus();
  }, [focusIndex]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setFocusIndex(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = (refocus: boolean) => {
    setFocusIndex(null);
    if (refocus) button.current?.focus();
  };
  const choose = (entry: (typeof entries)[number]) => {
    setFocusIndex(null);
    onAdd(entry.key);
  };
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget)) setFocusIndex(null);
      }}
    >
      <button
        ref={button}
        id={id}
        type="button"
        className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setFocusIndex(open ? null : 0)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFocusIndex(0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocusIndex(entries.length - 1);
          }
        }}
      >
        <span id={buttonId} className="flex items-center gap-1.5">
          <Icon name="plus" className="size-4" />
          {label}
        </span>
      </button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className="absolute right-0 top-[calc(100%+6px)] z-10 flex w-[250px] flex-col gap-0.5 rounded-field border border-line-strong bg-base-100 p-1.5"
          onKeyDown={(e) => {
            const last = entries.length - 1;
            const at = focusIndex;
            const move = (to: number) => {
              e.preventDefault();
              setFocusIndex(to);
            };
            if (e.key === "ArrowDown") move(at === last ? 0 : at + 1);
            else if (e.key === "ArrowUp") move(at === 0 ? last : at - 1);
            else if (e.key === "Home") move(0);
            else if (e.key === "End") move(last);
            else if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            } else if (e.key === "Tab") setFocusIndex(null);
          }}
        >
          {entries.map((entry, i) => (
            <li key={entry.key} role="none">
              <button
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={focusIndex === i ? 0 : -1}
                className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[14px] hover:bg-raised"
                onClick={() => choose(entry)}
              >
                <Icon name={entry.icon} className="size-4 text-muted" />
                {entry.label}
              </button>
            </li>
          ))}
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
  const changeTrack = (change: (t: TrackDefinition) => TrackDefinition) =>
    editor.update((d: CampaignDefinition) => ({ ...d, tracks: d.tracks.map((t) => (t.id === track.id ? change(t) : t)) }));
  const changeStep = (stepId: string, change: (s: StepDefinition) => StepDefinition) => changeTrack((t) => ({ ...t, steps: t.steps.map((s) => (s.id === stepId ? change(s) : s)) }));
  return (
    <InspectorFrame titleId={titleId} track={track} editor={editor} onClose={onClose}>
        <EditorNotices editor={editor} onLoadedStored={onLoadedStored} />
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
        <RemoveTrack track={track} editor={editor} onRemoved={onRemoved} />
    </InspectorFrame>
  );
}

/**
 * The inspector's frame for any track: its title and summary chip, the save status and the close
 * button, then a body that scrolls on its own beside the canvas.
 */
function InspectorFrame({ titleId, track, editor, onClose, children }: { titleId: string; track: TrackDefinition; editor: SequenceEditor; onClose: () => void; children: ReactNode }) {
  const name = trackName(editor.draft, track);
  return (
    <aside aria-labelledby={titleId} data-testid="inspector" className={`flex min-w-0 flex-col rounded-box border border-line bg-base-100 min-[1020px]:h-[max(470px,calc(100dvh-306px))]`}>
      <div className="flex items-start justify-between gap-2.5 border-b border-line px-[18px] pb-3.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-[18px]">
            {trackTitle(editor.draft, track)}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12.5px] text-ink-2">
            <Icon name={track.channel} className="size-3.5" />
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
        {children}
      </div>
    </aside>
  );
}

/** What the editor state says above any track's controls: a failed save, a conflict, a draft that cannot be saved, a running campaign, a launch or load in flight. */
function EditorNotices({ editor, onLoadedStored }: { editor: SequenceEditor; onLoadedStored: () => void }) {
  return (
    <>
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
    </>
  );
}

/** Remove, through the arrangement rule: refused in plain words beside the button while another track starts after this one. */
function RemoveTrack({ track, editor, onRemoved }: { track: TrackDefinition; editor: SequenceEditor; onRemoved: () => void }) {
  const [removal, setRemoval] = useState<string | null>(null);
  const removalId = useId();
  const name = trackName(editor.draft, track);
  if (editor.launched) return null;
  return (
    <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3.5">
      <button
        type="button"
        className="btn btn-sm border-line-strong bg-base-100 font-medium"
        disabled={editor.locked}
        aria-describedby={removal ? removalId : undefined}
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
        <p id={removalId} role="alert" className="text-[13px] font-medium text-crit">
          {removal}
        </p>
      )}
    </div>
  );
}

/**
 * A phone track's inspector (ticket 14c): what the definition holds for it and nothing else. Its
 * call is one task on the user's list, with no copy of its own; the campaign's call script, its own
 * skip limit, how it starts and its calling hours. Every control writes through the one editor state
 * and reads its `locked` value (ADR 0003 1.1.1). What later releases add says so in its place.
 */
function PhoneInspector({ track, editor, onEditBranch, onLoadedStored, onClose, onRemoved }: { track: TrackDefinition; editor: SequenceEditor; onEditBranch: () => void; onLoadedStored: () => void; onClose: () => void; onRemoved: () => void }) {
  const titleId = useId();
  const scriptHint = useId();
  const skipHint = useId();
  const locked = editor.locked;
  const [skipText, setSkipText] = useState<string | null>(null);
  const changeTrack = (change: (t: TrackDefinition) => TrackDefinition) =>
    editor.update((d: CampaignDefinition) => ({ ...d, tracks: d.tracks.map((t) => (t.id === track.id ? change(t) : t)) }));
  // The one reading of the limit, the engine's (ADR 0003 3.5): the track's own, else the campaign's.
  const skipLimit = skipLimitOf(editor.draft, track.id);
  return (
    <InspectorFrame titleId={titleId} track={track} editor={editor} onClose={onClose}>
      <EditorNotices editor={editor} onLoadedStored={onLoadedStored} />
      <p className="rounded-field bg-raised px-3 py-2 text-[13.5px] text-ink-2">
        A phone track is one call, placed on your list when it falls due. You dial it and log what happened. For a second planned attempt, add another phone track. The app already handles two more outcomes. A redial, after no answer, a voicemail or a gatekeeper, moves the call to your next day’s list. A callback requested pauses this lead’s other outreach in the campaign until you log the callback’s outcome; a missed callback stays on your list, overdue, until you do. Logging them on the Calls page arrives with the next release.
      </p>
      <div className="flex min-w-0 flex-col gap-[18px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={scriptId(track.id)} className="text-[13px] font-semibold text-muted">
            Call script
          </label>
          <textarea
            id={scriptId(track.id)}
            className="textarea min-h-[120px] w-full [field-sizing:content] border-line-strong text-[14px] leading-[1.55]"
            value={editor.draft.callScript ?? ""}
            // Once running, the script is read, not edited: read-only, so it can still be reached,
            // scrolled and copied. While a launch or a load is pending, authoring is locked (1.1.1).
            readOnly={editor.launched}
            disabled={locked && !editor.launched}
            placeholder="Talking points for your calls"
            aria-describedby={scriptHint}
            onChange={(e) => editor.update((d) => ({ ...d, callScript: e.target.value }))}
          />
          <p id={scriptHint} className="text-[12.5px] text-muted">
            The campaign’s one script: every call task from this campaign shows it, as written, whichever phone track it comes from.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label className="flex flex-wrap items-center gap-2 text-[14px]">
            Skip it if unworked for
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              disabled={locked}
              className="input input-sm w-[62px] border-line-strong text-right"
              value={skipText ?? String(skipLimit)}
              aria-label="Days before an unworked call is skipped"
              aria-describedby={skipHint}
              onChange={(e) => {
                setSkipText(e.target.value);
                const n = e.target.value.trim() === "" ? Number.NaN : Number(e.target.value);
                changeTrack((t) => ({ ...t, callSkipLimitDays: n }));
              }}
              onBlur={() => setSkipText(null)}
            />
            days
          </label>
          <p id={skipHint} className="text-[12.5px] text-muted">
            Counted in calendar days from the day the call first falls due; a redial does not restart it, and time the lead is held by a callback doesn’t count.{" "}
            {track.callSkipLimitDays === undefined ? `This phone track uses the campaign’s limit, ${skipLimit} ${skipLimit === 1 ? "day" : "days"}, until you change it here.` : skipLimit === DEFAULT_SKIP_LIMIT_DAYS ? `${DEFAULT_SKIP_LIMIT_DAYS} days is the default.` : ""}{" "}
            A call you don’t work is carried to your next day’s list, ahead of that day’s new calls. Once the limit has run out, an unworked call is skipped at the end of a day it was on your list, and the tracks after it start after their delay. A call your daily capacity keeps off the list is never skipped.
          </p>
        </div>
      </div>
      <DeclinedPathControl track={track} editor={editor} onEditBranch={onEditBranch} />
      <TimingAndSender track={track} editor={editor} onWindow={(window) => changeTrack((t) => ({ ...t, window }))} />
      <RemoveTrack track={track} editor={editor} onRemoved={onRemoved} />
    </InspectorFrame>
  );
}

/**
 * "If they decline on the call" (ticket 16b; variant A's phone inspector): the reference's radio group of
 * stop, continue and win back, each with its line. Choosing one is the arrangement rule's `declined`
 * operation, saved through the one editor state and save queue like every inspector field. Win back can
 * be chosen only as the definition allows (`winBackAvailable`); until then it says what to do, in the
 * definition's own words. A phone track with no path chosen shows none chosen and says what a declined
 * call does meanwhile, as the engine reads it (`declinedPathOf`; question Q14).
 */
function DeclinedPathControl({ track, editor, onEditBranch }: { track: TrackDefinition; editor: SequenceEditor; onEditBranch: () => void }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const legendId = useId();
  const hintId = useId();
  const refusalId = useId();
  const unavailableId = useId();
  const available = winBackAvailable(editor.draft);
  const branch = liveWinBack(editor.draft);
  const choose = (path: DeclinedPath) => {
    const op: ArrangeOperation = { kind: "declined", trackId: track.id, path };
    const out = arrange(editor.draft, op);
    if (!out.ok) {
      setRefusal(out.reason);
      return;
    }
    setRefusal(null);
    editor.update((d) => {
      const again = arrange(d, op);
      return again.ok ? again.definition : d;
    });
  };
  return (
    <fieldset aria-describedby={[hintId, refusal ? refusalId : ""].filter(Boolean).join(" ")} className="flex min-w-0 flex-col gap-2">
      <legend id={legendId} className="mb-1.5 text-[13px] font-semibold text-muted">
        If they decline on the call
      </legend>
      {!track.declinedPath && <p className="text-[13.5px] text-ink-2">No path is chosen yet, so {lowerFirst(DECLINED_NOW[declinedPathOf(track)])}</p>}
      <div role="radiogroup" aria-labelledby={legendId} className="flex flex-col gap-2">
        {DECLINED_PATHS.map(({ path, label, detail }) => {
          const on = track.declinedPath === path;
          // Win back while the branch has no live track is not offered; one already set stays shown.
          const unavailable = path === "win_back" && !available && !on;
          return (
            <div key={path} className={`flex min-w-0 flex-col gap-1.5 rounded-field px-3 py-2.5 ${on ? "bg-hand-soft shadow-[inset_0_0_0_1.5px_var(--color-hand)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}>
              <label className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[14px] ${unavailable || editor.locked ? "cursor-default" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  className="radio radio-sm mt-0.5"
                  name={`declined-${track.id}`}
                  checked={on}
                  disabled={editor.locked || unavailable}
                  aria-describedby={unavailable ? unavailableId : undefined}
                  onChange={() => choose(path)}
                />
                <b className="font-semibold">{label}</b>
                {/* On the chosen path's tinted fill, secondary text is ink-2: muted falls short of AA on hand-soft. */}
                <span className={`col-start-2 text-[13px] ${on ? "text-ink-2" : "text-muted"}`}>{detail}</span>
              </label>
              {path === "win_back" && unavailable && (
                <p id={unavailableId} className="pl-[30px] text-[13px] text-ink-2">
                  {capitalise(NO_WIN_BACK_BRANCH)}
                </p>
              )}
              {path === "win_back" && branch.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
                  <ul aria-label="The win-back branch’s tracks" className="flex flex-wrap gap-1.5">
                    {branch.map((t) => (
                      <li key={t.id} className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[12.5px] text-hand shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-hand)_45%,transparent)] [overflow-wrap:anywhere]">
                        <Icon name={t.channel} className="size-3.5 flex-none" />
                        {trackTitle(editor.draft, t)} · {liveSteps(t).length}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn btn-ghost btn-sm px-2 font-medium" onClick={onEditBranch}>
                    Edit branch
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {refusal && (
        <p id={refusalId} role="alert" className="text-[13px] font-medium text-crit">
          {refusal}
        </p>
      )}
      <p id={hintId} className="text-[12.5px] text-muted">
        No path calls the lead again. Logging a declined call on the Calls page, and choosing another path there for one lead, arrives with a later release.
      </p>
    </fieldset>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

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
  const call = track.channel === "call";
  const accounts = editor.view.accounts.filter((a) => a.channel === (sms ? "sms" : "email"));
  // A phone track's window is its calling hours, in the prospect's local time (ADR 0003 1.1).
  const windowName = call ? "Calling hours" : "Sending window";
  const hoursWord = call ? "Calling" : "Sending";
  return (
    <section aria-label={call ? "Timing" : "Timing and sender"} className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-muted">{call ? "Timing" : "Timing and sender"}</h3>
      <dl className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-[9px] text-[14px] max-[480px]:grid-cols-1">
        <dt className="text-[13px] text-muted">Starts</dt>
        <dd className="min-w-0">
          <StartsControl track={track} editor={editor} />
        </dd>
        <dt className="text-[13px] text-muted">{call ? "Calls" : "Sends from"}</dt>
        <dd className="min-w-0">
          {call ? (
            <>
              Your list on Today and Calls, when each call falls due
              <div className="text-[12.5px] text-muted">You dial every call yourself; nothing dials automatically. A phone track needs no sender.</div>
            </>
          ) : accounts.length === 0 ? (
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
        <dt className="text-[13px] text-muted">{windowName}</dt>
        <dd>
          <fieldset disabled={locked} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <legend className="sr-only">{windowName}</legend>
            <span role="group" aria-label={`${hoursWord} days`} className="inline-flex flex-wrap gap-[3px]">
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
              <select className="select select-sm w-[88px] border-line-strong" aria-label={`${hoursWord} starts at`} value={hours.start} onChange={(e) => onWindow(setWindow(days, { ...hours, start: Number(e.target.value) }))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              to
              <select className="select select-sm w-[88px] border-line-strong" aria-label={`${hoursWord} ends at`} value={hours.end} onChange={(e) => onWindow(setWindow(days, { ...hours, end: Number(e.target.value) }))}>
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
  // A track starts after another of its own branch only (ADR 0003 7.1): the other branch is never offered.
  const others = liveIn(editor.draft, track.branch).filter((t) => t.id !== track.id);
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
          <option value="entry">{track.branch === "win_back" ? "When the lead enters win-back" : "At launch"}</option>
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
      {after && !refusal && (
        <p className="text-[12.5px] text-muted">
          {editor.draft.tracks.find((t) => t.id === after.trackId)?.channel === "call"
            ? "It waits for the call’s outcome: the delay counts from when you log the call, or from when the phone track was skipped for the lead."
            : "Counted from when that track has sent its last step, or was skipped for the lead."}
        </p>
      )}
    </div>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why no SMS number is connected, from GET /api/sms-provider, in the one wording the launch blocker uses too. */
function SmsProviderReason() {
  const { result } = useApi<SmsProviderStatus>("/api/sms-provider");
  const why = whyNoSmsNumber(result.state === "ready" ? result.data : null);
  return why ? <div className="text-[12.5px] text-ink-2">{why}</div> : null;
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
  return <span className="max-w-full rounded-full border border-line-strong bg-base-100 px-2 text-[12px] text-ink-2">{children}</span>;
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

