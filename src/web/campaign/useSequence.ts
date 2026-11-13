import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { postJson, putJson, useApi } from "../api.ts";
import { WEEK } from "./model.ts";
import { SaveQueue, draftProblems, type SaveStatus } from "./saveQueue.ts";

export { draftProblems } from "./saveQueue.ts";
export type SaveState = SaveStatus;

export interface SequenceEditor {
  /** The last definition the server accepted, with its blockers and inboxes. */
  readonly view: SequenceView;
  /** What the user sees and edits; saved a moment after each change. */
  readonly draft: CampaignDefinition;
  readonly save: SaveState;
  /** Why the draft can't be saved as it stands, said next to the control. */
  readonly problems: readonly string[];
  /** The draft differs from what the server accepted: launch waits until it is saved. */
  readonly unsaved: boolean;
  readonly launched: boolean;
  readonly update: (change: (draft: CampaignDefinition) => CampaignDefinition) => void;
  readonly retrySave: () => void;
  /** Saves the draft through the same ordered path first, and launches only if that succeeded. */
  readonly launch: () => Promise<void>;
}

const SAVE_DELAY_MS = 600;

/**
 * The campaign's sequence, as the editor edits it. Before launch every change is saved on its
 * own, a moment after it is made, through one ordered queue (saveQueue.ts); the inboxes the
 * provider reports are the email track's pool.
 */
export function useSequence(campaignId: string) {
  const { result, retry } = useApi<SequenceView>(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`);
  // What the editor changed or saved since loading; until then, what the server sent.
  const [local, setLocal] = useState<{ view: SequenceView; draft: CampaignDefinition } | null>(null);
  const loaded = result.state === "ready" ? result.data : null;
  const state = local ?? (loaded ? { view: loaded, draft: loaded.definition } : null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [unsaved, setUnsaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<{ view: SequenceView; draft: CampaignDefinition } | null>(null);
  useEffect(() => {
    latest.current = state;
  });

  // Created on first use, outside render: one ordered queue for this campaign's editor.
  const queueRef = useRef<SaveQueue | null>(null);
  const getQueue = useCallback((): SaveQueue => {
    queueRef.current ??= new SaveQueue({
        read: () => {
          const current = latest.current;
          if (!current) throw new Error("The sequence has not loaded.");
          return { draft: current.draft, accountIds: current.view.accounts.map((a) => a.id) };
        },
        put: async (definition, options) => (await putJson(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`, definition, options)) as SequenceView,
        onStatus: (status) => {
          setSave(status);
          setUnsaved(status.kind !== "saved" && status.kind !== "idle");
        },
        // Saves land in order, so each accepted view is the newest; a newer draft is kept.
        onAccepted: (view, current) => {
          const next = { view, draft: current ? view.definition : (latest.current?.draft ?? view.definition) };
          latest.current = next;
          setLocal(next);
        },
      });
    return queueRef.current;
  }, [campaignId]);

  const saveNow = useCallback(
    (options: { keepalive?: boolean } = {}) => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (latest.current?.view.launchedAt != null) return Promise.resolve({ ok: true } as const);
      return getQueue().save(options);
    },
    [getQueue],
  );

  // Leaving the page, or this campaign, saves a change still waiting for its moment.
  useEffect(() => {
    const flush = () => {
      if (timer.current !== undefined) void saveNow({ keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [saveNow]);

  const update = useCallback(
    (change: (draft: CampaignDefinition) => CampaignDefinition) => {
      const base = latest.current;
      if (!base) return;
      const next = { ...base, draft: change(base.draft) };
      latest.current = next;
      setLocal(next);
      getQueue().edited();
      // Shown at once, so a change is never labelled saved while it waits to be sent.
      setSave({ kind: "saving" });
      setUnsaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void getQueue().save();
      }, SAVE_DELAY_MS);
    },
    [getQueue],
  );

  // The pool follows the provider's inboxes: when they differ from what is saved, save once.
  const view = state?.view;
  useEffect(() => {
    if (!view || view.launchedAt !== null || !view.definition.tracks.some((t) => !t.removed && t.channel === "email")) return;
    const pool = [...view.definition.emailPool].sort().join("\n");
    const connected = view.accounts.map((a) => a.id).sort().join("\n");
    if (pool === connected) return;
    getQueue().edited();
    void saveNow();
  }, [view, getQueue, saveNow]);

  const launch = useCallback(async () => {
    const saved = await saveNow();
    if (!saved.ok) {
      throw new Error(
        saved.reason === "changed" ? "A newer change is still being saved. Launch again once it is saved." : `Your latest change isn’t saved, so nothing was launched. ${saved.message}`,
      );
    }
    const launched = (await postJson(`/api/campaigns/${encodeURIComponent(campaignId)}/launch`, {})) as SequenceView;
    setLocal({ view: launched, draft: launched.definition });
  }, [campaignId, saveNow]);

  const editor: SequenceEditor | null = state
    ? {
        view: state.view,
        draft: state.draft,
        save,
        problems: draftProblems(state.draft),
        unsaved,
        launched: state.view.launchedAt !== null,
        update,
        retrySave: () => void saveNow(),
        launch,
      }
    : null;
  return { result, retry, editor };
}

export const dayName = (day: number): string => WEEK.find((d) => d.day === day)?.name ?? "";
