import { describe, expect, test } from "vitest";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { NoAnswer, SaveQueue, draftProblems, type SaveStatus } from "./saveQueue.ts";

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

  test("a draft the server would refuse is not sent, and is a failure the status names as a draft that cannot be saved, not an error to try again", async () => {
    const h = harness();
    h.setDraft(def("A", { tracks: [{ ...def("A").tracks[0]!, window: [] }] }));
    expect(await h.queue.save()).toEqual({ ok: false, reason: "invalid", message: "Choose at least one sending day." });
    expect(h.calls).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ kind: "invalid", message: "Choose at least one sending day." });
  });

  test("an older save accepted while the newest draft cannot be saved leaves the status on that draft, never back to Saving…", async () => {
    const h = harness();
    h.edit("Valid");
    const first = h.queue.save();
    await h.settle();
    h.setDraft(def("B", { tracks: [{ ...def("B").tracks[0]!, window: [] }] }));
    h.calls[0]!.resolve();
    await first;
    expect(h.statuses.at(-1)).toEqual({ kind: "invalid", message: "Choose at least one sending day." });
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

  test("when the retries of an older valid save run out after the draft was made one that cannot be saved, the status is that draft's, not a Try again (council on aebeb80, item 4)", async () => {
    const h = harness();
    h.edit("A");
    const saved = h.queue.save();
    for (let i = 0; i < 4; i++) {
      await h.settle();
      h.calls[i]!.reject(new NoAnswer());
    }
    await h.settle();
    // The last try is in flight when the user makes the draft one that cannot be saved.
    h.setDraft(def("B", { tracks: [{ ...def("B").tracks[0]!, window: [] }] }));
    h.calls[4]!.reject(new NoAnswer());
    await saved;
    expect(h.statuses.at(-1)).toEqual({ kind: "invalid", message: "Choose at least one sending day." });
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

describe("an answer to a request sent before the user loaded the saved version changes nothing (council on aebeb80, item 2; invariant 6)", () => {
  test("a late 'replaced' after the load leaves the page idle and saving open", async () => {
    const h = harness();
    h.edit("A one");
    const first = h.queue.save();
    await h.settle();
    // Leaving sends #1 again with keepalive; that one is accepted; the ordinary #1 is still out.
    h.queue.sendNow();
    await h.settle();
    h.calls[1]!.resolve();
    await h.settle();
    // Page B saves over it; A's #2, sent on leaving again (the ordinary #1 still holds the queue), then
    // conflicts, and A, shown again, loads B's saved version.
    h.edit("A two");
    h.queue.sendNow();
    await h.settle();
    h.calls[2]!.reject(Object.assign(new Error("Changed elsewhere."), { code: "edit_conflict" }));
    await h.settle();
    expect(h.queue.inConflict).toBe(true);
    h.queue.loadedStored();
    expect(h.statuses.at(-1)).toEqual({ kind: "idle" });
    // The ordinary #1 is answered at last, late: replaced. It answers a draft the user set aside.
    h.calls[0]!.reject(Object.assign(new Error("Saved, then changed elsewhere."), { code: "replaced" }));
    await first;
    expect(h.statuses.at(-1)).toEqual({ kind: "idle" });
    expect(h.queue.inConflict).toBe(false);
    h.edit("After loading");
    void h.queue.save();
    await h.settle();
    expect(h.calls).toHaveLength(4);
  });

  test("a save asked for before the load, queued behind the old request, reports nothing once it runs (generated seed 845691)", async () => {
    const h = harness();
    h.edit("A one");
    const first = h.queue.save();
    await h.settle();
    h.edit("A two");
    const second = h.queue.save();
    h.queue.markConflict("Changed elsewhere.");
    h.queue.loadedStored();
    const before = h.statuses.length;
    h.calls[0]!.resolve();
    await first;
    await second;
    await h.settle();
    expect(h.statuses.slice(before)).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  test("after the load, a new save goes at once, not behind a request of the drafts set aside (generated seed 463057)", async () => {
    const h = harness();
    h.edit("A one");
    void h.queue.save();
    await h.settle();
    h.queue.markConflict("Changed elsewhere.");
    h.queue.loadedStored();
    h.edit("After loading");
    void h.queue.save();
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.statuses.at(-1)).toEqual({ kind: "saving" });
    // The old request's late answer changes nothing.
    h.calls[0]!.reject(Object.assign(new Error("Changed elsewhere."), { code: "edit_conflict" }));
    await h.settle();
    expect(h.statuses.at(-1)).toEqual({ kind: "saving" });
    h.calls[1]!.resolve();
    await h.settle();
    expect(h.statuses.at(-1)).toEqual({ kind: "saved" });
  });

  test("so does a late conflict, superseded or accepted answer", async () => {
    for (const late of ["edit_conflict", "superseded", "accepted"] as const) {
      const h = harness();
      h.edit("A one");
      const first = h.queue.save();
      await h.settle();
      h.queue.markConflict("Changed elsewhere.");
      h.queue.loadedStored();
      const before = h.statuses.length;
      if (late === "accepted") h.calls[0]!.resolve();
      else h.calls[0]!.reject(Object.assign(new Error("Late."), { code: late }));
      await first.catch(() => undefined);
      await h.settle();
      expect([late, h.statuses.slice(before), h.accepted.length, h.queue.inConflict]).toEqual([late, [], 0, false]);
    }
  });
});

describe("leaving the page when the newest draft cannot be saved (council on aebeb80, item 3)", () => {
  test("the last valid draft still unconfirmed goes with the request that outlives the page, under its own number", async () => {
    const h = harness();
    h.edit("Valid A");
    void h.queue.save();
    await h.settle();
    expect(h.calls).toHaveLength(1);
    h.setDraft(def("B", { tracks: [{ ...def("B").tracks[0]!, window: [] }] }));
    h.queue.sendNow();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ keepalive: true, stamp: 1 });
    expect(h.calls[1]!.definition.tracks[0]!.steps[0]!.subject).toBe("Valid A");
  });

  test("a valid draft never sent (the debounce had not fired) goes too, under its own number", () => {
    const h = harness();
    h.edit("Valid A");
    h.edit("Valid A, longer");
    h.setDraft(def("B", { tracks: [{ ...def("B").tracks[0]!, window: [] }] }));
    h.queue.sendNow();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ keepalive: true, stamp: 2 });
    expect(h.calls[0]!.definition.tracks[0]!.steps[0]!.subject).toBe("Valid A, longer");
  });

  test("nothing goes when every valid draft is confirmed", async () => {
    const h = harness();
    h.edit("Valid A");
    void h.queue.save();
    await h.settle();
    h.calls[0]!.resolve();
    await h.settle();
    h.setDraft(def("B", { tracks: [{ ...def("B").tracks[0]!, window: [] }] }));
    h.queue.sendNow();
    expect(h.calls).toHaveLength(1);
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

  test("a retry of a save the server accepted, then replaced with another page's that had seen it, is the conflict state saying this page's change was saved (generated seed 7369)", async () => {
    const h = harness();
    h.edit("Mine");
    const saved = h.queue.save();
    await h.settle();
    h.calls[0]!.reject(Object.assign(new Error("This page’s change was saved, then the sequence was changed on another page."), { code: "replaced" }));
    expect(await saved).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.queue.inConflict).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ kind: "conflict", message: "This page’s change was saved, then the sequence was changed on another page.", saved: true });
    // Typing after it: that edit is this page's own and not saved.
    h.edit("Mine, again");
    expect(await h.queue.save()).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.calls).toHaveLength(1);
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

  test("a page shown again cancels its leave-save at once and resends through the queue, so the next leave has the browser's whole budget (item 11, Chromium)", async () => {
    // Chromium frees an aborted keepalive request's share of the 64 KiB only once the abort has
    // settled, so cancelling it as the next leave-save is sent is too late for a large draft.
    const h = harness();
    h.edit("Left, then shown again");
    h.queue.sendNow();
    void h.queue.restored();
    await h.settle();
    expect(h.calls[0]!.aborted()).toBe(true);
    // The same save again, through the queue and not outliving the page; the server answers a repeat unchanged.
    expect(h.calls.slice(1).map((c) => [subject(c.definition), c.stamp, c.keepalive])).toEqual([["Left, then shown again", 1, false]]);
  });
});

const subject = (d: CampaignDefinition) => d.tracks[0]?.steps[0]?.subject;

describe("a draft that cannot be saved says which track and message (ticket 13b)", () => {
  const week = [{ day: 1, start: 9, end: 17 }];
  const track = (id: string, channel: "email" | "sms", waits: number[]): CampaignDefinition["tracks"][number] => ({
    id,
    channel,
    branch: "main",
    window: week,
    start: { kind: "entry" },
    removed: false,
    steps: waits.map((w, i) => ({ id: `${id}-${i}`, waitDays: w, subject: channel === "email" && i === 0 ? "Hi" : "", body: "x", threading: "new_subject", removed: false })),
  });
  const d = (...tracks: CampaignDefinition["tracks"]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks });

  test("with one track, its message names it as before; a text is a text", () => {
    expect(draftProblems(d(track("e", "email", [0, Number.NaN])))).toEqual(["Email 2's wait is a whole number of days, 0 or more."]);
    expect(draftProblems(d(track("m", "sms", [0, -1])))).toEqual(["Text 2's wait is a whole number of days, 0 or more."]);
  });

  test("with several tracks, each message names its track by channel and order", () => {
    expect(draftProblems(d(track("e", "email", [0]), track("m1", "sms", [0]), track("m2", "sms", [0, 1.5])))).toEqual(["SMS track 2: Text 2's wait is a whole number of days, 0 or more."]);
  });

  test("a phone track's call is a call, not an email (council on 10121d3, item 5)", () => {
    const call: CampaignDefinition["tracks"][number] = { ...track("p", "email", [0]), channel: "call", steps: [{ id: "p-0", waitDays: 2, subject: "", body: "", threading: "new_subject", removed: false }] };
    expect(draftProblems(d(track("e", "email", [0]), call))).toEqual(["Phone track: Call 1 is the first call, so it has no wait."]);
  });
});
