import { describe, expect, test } from "vitest";
import type { CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { EditorStore } from "./editorStore.ts";

/**
 * The editor's own rules (ADR 0003 1.1.1, invariants 6 and 7), at the store the page binds to:
 * no answer replaces a draft newer than the one it answered, and a conflict stays shown until the
 * user loads the saved version. Requests are held and released by hand.
 */
const def = (subject: string): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  tracks: [{ id: "t1", channel: "email", branch: "main", window: [{ day: 1, start: 9, end: 17 }], steps: [{ id: "s1", waitDays: 0, subject, body: "Hello.", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false }],
});
const view = (subject: string, version: number, launched = false): SequenceView => ({
  campaignId: "c1",
  definition: def(subject),
  definitionVersion: version,
  editedAt: null,
  launchedAt: launched ? "2026-11-13T09:00:00.000Z" : null,
  launch: { blockers: [], nothingToLaunch: false, canLaunch: true },
  accounts: [],
});
const subjectOf = (s: EditorStore) => s.getSnapshot().draft.tracks[0]?.steps[0]?.subject;

interface Held<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

function harness() {
  const puts: (Held<SequenceView> & { subject: string | undefined; version: number })[] = [];
  const launches: Held<SequenceView>[] = [];
  const loads: Held<SequenceView>[] = [];
  let timer: (() => void) | null = null;
  let version = 1;
  const store = new EditorStore(view("Stored", 1), {
    session: "page",
    wait: () => Promise.resolve(),
    put: (body) =>
      new Promise((resolve, reject) => {
        puts.push({ resolve, reject, subject: body.tracks[0]?.steps[0]?.subject, version: body.save.base });
      }),
    launch: () => new Promise((resolve, reject) => launches.push({ resolve, reject })),
    load: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
    setTimer: (run) => (timer = run),
    clearTimer: () => (timer = null),
  });
  const type = (subject: string) => store.update((d) => ({ ...d, tracks: d.tracks.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s, subject })) })) }));
  const fire = () => {
    const run = timer;
    timer = null;
    run?.();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Answers the oldest held save as the server would, accepting it. */
  const accept = async () => {
    const put = puts.shift();
    put?.resolve(view(put.subject ?? "", ++version));
    await settle();
  };
  const conflict = async () => {
    puts.shift()?.reject(Object.assign(new Error("Changed elsewhere."), { code: "edit_conflict" }));
    await settle();
  };
  return { store, type, fire, settle, accept, conflict, puts, launches, loads };
}

describe("no answer replaces a draft newer than the one it answered (invariant 6)", () => {
  test("while a launch is pending, typing is refused, so the launch's answer never discards copy (council item 9)", async () => {
    const h = harness();
    h.type("Ready to launch");
    const launched = h.store.launch();
    await h.settle();
    await h.accept();
    expect(h.launches).toHaveLength(1);
    expect(h.store.getSnapshot().pending).toBe("launch");
    h.type("Typed while the launch is pending");
    expect(subjectOf(h.store)).toBe("Ready to launch");
    expect(h.store.getSnapshot().locked).toBe(true);
    h.launches[0]!.resolve(view("Ready to launch", 2, true));
    await launched;
    expect([subjectOf(h.store), h.store.getSnapshot().pending]).toEqual(["Ready to launch", null]);
    // Launched: still locked, for good.
    expect(h.store.getSnapshot().locked).toBe(true);
  });

  test("while the saved version loads, typing is refused, so the load never erases copy typed after choosing it (re-check B12)", async () => {
    const h = harness();
    h.type("Stale tab's copy");
    h.fire();
    await h.settle();
    await h.conflict();
    const loading = h.store.loadStored();
    expect(h.store.getSnapshot().pending).toBe("load");
    h.type("Typed after choosing Load the saved version");
    expect(subjectOf(h.store)).toBe("Stale tab's copy");
    h.loads[0]!.resolve(view("Other tab's saved copy", 2));
    await loading;
    expect([subjectOf(h.store), h.store.inConflict, h.store.getSnapshot().pending, h.store.getSnapshot().locked]).toEqual(["Other tab's saved copy", false, null, false]);
    // Editing carries on from the loaded version, saved from its revision.
    h.type("After loading");
    h.fire();
    await h.settle();
    expect(h.puts.map((p) => [p.subject, p.version])).toEqual([["After loading", 2]]);
  });

  test("a save's answer replaces the draft only if no edit came after it", async () => {
    const h = harness();
    h.type("First");
    h.fire();
    await h.settle();
    h.type("Second, typed while the first was in flight");
    await h.accept();
    expect(subjectOf(h.store)).toBe("Second, typed while the first was in flight");
  });
});

describe("a conflict stays visible until the user resolves it (invariant 7)", () => {
  test("typing after a conflict keeps the conflict and its way out, and sends nothing (council item 10, re-check B11)", async () => {
    const h = harness();
    h.type("Stale tab's copy");
    h.fire();
    await h.settle();
    await h.conflict();
    expect(h.store.getSnapshot().save.kind).toBe("conflict");
    h.type("Keeps typing after the conflict");
    h.fire();
    await h.settle();
    expect([h.store.getSnapshot().save.kind, subjectOf(h.store), h.puts.length]).toEqual(["conflict", "Keeps typing after the conflict", 0]);
  });

  test("a launch refused because the campaign changed elsewhere becomes the conflict state (council item 3)", async () => {
    const h = harness();
    const launched = h.store.launch();
    await h.settle();
    h.launches[0]!.reject(Object.assign(new Error("Changed elsewhere."), { code: "changed_elsewhere" }));
    await expect(launched).rejects.toThrow("Changed elsewhere.");
    expect([h.store.getSnapshot().save.kind, h.store.inConflict]).toEqual(["conflict", true]);
  });
});

describe("the email pool follows the connected email inboxes only", () => {
  test("an SMS number the engine knows never enters the email pool (merge of ticket 13a)", async () => {
    const puts: CampaignDefinition[] = [];
    const account = (id: string, channel: "email" | "sms") => ({ id, label: id, channel, healthy: true, capacity: 30, gapSeconds: 0, usedToday: 0, waiting: null });
    new EditorStore({ ...view("Stored", 1), accounts: [account("inbox-a", "email"), account("+447700900001", "sms")] }, {
      session: "page",
      put: (body) => {
        puts.push(body);
        return new Promise(() => undefined);
      },
      launch: () => new Promise(() => undefined),
      load: () => new Promise(() => undefined),
      setTimer: () => null,
      clearTimer: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(puts.map((p) => p.emailPool)).toEqual([["inbox-a"]]);
  });
});
