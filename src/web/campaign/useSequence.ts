import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { postJson, putJson, useApi } from "../api.ts";
import { WEEK } from "./model.ts";

export type SaveState = { readonly kind: "idle" | "saving" | "saved" } | { readonly kind: "error"; readonly message: string };

export interface SequenceEditor {
  /** The last definition the server accepted, with its blockers and inboxes. */
  readonly view: SequenceView;
  /** What the user sees and edits; saved a moment after each change. */
  readonly draft: CampaignDefinition;
  readonly save: SaveState;
  /** Why the draft can't be saved as it stands, said next to the control. */
  readonly problems: readonly string[];
  readonly launched: boolean;
  readonly update: (change: (draft: CampaignDefinition) => CampaignDefinition) => void;
  readonly retrySave: () => void;
  readonly launch: () => Promise<void>;
}

const SAVE_DELAY_MS = 600;

/** Problems the server would refuse with, caught before sending so the user sees them in place. */
export function draftProblems(def: CampaignDefinition): string[] {
  const problems: string[] = [];
  for (const track of def.tracks.filter((t) => !t.removed)) {
    if (track.window.length === 0) problems.push("Choose at least one sending day.");
    if (track.window.some((w) => w.start === w.end)) problems.push("The sending window starts and ends at the same hour.");
    track.steps
      .filter((s) => !s.removed)
      .forEach((s, i) => {
        if (i > 0 && !(Number.isInteger(s.waitDays) && s.waitDays >= 0)) problems.push(`Email ${i + 1}'s wait is a whole number of days, 0 or more.`);
      });
  }
  return problems;
}

/**
 * The campaign's sequence, as the editor edits it. Before launch every change is saved on its
 * own, a moment after it is made; the inboxes the provider reports are the email track's pool.
 */
export function useSequence(campaignId: string) {
  const { result, retry } = useApi<SequenceView>(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`);
  // What the editor changed or saved since loading; until then, what the server sent.
  const [local, setLocal] = useState<{ view: SequenceView; draft: CampaignDefinition } | null>(null);
  const loaded = result.state === "ready" ? result.data : null;
  const state = local ?? (loaded ? { view: loaded, draft: loaded.definition } : null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<void> | null>(null);
  const latest = useRef<{ view: SequenceView; draft: CampaignDefinition } | null>(null);
  useEffect(() => {
    latest.current = state;
  });

  const send = useCallback(async (options: { keepalive?: boolean } = {}) => {
    const current = latest.current;
    if (!current || current.view.launchedAt !== null || draftProblems(current.draft).length > 0) return;
    const sent = revision.current;
    const definition = { ...current.draft, emailPool: current.view.accounts.map((a) => a.id) };
    setSave({ kind: "saving" });
    const run = (async () => {
      try {
        const view = (await putJson(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`, definition, options)) as SequenceView;
        // A change made while this save ran keeps its draft; the next save sends it.
        setLocal((s) => ({ view, draft: revision.current === sent ? view.definition : (s ?? current).draft }));
        setSave(revision.current === sent ? { kind: "saved" } : { kind: "saving" });
      } catch (error) {
        setSave({ kind: "error", message: error instanceof Error ? error.message : "The change wasn’t saved." });
      }
    })();
    pending.current = run;
    await run;
    if (pending.current === run) pending.current = null;
  }, [campaignId]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void send();
    }, SAVE_DELAY_MS);
  }, [send]);

  // Leaving the page, or this campaign, saves a change still waiting for its moment.
  useEffect(() => {
    const flush = () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      void send({ keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [send]);

  // The pool follows the provider's inboxes: when they differ from what is saved, save once.
  const view = state?.view;
  useEffect(() => {
    if (!view || view.launchedAt !== null || !view.definition.tracks.some((t) => !t.removed && t.channel === "email")) return;
    const pool = [...view.definition.emailPool].sort().join("\n");
    const connected = view.accounts.map((a) => a.id).sort().join("\n");
    if (pool !== connected) void send();
  }, [view, send]);

  const update = useCallback(
    (change: (draft: CampaignDefinition) => CampaignDefinition) => {
      const base = latest.current;
      if (!base) return;
      revision.current++;
      // Shown at once, so a change is never labelled saved while it waits to be sent.
      setSave({ kind: "saving" });
      setLocal((s) => {
        const from = s ?? base;
        const next = { ...from, draft: change(from.draft) };
        latest.current = next;
        return next;
      });
      schedule();
    },
    [schedule],
  );

  const launch = useCallback(async () => {
    clearTimeout(timer.current);
    await send();
    await pending.current;
    const launched = (await postJson(`/api/campaigns/${encodeURIComponent(campaignId)}/launch`, {})) as SequenceView;
    setLocal({ view: launched, draft: launched.definition });
  }, [campaignId, send]);

  const editor: SequenceEditor | null = state
    ? {
        view: state.view,
        draft: state.draft,
        save,
        problems: draftProblems(state.draft),
        launched: state.view.launchedAt !== null,
        update,
        retrySave: () => void send(),
        launch,
      }
    : null;
  return { result, retry, editor };
}

export const dayName = (day: number): string => WEEK.find((d) => d.day === day)?.name ?? "";
