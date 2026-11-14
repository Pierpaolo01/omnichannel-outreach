/**
 * Editing a running campaign (ticket 19; ADR 0003 "Ticket 19", "What the editor shows"). Provisional, the most restrained
 * form (no prototype draws it; question Q20 is the principal's): changes stay on the page until Apply, and above the
 * canvas the server's read says what each change would do to the leads already running, as of that read. Nothing here
 * decides what a change does: every count is the server's, from the engine's own reconciliation of each lead.
 */
import { useEffect, useRef, useState } from "react";
import type { CampaignDefinition, EditImpactChange, EditImpactView, TrackDefinition } from "../../shared/api.ts";
import { ApiRequestError, postJson } from "../api.ts";
import { STEP_NOUN, liveSteps, trackTitle } from "./model.ts";
import type { SequenceEditor } from "./useSequence.ts";

/** How often the read is taken again while changes wait to be applied: leads move on as the engine runs. */
const REFRESH_MS = 20_000;
const DEBOUNCE_MS = 400;

type ImpactRead = { readonly state: "idle" } | { readonly state: "loading" } | { readonly state: "ready"; readonly view: EditImpactView } | { readonly state: "error"; readonly message: string };

/** The server's read of what applying `draft` would do, kept fresh while the page holds changes. */
function useEditImpact(campaignId: string, draft: CampaignDefinition, enabled: boolean): { read: ImpactRead; retry: () => void } {
  const [read, setRead] = useState<ImpactRead>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const n = ++asked.current;
    const run = () => {
      setRead((r) => (r.state === "ready" ? r : { state: "loading" }));
      postJson(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence/impact`, { definition: draft }).then(
        (view) => {
          if (n === asked.current) setRead({ state: "ready", view: view as EditImpactView });
        },
        (error: unknown) => {
          if (n === asked.current) setRead({ state: "error", message: error instanceof ApiRequestError ? error.message : "The server didn’t answer." });
        },
      );
    };
    const first = setTimeout(run, DEBOUNCE_MS);
    const again = setInterval(run, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [campaignId, draft, enabled, tick]);
  return { read: enabled ? read : { state: "idle" }, retry: () => setTick((t) => t + 1) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where a change is, named as the editor names it: the track, and the message by its place among the track's messages. */
function changeName(change: EditImpactChange, draft: CampaignDefinition, stored: CampaignDefinition): string {
  const inDraft = draft.tracks.find((t) => t.id === change.trackId);
  const inStored = stored.tracks.find((t) => t.id === change.trackId);
  // A removed track or message is named as it was before this change.
  const removed = change.kind === "track_removed" || change.kind === "step_removed";
  const track: TrackDefinition | undefined = removed ? inStored : (inDraft ?? inStored);
  const def = removed || !inDraft ? stored : draft;
  const trackName = track ? trackTitle(def, track) : "A track";
  if (change.stepId === null || !track) return trackName;
  const index = liveSteps(track).findIndex((s) => s.id === change.stepId);
  const noun = STEP_NOUN[track.channel];
  return `${trackName} · ${noun} ${index + 1}`;
}

/** What changed, in a few words. */
function whatChanged(change: EditImpactChange, draft: CampaignDefinition): string {
  const step = draft.tracks.flatMap((t) => t.steps).find((s) => s.id === change.stepId);
  switch (change.kind) {
    case "step_copy":
      return "copy changed";
    case "step_wait":
      return step ? `wait changed to ${plural(step.waitDays, "day", "days")}` : "wait changed";
    case "step_added":
      return "added";
    case "step_removed":
      return "removed";
    case "track_added":
      return "added";
    case "track_removed":
      return "removed";
    case "track_start":
      return "starts differently";
    case "track_window":
      return draft.tracks.find((t) => t.id === change.trackId)?.channel === "call" ? "calling hours changed" : "sending window changed";
    case "declined_path":
      return "declined path changed";
    case "skip_limit":
      return "skip limit changed";
    case "call_script":
      return "call script changed";
    case "timezone":
      return "campaign time zone changed";
    default: {
      const unreachable: never = change.kind;
      return String(unreachable);
    }
  }
}

/** What the change does to the leads, from the server's counts; each count is said only when it is not zero. */
function whatItDoes(change: EditImpactChange): string {
  const parts: string[] = [];
  const removal = change.kind === "step_removed" || change.kind === "track_removed";
  if (change.reaches > 0) parts.push(`${plural(change.reaches, "lead", "leads")} will get it`);
  if (change.skips > 0) parts.push(`${plural(change.skips, "lead", "leads")} not there yet will skip it`);
  if (change.inFlight > 0) parts.push(`${plural(change.inFlight, "lead has", "leads have")} it with the provider now, so it goes as it was`);
  if (change.untouched > 0) parts.push(`${plural(change.untouched, "lead is", "leads are")} past it or finished${removal && change.kind === "track_removed" ? ", and keep what they started" : ""}`);
  if (parts.length === 0) return "No lead is affected.";
  const sentence = parts.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** The read's instant in the campaign's own zone, named, never the browser's (as every screen states a time). */
const timeOf = (iso: string, zone: string) => `${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone })} (${zone.replace(/_/g, " ")})`;

export function RunningChanges({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const enabled = editor.unsaved && !editor.applying && editor.problems.length === 0;
  const { read, retry } = useEditImpact(campaignId, editor.draft, enabled);
  const [error, setError] = useState<string | null>(null);
  const save = editor.save;
  const view = read.state === "ready" ? read.view : null;
  const refused = [...(view?.problems ?? []), ...(view?.blockers.map((b) => b.message) ?? [])];
  const canApply = editor.unsaved && !editor.locked && editor.problems.length === 0 && view !== null && refused.length === 0;

  return (
    <section aria-labelledby="running-changes-title" data-testid="running-changes" className="flex flex-col gap-2.5 rounded-box border border-line bg-base-100 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-[1_1_360px]">
          <h2 id="running-changes-title" className="text-[15.5px] font-semibold">
            {editor.unsaved ? "Changes not applied yet" : "This campaign is running"}
          </h2>
          <p className="text-[13.5px] text-ink-2">
            {editor.unsaved
              ? "Nothing changes for leads until you apply. Messages already sent are never sent again, and finished tracks never restart."
              : "Edit it here. Your changes stay on this page until you apply them; then they reach only messages not yet sent."}
          </p>
        </div>
        {editor.unsaved && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn border-line-strong bg-base-100 font-medium" disabled={editor.locked} onClick={() => editor.discard()}>
              Discard changes
            </button>
            <button
              type="button"
              className="btn btn-primary font-semibold"
              disabled={!canApply && !editor.applying}
              aria-disabled={editor.applying}
              onClick={() => {
                if (editor.applying) return;
                setError(null);
                editor.apply().catch((e: unknown) => setError(e instanceof Error ? e.message : "Not applied."));
              }}
            >
              {editor.applying ? "Applying…" : "Apply to running leads"}
            </button>
          </div>
        )}
      </div>
      {editor.unsaved && editor.problems.length === 0 && (
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {read.state === "loading" && <p className="text-[13.5px] text-muted">Checking what this does to the leads…</p>}
          {read.state === "error" && (
            <p className="flex flex-wrap items-center gap-2 rounded-field bg-crit-soft px-3 py-2 text-[13.5px] text-crit">
              What this does to the leads didn’t load: {read.message}
              <button type="button" className="btn btn-xs border-line-strong bg-base-100 font-medium text-base-content" onClick={retry}>
                Try again
              </button>
            </p>
          )}
          {view && (
            <>
              <p className="text-[12.5px] text-muted">
                Of the {plural(view.leads, "lead", "leads")} in this campaign, as of {timeOf(view.asOf, editor.view.definition.timezone)}:
              </p>
              <ul className="flex flex-col divide-y divide-line rounded-field border border-line">
                {view.changes.map((change) => (
                  <li key={`${change.kind}-${change.trackId ?? ""}-${change.stepId ?? ""}`} className="flex flex-col gap-0.5 px-3 py-2 text-[13.5px]">
                    <span>
                      <span className="font-semibold">{changeName(change, editor.draft, editor.view.definition)}</span>
                      <span className="text-ink-2"> · {whatChanged(change, editor.draft)}</span>
                    </span>
                    <span className="text-ink-2">{whatItDoes(change)}</span>
                  </li>
                ))}
              </ul>
              {refused.length > 0 && (
                <p role="alert" className="rounded-field bg-crit-soft px-3 py-2 text-[13.5px] text-crit">
                  This can’t be applied yet: {refused.join(" ")}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {(save.kind === "error" || error) && (
        <p role="alert" className="rounded-field bg-crit-soft px-3 py-2 text-[13.5px] text-crit">
          Not applied. {save.kind === "error" ? save.message : error}
        </p>
      )}
    </section>
  );
}
