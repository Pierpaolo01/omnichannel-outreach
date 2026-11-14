import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { ApiError, CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { DEFINITION_MAX_BYTES } from "../../shared/limits.ts";
import { arrange, type ArrangeOperation } from "./arrangement.ts";
import { EditorStore } from "./editorStore.ts";
import { NoAnswer, draftProblems, type SaveStatus } from "./saveQueue.ts";

/**
 * The saving rule of ADR 0003 1.1.1, generated: the real editor state (EditorStore, which the page
 * binds through useSequence: its status, the draft replaced on an accepted answer, launch and load
 * pending, the conflict, and the pool sync that counts as an edit) against the real HTTP app and
 * engine over a fake provider. Two tabs edit one campaign. Each run mixes edits (some near or
 * over the size bound), the debounce firing, saves, launches and loads delivered late and out of
 * order, lost answers and the queue's retries, inboxes connecting (the pool follows), leaving a
 * tab (kept for Back, or gone with a new page and session), restores, typing while a launch or a
 * load is in flight and while in conflict. Since ticket 13b the edits also arrange tracks (an SMS or
 * email track added, started after another with a delay, its delay changed, removed: the editor's
 * arrangement operations) and SMS numbers connect, which the SMS pool follows. Requests are never lost; answers may be.
 *
 * Invariants (3, 6 and 7 after every step; the rest once the network settles):
 * 1. The stored definition is the newest draft typed in the session that wrote it, when that draft
 *    can be sent.
 * 2. No session's accepted save is replaced by another session's save unless that session had seen
 *    it; a refused page shows the conflict.
 * 3. A page's status is never "Saving…" or "Not saved" when the server has accepted its newest
 *    edit, and never "Saved" when it has not.
 * 4. Launch never starts a definition other than the one on the page.
 * 5. A refused page keeps what the user typed until they load the stored version.
 * 6. No answer (save, launch or load) replaces a draft newer than the one it answered.
 * 7. A conflict stays visible until the user resolves it, however much they type.
 *
 * 3b. A page whose newest draft cannot be sent never shows "Saving…" or "Saved" (after every step).
 *
 * How many runs (recorded in docs/agents/delivery-workflow.md): `pnpm check` runs 200 seeds (7000 to
 * 7199) and every seed that once failed (REGRESSIONS); the full search, in the `sequence-search`
 * workflow's eight shards (`pnpm test:save-search`), runs 2,000 seeds, a quarter of a thousand per
 * shard. Both are bounded by count, never by time. The five regressions were found by one run of
 * 1,000 seeds (14 November 2026) when `pnpm check` ran 60 and no search ran this test at all.
 *
 * Mutations that make it fail, each checked by hand when this was written:
 * - the server accepting a save whatever its base (sqlite-engine-store.ts): invariant 2;
 * - the server treating a repeat of the same session and number as a conflict: invariant 3;
 * - a leave-save that does not report into the queue, with restore doing nothing: invariant 3;
 * - no lock while a launch or a load is pending, and its answer replacing the draft regardless
 *   (editorStore.ts `update` and `answer`; council item 9, re-check B12): invariant 6;
 * - typing in conflict showing "Saving…" (editorStore.ts `update`; council item 10): invariant 7.
 */
/** The full search (`pnpm test:save-search`, in the `sequence-search` workflow), sharded by `SEQUENCE_SHARD`, "i/n". */
const FULL_SEARCH = process.env["SAVE_QUEUE_SEARCH"] === "full";
const SEEDS = Number(process.env["SAVE_QUEUE_SEEDS"] ?? (FULL_SEARCH ? 2_000 : 200));
const SHARD = /^(\d+)\/(\d+)$/.exec(process.env["SEQUENCE_SHARD"] ?? "");
const inShard = (index: number) => !FULL_SEARCH || !SHARD || index % Number(SHARD[2]) === Number(SHARD[1]) - 1;
/**
 * Seeds that once failed, run on every push. 7369, 7412, 7642 and 7889: a retry of a save the server
 * had accepted, after another page that had seen it saved over it, was refused as a conflict, and the
 * page said "Not saved". 7729: an older save of a page arriving after its newer one was accepted and
 * then replaced, the same. Both because the server forgot a session's accepted saves once another
 * session wrote (ADR 0003 1.1.1, migration 13).
 */
const REGRESSIONS = [7369, 7412, 7642, 7729, 7889];
const RUN_SEEDS = [...new Set([...Array.from({ length: SEEDS }, (_, i) => 7000 + i).filter((_, i) => inShard(i)), ...(FULL_SEARCH && SHARD ? [] : REGRESSIONS)])];
const STEPS = 60;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A definition whose first email has `subject`; `emails` long emails of `bodyLength` characters follow it. */
const definitionWith = (subject: string, emailPool: readonly string[], emails = 0, bodyLength = 0): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [...emailPool],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [
        { id: "s1", waitDays: 0, subject, body: "Hello.", threading: "new_subject", removed: false },
        ...Array.from({ length: emails }, (_, i) => ({ id: `s${i + 2}`, waitDays: 1, subject: "", body: "y".repeat(bodyLength), threading: "continue_thread" as const, removed: false })),
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});
const subjectOf = (d: CampaignDefinition) => d.tracks[0]?.steps[0]?.subject ?? "";
/** Read through a function: the store changes a page's status, which the checker cannot see. */
const kindOf = (store: EditorStore): SaveStatus["kind"] => store.getSnapshot().save.kind;
const inbox = (id: string): FakeAccount => ({ id, capacity: 30, gapMs: null, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" });

interface Page {
  readonly session: string;
  readonly store: EditorStore;
  frozen: boolean;
  gone: boolean;
  timer: (() => void) | null;
  /** The newest draft the user typed here that the editor took, if any. */
  newestTyped: string | null;
  /** The same, if it can be sent (within the size bound); null once one that cannot is typed. */
  newestSendable: string | null;
}

interface Request {
  readonly page: Page;
  readonly kind: "put" | "launch" | "load";
  readonly body: Record<string, unknown> & { save?: { session: string; seq: number; base: number }; definitionVersion?: number };
  readonly keepalive: boolean;
  answer: { status: number; json: unknown } | null;
  readonly resolve: (view: SequenceView) => void;
  readonly reject: (error: Error) => void;
  /** The page's draft when the launch was asked. */
  readonly draftAtLaunch?: CampaignDefinition;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function run(seed: number) {
  const r = rng(seed);
  const h = new EngineHarness({ start: Date.parse("2026-11-02T10:00:00Z"), accounts: [inbox("inbox-a")], sms: { numbers: [] } });
  const { campaign } = await h.createCampaign("Generated", {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })],
    people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" })],
  });
  // The engine learns the provider's inboxes on its tick; the pages' pool follows them.
  await h.tick();
  const path = `/api/campaigns/${campaign.id}/sequence`;
  const problems: string[] = [];
  const server = { writer: null as string | null, version: 0 };
  const writerNow = (): string | null => server.writer;
  /** Every save the server accepted, as session/number. */
  const accepted = new Set<string>();
  const putRaw = async (body: Request["body"]) => {
    const out = await h.request<unknown>("PUT", path, body);
    if (out.status === 200) {
      const view = out.body as SequenceView;
      if (body.save) accepted.add(`${body.save.session}/${body.save.seq}`);
      if (view.definitionVersion > server.version) {
        const session = body.save?.session ?? null;
        // Invariant 2: another session replaces a save only if it had seen it.
        if (server.writer !== null && session !== server.writer && body.save?.base !== server.version) problems.push(`2: ${session} replaced ${server.writer}'s revision ${server.version} from base ${body.save?.base}`);
        server.writer = session;
        server.version = view.definitionVersion;
      }
    }
    return { status: out.status, json: out.body };
  };
  expect((await putRaw({ ...definitionWith("start", []) })).status).toBe(200);
  server.writer = null;

  let typed = 0;
  let inboxes = 1;
  let numbers = 0;
  /**
   * An arrangement edit through the editor's own operations (ticket 13b), with the edit's marker in
   * the first step's subject so invariants 1, 5 and 6 can tell which draft is which. New texts get
   * copy, so a launch can start.
   */
  const arranged = (before: CampaignDefinition, subject: string): CampaignDefinition => {
    const live = before.tracks.filter((t) => !t.removed);
    const any = () => live[Math.floor(r() * live.length)]!;
    const roll = r();
    const op: ArrangeOperation =
      live.length === 0 || roll < 0.35 ? { kind: "add", channel: r() < 0.6 ? "sms" : "email" }
      : roll < 0.65 ? { kind: "start", trackId: any().id, start: r() < 0.3 ? { kind: "entry" } : { kind: "after", trackId: any().id, delayDays: Math.floor(r() * 3) } }
      : roll < 0.85 ? { kind: "delay", trackId: any().id, days: Math.floor(r() * 4) }
      : live.length > 1 ? { kind: "remove", trackId: any().id }
      : { kind: "add", channel: "sms" };
    const out = arrange(before, op);
    const base = out.ok ? out.definition : before;
    return {
      ...base,
      tracks: base.tracks.map((t, i) => ({
        ...t,
        steps: t.steps.map((st, k) => ({ ...st, body: st.body || "Text.", subject: i === 0 && k === 0 ? subject : t.channel === "email" && k === 0 && !st.subject ? "Hi" : st.subject })),
      })),
    };
  };
  // Held in an object and read through a function: a closure sets it, which the checker cannot see.
  const flags = { launched: false };
  const launchedOnce = (): boolean => flags.launched;
  const requests: Request[] = [];
  const pages: Page[] = [];
  const held = (page: Page, kind: Request["kind"], body: Request["body"], keepalive = false, draftAtLaunch?: CampaignDefinition) =>
    new Promise<SequenceView>((resolve, reject) => {
      requests.push({ page, kind, body, keepalive, answer: null, resolve, reject, ...(draftAtLaunch ? { draftAtLaunch } : {}) });
    });

  const openPage = async (): Promise<Page> => {
    const view = (await h.request<SequenceView>("GET", path)).body;
    const session = `s${pages.length}`;
    const page = { session, frozen: false, gone: false, timer: null, newestTyped: null, newestSendable: null } as Omit<Page, "store"> as Page;
    (page as { store: EditorStore }).store = new EditorStore(view, {
      session,
      put: (body, options) => held(page, "put", body as unknown as Request["body"], options.keepalive === true),
      launch: (definitionVersion) => held(page, "launch", { definitionVersion }, false, page.store.getSnapshot().draft),
      load: () => held(page, "load", {}),
      setTimer: (fire) => (page.timer = fire),
      clearTimer: () => (page.timer = null),
      // The backoff is counted by tries, never waited.
      wait: () => Promise.resolve(),
    });
    pages.push(page);
    return page;
  };

  const deliver = async (req: Request) => {
    if (req.kind === "put") req.answer = await putRaw(req.body);
    else if (req.kind === "load") {
      const out = await h.request<unknown>("GET", path);
      req.answer = { status: out.status, json: out.body };
    } else {
      h.provider.advance();
      const out = await h.request<unknown>("POST", `/api/campaigns/${campaign.id}/launch`, req.body);
      req.answer = { status: out.status, json: out.body };
      if (out.status === 200) {
        flags.launched = true;
        // Invariant 4: what started is what the page showed when it asked.
        const started = (await h.request<SequenceView>("GET", path)).body.definition;
        if (req.draftAtLaunch && JSON.stringify(started.tracks) !== JSON.stringify(req.draftAtLaunch.tracks)) problems.push("4: launch started a definition other than the page's");
      }
    }
  };
  const answer = (req: Request, lost: boolean) => {
    requests.splice(requests.indexOf(req), 1);
    if (req.page.gone) return;
    // Only a save is retried after no answer; a launch or a load gets its answer.
    if ((lost && req.kind === "put") || !req.answer) return req.reject(new NoAnswer());
    if (req.answer.status === 200) return req.resolve(req.answer.json as SequenceView);
    const error = (req.answer.json as ApiError).error;
    req.reject(Object.assign(new Error(error.message), { code: error.code }));
  };

  const check = (page: Page, settled: boolean) => {
    if (page.gone || page.frozen) return;
    const snap = page.store.getSnapshot();
    // Invariant 6: the draft on the page is the newest the user typed, unless they loaded the stored one.
    if (page.newestTyped !== null && subjectOf(snap.draft) !== page.newestTyped) problems.push(`6: ${page.session}'s draft "${subjectOf(snap.draft)}" replaced "${page.newestTyped}"`);
    // Invariant 7: a conflict stays shown while it holds.
    if (page.store.inConflict && kindOf(page.store) !== "conflict") problems.push(`7: ${page.session} hides its conflict behind ${kindOf(page.store)}`);
    if (page.newestTyped === null || launchedOnce()) return;
    const newestAccepted = accepted.has(`${page.session}/${page.store.edit}`);
    const status = page.store.getSnapshot().save;
    // A conflict says whether this page's own newest edit was saved before the other change.
    const says = status.kind === "conflict" ? (status.saved ? "saved" : "not saved") : status.kind;
    if (newestAccepted && (says === "error" || says === "invalid" || says === "not saved" || (settled && says === "saving"))) problems.push(`3: ${page.session} shows ${says} though its newest edit was accepted`);
    // 3b. A draft that cannot be sent is never "Saving…" or "Saved": nothing of it is being sent.
    if (page.newestSendable === null && !page.store.inConflict && (status.kind === "saving" || status.kind === "saved")) problems.push(`3b: ${page.session} shows ${status.kind} for "${page.newestTyped}", which cannot be saved`);
    if (!newestAccepted && says === "saved") problems.push(`3: ${page.session} shows ${status.kind} saved though "${page.newestTyped}" was not accepted`);
  };

  const tabs = [await openPage(), await openPage()];
  for (let step = 0; step < STEPS; step++) {
    const roll = r();
    const t = Math.floor(r() * 2);
    const page = tabs[t]!;
    const live = !page.frozen;
    if (roll < 0.25 && live) {
      const size = r();
      const subject = `typed ${++typed}`;
      const before = page.store.getSnapshot().draft;
      // What the page shows as locked is what refuses an edit: no authoring control is enabled while locked.
      const lockedBefore = page.store.getSnapshot().locked;
      const pool = before.emailPool;
      const next =
        size < 0.08 ? definitionWith(subject, pool, 4, 18_000)
        : size < 0.2 ? definitionWith(subject, pool, 3, Math.floor((DEFINITION_MAX_BYTES - 2_000) / 3))
        : size < 0.55 ? arranged(before, subject)
        : definitionWith(subject, pool);
      page.store.update(() => next);
      // Typing is refused once launched and while a launch or a load is in flight: nothing was typed.
      if (page.store.getSnapshot().draft === before && !lockedBefore) problems.push(`6: ${page.session} refused an edit while editing was shown open`);
      if (page.store.getSnapshot().draft !== before) {
        if (lockedBefore) problems.push(`6: ${page.session} took an edit while editing was shown locked`);
        page.newestTyped = subject;
        page.newestSendable = draftProblems(next).length === 0 ? subject : null;
      }
    } else if (roll < 0.36 && live && page.timer) {
      const fire = page.timer;
      page.timer = null;
      fire();
    } else if (roll < 0.52) {
      const pending = requests.filter((x) => x.answer === null);
      const req = pending[Math.floor(r() * pending.length)];
      if (req) await deliver(req);
    } else if (roll < 0.68) {
      const req = requests.find((x) => x.answer !== null && !x.page.frozen);
      if (req) answer(req, r() < 0.3);
    } else if (roll < 0.73 && live && kindOf(page.store) === "conflict" && page.store.getSnapshot().pending === null) {
      // Invariant 5: until now the refused page still held what was typed.
      if (page.newestTyped !== null && subjectOf(page.store.getSnapshot().draft) !== page.newestTyped) problems.push(`5: ${page.session} lost its draft before loading the stored version`);
      // Loading sets aside what was typed before choosing it, never what was typed after.
      const chosenOver = page.newestTyped;
      void page.store.loadStored().then(() => {
        if (!page.store.inConflict && page.newestTyped === chosenOver) {
          page.newestTyped = null;
          page.newestSendable = null;
        }
      });
    } else if (roll < 0.77 && live && !launchedOnce() && page.store.getSnapshot().pending === null) {
      void page.store.launch().catch(() => undefined);
    } else if (roll < 0.79 && !launchedOnce()) {
      // Another inbox or SMS number connects: the pages learn it with their next answer, and save the pool.
      if (r() < 0.5) h.fake.accountsById.set(`inbox-${++inboxes}`, inbox(`inbox-${inboxes}`));
      else h.sms.numbers.set(`+4477009005${String(++numbers).padStart(2, "0")}`, { id: `+4477009005${String(numbers).padStart(2, "0")}`, capacity: 30, gapMs: null, k: 1, healthy: true, resetZone: "Europe/London" });
      await h.tick();
    } else if (roll < 0.85 && live) {
      page.store.leavePage();
      page.timer = null;
      page.frozen = true;
    } else if (roll < 0.91 && page.frozen) {
      page.frozen = false;
      void page.store.restored();
    } else if (roll < 0.95) {
      if (!page.frozen) page.store.leavePage();
      page.gone = true;
      for (const req of [...requests]) if (req.page === page && !req.keepalive && req.answer === null && r() < 0.5) requests.splice(requests.indexOf(req), 1);
      tabs[t] = await openPage();
    }
    await flush();
    for (const p of tabs) check(p, false);
  }

  // The network settles: both tabs live, pending debounces fire, every request arrives and is answered.
  for (const page of tabs) {
    if (page.frozen) {
      page.frozen = false;
      void page.store.restored();
    }
    if (page.timer) {
      const fire = page.timer;
      page.timer = null;
      fire();
    }
  }
  for (let guard = 0; guard < 2_000; guard++) {
    await flush();
    const req = requests[0];
    if (!req) break;
    if (req.answer === null) await deliver(req);
    answer(req, false);
  }
  await flush();
  for (const p of tabs) check(p, true);

  if (!launchedOnce()) {
    const stored = subjectOf((await h.request<SequenceView>("GET", path)).body.definition);
    const holder = pages.find((p) => p.session === writerNow());
    // Invariant 1: the stored definition is the newest sendable draft of the session that wrote it.
    if (holder?.newestSendable != null && holder.newestSendable === holder.newestTyped && stored !== holder.newestSendable && !holder.store.inConflict) problems.push(`1: stored "${stored}" is not ${holder.session}'s newest "${holder.newestSendable}"`);
    // Invariant 2's other half: a live page whose newest sendable draft lost to another session shows the conflict.
    for (const p of tabs) {
      if (p.newestSendable !== null && p.newestSendable === p.newestTyped && !accepted.has(`${p.session}/${p.store.edit}`) && writerNow() !== p.session && kindOf(p.store) !== "conflict") {
        problems.push(`2: ${p.session}'s newest "${p.newestSendable}" lost to ${writerNow() ?? "nobody"} with no conflict shown`);
      }
    }
  }
  const stored = (await h.request<SequenceView>("GET", path)).body.definition;
  const smsSaved = stored.tracks.some((t) => !t.removed && t.channel === "sms") && (stored.smsPool ?? []).length > 0;
  return { problems, pending: requests.length, launchedOnce: launchedOnce(), smsSaved };
}

describe("saving the definition, generated over the real editor state (ADR 0003 1.1.1)", () => {
  const launched: boolean[] = [];
  const smsSaved: boolean[] = [];
  for (const seed of RUN_SEEDS) {
    test(`run ${seed}`, async () => {
      const out = await run(seed);
      launched.push(out.launchedOnce);
      smsSaved.push(out.smsSaved);
      expect(out.pending).toBe(0);
      expect(out.problems).toEqual([]);
    });
  }
  test("the runs include launches that start, not only refused ones", () => {
    expect(launched.filter(Boolean).length).toBeGreaterThan(RUN_SEEDS.length / 10);
  });
  test("the runs save arranged SMS tracks with the numbers that connected (ticket 13b)", () => {
    expect(smsSaved.filter(Boolean).length).toBeGreaterThan(RUN_SEEDS.length / 20);
  });
});
