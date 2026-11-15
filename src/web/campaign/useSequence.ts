import { useEffect, useState, useSyncExternalStore } from "react";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { ApiRequestError, getJson, postJson, putJson, useApi } from "../api.ts";
import { WEEK } from "./model.ts";
import { setLeaveGuard } from "../leaveGuard.ts";
import { EditorStore, type ApplyOutcome, type EditorSnapshot } from "./editorStore.ts";
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
  /** Editing is locked (a launch, a load or an apply pending): every authoring control reads this, and edits are refused. */
  readonly locked: boolean;
  /** A running campaign's changes are being applied (ticket 19). */
  readonly applying: boolean;
  /** Applies a running campaign's changes, through the same ordered save path. */
  readonly apply: (confirmed: { readonly body: string; readonly digest: string }) => Promise<ApplyOutcome>;
  /** What Apply would send, by the one function every save uses: the body a running edit's read is asked for. */
  readonly previewBody: () => CampaignDefinition;
  /** Sets aside a running campaign's changes that were not applied. */
  readonly discard: () => Promise<void>;
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
    // A running campaign's changes go only when applied (ticket 19, Q24): leaving with some asks first.
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const now = store.getSnapshot();
      if (now.view.launchedAt !== null && now.unsaved) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    // And inside the app (review bot and verifier on 7afa03d): the same campaign's tabs keep the editor; anything else asks.
    const base = `/campaigns/${encodeURIComponent(campaignId)}`;
    const tabs = ["", "/before-launch", "/test-run", "/leads", "/imports"].map((t) => `${base}${t}`);
    const guard = () => {
      const now = store.getSnapshot();
      setLeaveGuard(
        now.view.launchedAt !== null && now.unsaved
          ? { allows: (path) => tabs.includes(path), text: "Leave without applying your changes? They are on this page only and have not reached any lead; leaving discards them." }
          : null,
      );
    };
    guard();
    const unsubscribe = store.subscribe(guard);
    window.addEventListener("pagehide", leavePage);
    window.addEventListener("pageshow", back);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("pagehide", leavePage);
      window.removeEventListener("pageshow", back);
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", beforeUnload);
      unsubscribe();
      setLeaveGuard(null);
      store.dispose();
    };
  }, [store, campaignId]);

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
          applying: snapshot.pending === "apply",
          apply: (confirmed) => store.apply(confirmed),
          previewBody: () => store.previewBody(),
          discard: () => store.discard(),
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
