import { describe, expect, test } from "vitest";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { NoAnswer, SaveQueue, type SaveStatus } from "./saveQueue.ts";

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
  const calls: { definition: CampaignDefinition; keepalive: boolean; aborted: () => boolean; stamp: number; base: number; session: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const waits: number[] = [];
  let accountIds = ["inbox-a"];
  const statuses: SaveStatus[] = [];
  const accepted: { view: SequenceView; current: boolean }[] = [];
  const queue = new SaveQueue({
    read: () => ({ draft, accountIds, version }),
    session: "page-1",
    // The backoff is counted, not waited: the test is bounded by tries, never by time.
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    put: (definition, options, save) =>
      new Promise<SequenceView>((resolve, reject) => {
        calls.push({
          definition,
          keepalive: options.keepalive === true,
          aborted: () => options.signal?.aborted === true,
          // The save's number in the session, read as `stamp` by the tests below.
          stamp: save.seq,
          base: save.base,
          session: save.session,
          resolve: () => {
            stored = definition;
            resolve(viewOf(definition, ++version));
          },
          reject,
        });
      }),
    onStatus: (s) => statuses.push(s),
    onAccepted: (view, seq) => accepted.push({ view, current: seq === queue.edit }),
  });
  const edit = (subject: string) => {
    draft = def(subject);
    queue.edited();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { queue, edit, calls, statuses, accepted, waits, get stored() { return stored; }, settle, setDraft: (d: CampaignDefinition) => { draft = d; queue.edited(); }, setInboxes: (ids: string[]) => { accountIds = ids; } };
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

describe("leaving the page with a save in flight (PR 41 re-check, B6)", () => {
  test("every edit takes the next number in the session, and each save carries its draft's number", async () => {
    const h = harness();
    h.edit("A");
    void h.queue.save();
    await h.settle();
    h.edit("B");
    h.calls[0]!.resolve();
    await h.settle();
    void h.queue.save();
    await h.settle();
    expect(h.calls[1]!.stamp).toBeGreaterThan(h.calls[0]!.stamp);
  });

  test("the newest draft goes at once with keepalive, without waiting for the older save in flight, carrying the newer number", async () => {
    const h = harness();
    h.edit("Older delayed save");
    void h.queue.save();
    await h.settle();
    h.edit("Newest edit must survive navigation");
    void h.queue.save(); // queued behind the first; dies with the page
    await h.settle();
    expect(h.calls).toHaveLength(1);
    h.queue.sendNow();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ keepalive: true });
    expect(h.calls[1]!.definition.tracks[0]!.steps[0]!.subject).toBe("Newest edit must survive navigation");
    expect(h.calls[1]!.stamp).toBeGreaterThan(h.calls[0]!.stamp);
  });

  test("nothing is sent when the server already has the newest revision", () => {
    const h = harness();
    h.queue.sendNow();
    expect(h.calls).toHaveLength(0);
  });
});

describe("every way a save is sent reports into the queue (review: saveQueue.ts:76)", () => {
  test("a leave-save whose page survives (Back keeps it) updates the status when its answer comes", async () => {
    const h = harness();
    h.edit("Kept for Back");
    h.queue.sendNow();
    h.calls[0]!.resolve();
    await h.settle();
    expect(h.queue.upToDate).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ kind: "saved" });
  });

  test("restored from the back-forward cache with no answer, the queue sends the same edit again and ends saved", async () => {
    const h = harness();
    h.edit("Answer never came");
    h.queue.sendNow(); // its answer is lost with the frozen page
    const restored = h.queue.restored();
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.stamp).toBe(h.calls[0]!.stamp);
    h.calls[1]!.resolve();
    expect(await restored).toEqual({ ok: true });
    expect(h.statuses.at(-1)).toEqual({ kind: "saved" });
  });

  test("no answer is retried with the same number, then reported as not saved if it never comes", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save();
    for (let i = 0; i < 3; i++) {
      await h.settle();
      h.calls[i]!.reject(new NoAnswer());
    }
    await h.settle();
    h.calls[3]!.resolve();
    expect(await saved).toEqual({ ok: true });
    expect(new Set(h.calls.map((c) => c.stamp)).size).toBe(1);
  });

  test("an older save refused because a newer one was stored is not an error", async () => {
    const h = harness();
    h.edit("Older");
    const older = h.queue.save();
    await h.settle();
    h.edit("Newer");
    h.queue.sendNow();
    h.calls[1]!.resolve();
    await h.settle();
    h.calls[0]!.reject(Object.assign(new Error("A later change from this page was already saved."), { code: "superseded" }));
    expect(await older).toEqual({ ok: true });
    expect(h.statuses.at(-1)).toEqual({ kind: "saved" });
  });
});

describe("another page changed the campaign (ADR 0003 1.1.1, B7)", () => {
  test("a conflict keeps the draft, says so, and sends nothing more until the stored version is loaded", async () => {
    const h = harness();
    h.edit("Mine");
    const saved = h.queue.save();
    await h.settle();
    h.calls[0]!.reject(Object.assign(new Error("Changed elsewhere."), { code: "edit_conflict" }));
    expect(await saved).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.statuses.at(-1)).toEqual({ kind: "conflict", message: "Changed elsewhere.", saved: false });
    h.edit("Mine, again");
    expect(await h.queue.save()).toMatchObject({ ok: false, reason: "conflict" });
    h.queue.sendNow();
    expect(h.calls).toHaveLength(1);
    h.queue.loadedStored();
    expect(h.queue.inConflict).toBe(false);
    expect(h.statuses.at(-1)).toEqual({ kind: "idle" });
  });

  test("each save is based on the revision the page last had from the server", async () => {
    const h = harness();
    h.edit("A");
    void h.queue.save();
    await h.settle();
    expect(h.calls[0]!.base).toBe(0);
    h.calls[0]!.resolve();
    await h.settle();
    h.edit("B");
    void h.queue.save();
    await h.settle();
    expect(h.calls[1]!.base).toBe(1);
  });

  test("a draft larger than the leave-save can carry is refused in place and never sent (boundary)", async () => {
    const h = harness();
    const big = def("Big");
    h.setDraft({ ...big, tracks: [{ ...big.tracks[0]!, steps: [{ ...big.tracks[0]!.steps[0]!, body: "x".repeat(60_000) }] }] });
    expect(await h.queue.save()).toMatchObject({ ok: false, reason: "invalid" });
    h.queue.sendNow();
    expect(h.calls).toHaveLength(0);
  });
});

describe("PR 41 council, items 3, 4, 5 and 11", () => {
  test("after no answer the queue backs off between tries, a growing gap counted not waited (item 5)", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save();
    for (let i = 0; i < 2; i++) {
      await h.settle();
      h.calls[i]!.reject(new NoAnswer());
    }
    await h.settle();
    h.calls[2]!.resolve();
    expect(await saved).toEqual({ ok: true });
    expect(h.waits).toEqual([1_000, 2_000]);
  });

  test("the browser coming back online ends a backoff at once (item 5)", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    const q = new SaveQueue({
      read: () => ({ draft: def("A"), accountIds: [], version: 0 }),
      session: "p",
      put: () => (release === null ? Promise.reject(new NoAnswer()) : Promise.resolve(viewOf(def("A"), 1))),
      onStatus: () => undefined,
      onAccepted: () => undefined,
      wait: () => new Promise<void>((r) => (release = r)),
    });
    q.edited();
    const saved = q.save();
    await h.settle();
    expect(release).not.toBeNull();
    q.wake();
    expect(await saved).toEqual({ ok: true });
  });

  test("a retry carries the body first sent under its number, even if the inboxes changed meanwhile (item 4)", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save();
    await h.settle();
    h.setInboxes(["inbox-a", "inbox-b"]);
    h.calls[0]!.reject(new NoAnswer());
    await h.settle();
    expect(h.calls[1]!.definition).toEqual(h.calls[0]!.definition);
    h.calls[1]!.resolve();
    expect(await saved).toEqual({ ok: true });
  });

  test("a launch refused because the campaign changed elsewhere is the conflict state (item 3)", () => {
    const h = harness();
    h.queue.markConflict("Changed elsewhere.");
    expect(h.queue.inConflict).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ kind: "conflict", message: "Changed elsewhere.", saved: false });
  });

  test("leaving again cancels the leave-save still outstanding: at most one outlives the page (item 11)", async () => {
    const h = harness();
    h.edit("Left the first time");
    h.queue.sendNow();
    h.edit("Left the second time");
    h.queue.sendNow();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.aborted()).toBe(true);
    expect(h.calls[1]!.aborted()).toBe(false);
    expect(subject(h.calls[1]!.definition)).toBe("Left the second time");
  });
});

const subject = (d: CampaignDefinition) => d.tracks[0]?.steps[0]?.subject;
