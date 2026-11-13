import { describe, expect, test } from "vitest";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { SaveQueue, type SaveStatus } from "./saveQueue.ts";

/**
 * The editor's one ordered path to the server (review: useSequence.ts:76 and :133). Every save,
 * whether from the debounce, leaving the page, the pool sync or launch, goes through it.
 */
const def = (subject: string, fields: Partial<CampaignDefinition> = {}): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [{ day: 1, start: 9, end: 17 }],
      steps: [{ id: "s1", waitDays: 0, subject, body: "Hello.", threading: "new_subject", removed: false }],
      start: { kind: "entry" },
      removed: false,
    },
  ],
  ...fields,
});

const viewOf = (definition: CampaignDefinition, version: number) => ({ definition, definitionVersion: version }) as unknown as SequenceView;

function harness() {
  let draft = def("First");
  let stored: CampaignDefinition | null = null;
  let version = 0;
  const calls: { definition: CampaignDefinition; keepalive: boolean; resolve: () => void; reject: (e: Error) => void }[] = [];
  const statuses: SaveStatus[] = [];
  const accepted: { view: SequenceView; current: boolean }[] = [];
  const queue = new SaveQueue({
    read: () => ({ draft, accountIds: ["inbox-a"] }),
    put: (definition, options) =>
      new Promise<SequenceView>((resolve, reject) => {
        calls.push({
          definition,
          keepalive: options.keepalive === true,
          resolve: () => {
            stored = definition;
            resolve(viewOf(definition, ++version));
          },
          reject,
        });
      }),
    onStatus: (s) => statuses.push(s),
    onAccepted: (view, current) => accepted.push({ view, current }),
  });
  const edit = (subject: string) => {
    draft = def(subject);
    queue.edited();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { queue, edit, calls, statuses, accepted, get stored() { return stored; }, settle, setDraft: (d: CampaignDefinition) => { draft = d; queue.edited(); } };
}

describe("autosaves are sent one at a time, each with the newest draft", () => {
  test("an edit made while an older save is in flight is sent after it, so the newer copy is what stays stored", async () => {
    const h = harness();
    h.edit("Older subject");
    const first = h.queue.save();
    await h.settle();
    expect(h.calls).toHaveLength(1);
    h.edit("Newer subject");
    h.edit("Newest subject");
    const second = h.queue.save();
    await h.settle();
    // Nothing overlaps: the second save waits for the first.
    expect(h.calls).toHaveLength(1);
    h.calls[0]!.resolve();
    expect(await first).toEqual({ ok: false, reason: "changed" });
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.definition.tracks[0]!.steps[0]!.subject).toBe("Newest subject");
    h.calls[1]!.resolve();
    expect(await second).toEqual({ ok: true });
    expect(h.stored?.tracks[0]?.steps[0]?.subject).toBe("Newest subject");
    expect(h.statuses.at(-1)).toEqual({ kind: "saved" });
    expect(h.accepted.map((a) => a.current)).toEqual([false, true]);
  });

  test("saves asked for while one is in flight coalesce into one more request", async () => {
    const h = harness();
    h.edit("A");
    void h.queue.save();
    await h.settle();
    h.edit("B");
    const b = h.queue.save();
    h.edit("C");
    const c = h.queue.save();
    h.calls[0]!.resolve();
    await h.settle();
    h.calls[1]!.resolve();
    expect(await b).toEqual({ ok: true });
    expect(await c).toEqual({ ok: true });
    expect(h.calls.map((x) => x.definition.tracks[0]!.steps[0]!.subject)).toEqual(["A", "C"]);
  });

  test("nothing is sent when the server already has the newest revision", async () => {
    const h = harness();
    expect(await h.queue.save()).toEqual({ ok: true });
    expect(h.calls).toHaveLength(0);
  });

  test("the inboxes the provider reports are the pool, and leaving the page asks for a keepalive request", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save({ keepalive: true });
    await h.settle();
    expect(h.calls[0]).toMatchObject({ keepalive: true, definition: { emailPool: ["inbox-a"] } });
    h.calls[0]!.resolve();
    expect(await saved).toEqual({ ok: true });
  });
});

describe("a save that cannot complete says so, and anything waiting on it (launch) does not go ahead", () => {
  test("a refused or failed request is a failure with the server's message, and the draft is kept for a retry", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save();
    await h.settle();
    h.calls[0]!.reject(new Error("Step 1 is the first step, so it has no wait."));
    expect(await saved).toEqual({ ok: false, reason: "failed", message: "Step 1 is the first step, so it has no wait." });
    expect(h.statuses.at(-1)).toEqual({ kind: "error", message: "Step 1 is the first step, so it has no wait." });
    // Retrying sends the same draft again.
    const retried = h.queue.save();
    await h.settle();
    expect(h.calls[1]!.definition.tracks[0]!.steps[0]!.subject).toBe("A");
    h.calls[1]!.resolve();
    expect(await retried).toEqual({ ok: true });
  });

  test("a draft the server would refuse is not sent, and is a failure", async () => {
    const h = harness();
    h.setDraft(def("A", { tracks: [{ ...def("A").tracks[0]!, window: [] }] }));
    expect(await h.queue.save()).toEqual({ ok: false, reason: "invalid", message: "Choose at least one sending day." });
    expect(h.calls).toHaveLength(0);
  });
});
