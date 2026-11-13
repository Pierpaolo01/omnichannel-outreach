import { useEffect, useState, useSyncExternalStore } from "react";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { ApiRequestError, getJson, postJson, putJson, useApi } from "../api.ts";
import { WEEK } from "./model.ts";
import { EditorStore, type EditorSnapshot } from "./editorStore.ts";
import { NoAnswer, type SaveStatus } from "./saveQueue.ts";

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
  /** A launch is in flight: authoring is locked until it answers. */
  readonly launching: boolean;
  /** The stored version is loading after a conflict: authoring is locked until it arrives. */
  readonly loading: boolean;
  /** Editing is locked (launched, or a launch or load pending): every authoring control reads this, and edits are refused. */
  readonly locked: boolean;
  readonly update: (change: (draft: CampaignDefinition) => CampaignDefinition) => void;
  readonly retrySave: () => void;
  /** After a conflict: replaces the draft with the stored version, setting aside what was typed. Resolves true once it has. */
  readonly loadStored: () => Promise<boolean>;
  /** Saves the draft through the same ordered path first, and launches only if that succeeded and only the revision on the page. */
  readonly launch: () => Promise<void>;
}

/** How long a save waits for its answer before it counts as no answer and is resent. */
const ANSWER_TIMEOUT_MS = 20_000;

/** One PUT of the sequence: no answer (network failure, timeout) is `NoAnswer`; a refusal carries the server's code. */
async function putSequence(campaignId: string, body: unknown, options: { keepalive?: boolean; signal?: AbortSignal }): Promise<SequenceView> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), ANSWER_TIMEOUT_MS);
  // A leave-save superseded by a newer one is cancelled (one outstanding at most).
  options.signal?.addEventListener("abort", () => abort.abort());
  try {
    return (await putJson(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`, body, { ...(options.keepalive ? { keepalive: true } : {}), signal: abort.signal })) as SequenceView;
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw new NoAnswer();
    const code = (error.body as { error?: { code?: unknown } } | null)?.error?.code;
    throw Object.assign(new Error(error.message), { code: typeof code === "string" ? code : null });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The campaign's sequence, as the editor edits it: a binding of EditorStore (editorStore.ts), which
 * holds every state transition, to React and the browser (timers, leaving the page, coming back,
 * going online). The generated save test drives the same EditorStore.
 */
export function useSequence(campaignId: string) {
  const { result, retry } = useApi<SequenceView>(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`);
  const loaded = result.state === "ready" ? result.data : null;
  const [store, setStore] = useState<EditorStore | null>(null);
  // One store per load of this campaign's page, created once the sequence has arrived.
  if (loaded && store === null) {
    setStore(
      new EditorStore(loaded, {
        put: (body, options) => putSequence(campaignId, body, options),
        launch: async (definitionVersion) => {
          try {
            return (await postJson(`/api/campaigns/${encodeURIComponent(campaignId)}/launch`, { definitionVersion })) as SequenceView;
          } catch (error) {
            const code = error instanceof ApiRequestError ? (error.body as { error?: { code?: unknown } } | null)?.error?.code : null;
            throw Object.assign(error instanceof Error ? error : new Error("Launch failed."), { code });
          }
        },
        load: async () => (await getJson(`/api/campaigns/${encodeURIComponent(campaignId)}/sequence`)) as SequenceView,
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }),
    );
  }
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot);

  useEffect(() => {
    if (!store) return;
    const leavePage = () => store.leavePage();
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) void store.restored();
    };
    const online = () => store.online();
    window.addEventListener("pagehide", leavePage);
    window.addEventListener("pageshow", back);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("pagehide", leavePage);
      window.removeEventListener("pageshow", back);
      window.removeEventListener("online", online);
      store.dispose();
    };
  }, [store]);

  const editor: SequenceEditor | null =
    store && snapshot
      ? {
          view: snapshot.view,
          draft: snapshot.draft,
          save: snapshot.save,
          problems: snapshot.problems,
          unsaved: snapshot.unsaved,
          launched: snapshot.view.launchedAt !== null,
          launching: snapshot.pending === "launch",
          loading: snapshot.pending === "load",
          locked: snapshot.locked,
          update: (change) => store.update(change),
          retrySave: () => store.retrySave(),
          loadStored: async () => {
            await store.loadStored();
            return !store.inConflict;
          },
          launch: () => store.launch(),
        }
      : null;
  return { result, retry, editor };
}

const noSubscribe = () => () => undefined;
const noSnapshot = (): EditorSnapshot | null => null;

export const dayName = (day: number): string => WEEK.find((d) => d.day === day)?.name ?? "";
