import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeAccount } from "../../../test/support/fake-email-port.ts";
import type { ApiError, CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { DEFINITION_MAX_BYTES } from "../../shared/limits.ts";
import { arrange, type ArrangeOperation } from "./arrangement.ts";
import { EditorStore, type SaveFault } from "./editorStore.ts";
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
 * arrangement operations) and SMS numbers connect, which the SMS pool follows. Since ticket 16b the
 * generated user also sets phone tracks' declined paths and adds, arranges and removes win-back branch
 * tracks, through the same operations, from a stream of its own; each page keeps its own record of
 * what it chose (`Shape`), and the draft on the page and the stored definition are checked against it.
 * Requests are never lost; answers may be.
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
 * 6 also covers an answer to a save sent before its page loaded the saved version: it changes nothing
 *    the page shows (status, conflict, draft), checked after every such answer.
 * 1 and 6 also hold for the declined paths and the win-back branch (ticket 16b): after every step the
 *    page's draft has the phone tracks' declined paths and the branch's tracks the page's record says it
 *    chose, and once settled the stored definition has the writer's.
 *
 * How many runs (recorded in docs/agents/delivery-workflow.md): `pnpm check` runs 200 fixed seeds (7000
 * to 7199), every seed that once failed (REGRESSIONS), and a window of 100 seeds that moves with each
 * commit (printed; SAVE_QUEUE_WINDOW_FROM reruns it); the full search, in the `sequence-search`
 * workflow's eight shards (`pnpm test:save-search`), runs 2,000 seeds, a quarter of a thousand per
 * shard. All bounded by count, never by time. The five regressions were found by one run of
 * 1,000 seeds (14 November 2026) when `pnpm check` ran 60 and no search ran this test at all.
 *
 * Mutations that make it fail, each checked by hand when this was written:
 * - the server accepting a save whatever its base (sqlite-engine-store.ts): invariant 2;
 * - the server treating a repeat of the same session and number as a conflict: invariant 3;
 * - a leave-save that does not report into the queue, with restore doing nothing: invariant 3;
 * - no lock while a launch or a load is pending, and its answer replacing the draft regardless
 *   (editorStore.ts `update` and `answer`; council item 9, re-check B12): invariant 6;
 * - typing in conflict showing "Saving…" (editorStore.ts `update`; council item 10): invariant 7;
 * - no generation gate, so an answer, or a queued save, from before the page loaded the saved version
 *   still changes it (saveQueue.ts `send`, `save` and `step`; council on aebeb80, item 2): invariant 6.
 *
 * Faults injected on every push (ticket 16b; `SaveFault` in editorStore.ts), each killed by its recorded
 * fixed seed (FAULT_SEEDS): a save that leaves out each phone track's declined path, and a save that leaves
 * out the win-back branch's tracks.
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
 * session wrote (ADR 0003 1.1.1, migration 13). 845691, from the first moving window: a save asked for
 * before the page loaded the saved version, queued behind the old request, then ran and said "Saved"
 * over the page's idle state (council on aebeb80, item 2). 463057, from the next window: after the
 * load, the pool sync's save of the new draft waited behind the old request and started only on its
 * late answer; a new generation's saves no longer queue behind the old one's.
 */
const REGRESSIONS = [7369, 7412, 7642, 7729, 7889, 845691, 463057];
/**
 * The fixed seed known to kill each fault (ticket 16b), found by `SAVE_QUEUE_FAULT_SEARCH=1` over the fixed
 * seeds. The recorded seeds above replay the trajectories they were recorded with, so the generated user
 * makes no declined-path or branch edit on them.
 */
const FAULT_SEEDS: Record<SaveFault, number> = { declined_path_not_sent: 7003, win_back_tracks_not_sent: 7004 };
/** The commit the moving window is derived from: CI's, else the checkout's HEAD, else none. */
function commitOf(): string {
  if (process.env["GITHUB_SHA"]) return process.env["GITHUB_SHA"];
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "0";
  }
}
/**
 * A window of seeds that moves with each commit (council on aebeb80, item 6): `pnpm check` also runs
 * WINDOW seeds starting at a number derived from the commit, so pushes over time try seeds the fixed
 * set never reaches. It is printed, and SAVE_QUEUE_WINDOW_FROM reruns it. The full search runs its own
 * 2,000 and no window.
 */
const WINDOW = FULL_SEARCH ? 0 : Number(process.env["SAVE_QUEUE_WINDOW"] ?? 100);
const COMMIT = commitOf();
const WINDOW_FROM = process.env["SAVE_QUEUE_WINDOW_FROM"] ? Number(process.env["SAVE_QUEUE_WINDOW_FROM"]) : 100_000 + (Number.parseInt(COMMIT.slice(0, 8), 16) || 0) % 900_000;
if (WINDOW > 0) console.info(`The save test's moving window: seeds ${WINDOW_FROM} to ${WINDOW_FROM + WINDOW - 1}, from commit ${COMMIT.slice(0, 12)}. Rerun it with SAVE_QUEUE_WINDOW_FROM=${WINDOW_FROM}.`);
const RUN_SEEDS = [
  ...new Set([
    ...Array.from({ length: SEEDS }, (_, i) => 7000 + i).filter((_, i) => inShard(i)),
    ...(FULL_SEARCH && SHARD ? [] : REGRESSIONS),
    ...Array.from({ length: WINDOW }, (_, i) => WINDOW_FROM + i),
  ]),
];
/** The coverage checks below hold over many runs, not over a few (council on aebeb80, item 5). */
const ENOUGH_FOR_COVERAGE = SEEDS >= 100;
/**
 * How many coverage runs a behaviour must be reached in. In `pnpm check` the coverage seeds are the fixed and
 * recorded ones, the same on every run, so a share of them is a fixed bar a change can only fail by changing
 * what the generator reaches. One shard of the full search runs other seeds, a different set per shard, where
 * a share is a matter of chance (CI shard 6 on 8147ba6: 4 arranged branches against 6.25), so there each
 * behaviour must be reached at least once; the search is for broken invariants (review bot on 8147ba6).
 */
const atLeast = (share: number): number => (FULL_SEARCH && SHARD ? 0 : COVERAGE_SEEDS.size * share);
/**
 * The seeds the coverage checks count over: the fixed and recorded ones, the same on every commit. The moving
 * window runs every invariant on its seeds but takes no part in coverage counts, so they cannot depend on the
 * commit (CI on 98927b6: a window of few SMS saves failed a share taken over every seed run).
 */
const FIXED_SEEDS = Array.from({ length: SEEDS }, (_, i) => 7000 + i).filter((_, i) => inShard(i));
const COVERAGE_SEEDS = new Set([...FIXED_SEEDS, ...(FULL_SEARCH && SHARD ? [] : REGRESSIONS)]);
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

/**
 * A definition whose first email has `subject`; `emails` long emails of `bodyLength` characters follow
 * it. The edit's marker is the campaign's call script, which every draft has whatever its tracks
 * (ticket 14c: a phone track may come first, and a call has no subject).
 */
const definitionWith = (subject: string, emailPool: readonly string[], emails = 0, bodyLength = 0): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  callScript: subject,
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
const subjectOf = (d: CampaignDefinition) => d.callScript ?? "";
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
  /** What this page chose for the declined paths and the win-back branch in its newest typed draft (ticket 16b). */
  shape: Shape;
}

interface Request {
  readonly page: Page;
  readonly kind: "put" | "launch" | "load";
  readonly body: Record<string, unknown> & { save?: { session: string; seq: number; base: number }; definitionVersion?: number };
  readonly keepalive: boolean;
  /** How many times the page had loaded the saved version when the request was sent. */
  readonly loads: number;
  /** Held back, unanswered, until its page has loaded the saved version more times than this (a late answer after a load). */
  heldPastLoads?: number;
  answer: { status: number; json: unknown } | null;
  readonly resolve: (view: SequenceView) => void;
  readonly reject: (error: Error) => void;
  /** The page's draft when the launch was asked. */
  readonly draftAtLaunch?: CampaignDefinition;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/**
 * What a page chose for the declined paths and the win-back branch (ticket 16b): each live main phone
 * track's declined path (null when none is set), and each live branch track's channel and start. Kept by
 * the generated user from the operations it applied, never read back from the editor, except as the base
 * when the page shows a definition it did not type (a load).
 */
interface Shape {
  readonly paths: Readonly<Record<string, string | null>>;
  readonly branch: Readonly<Record<string, string>>;
}
const startKey = (start: CampaignDefinition["tracks"][number]["start"]) => (start.kind === "entry" ? "entry" : `after ${start.trackId} ${start.delayDays}`);
/** The shape a definition has, to compare with a record. */
function shapeOf(def: CampaignDefinition): Shape {
  const live = def.tracks.filter((t) => !t.removed);
  return {
    paths: Object.fromEntries(live.filter((t) => t.channel === "call" && t.branch === "main").map((t) => [t.id, t.declinedPath ?? null])),
    branch: Object.fromEntries(live.filter((t) => t.branch === "win_back").map((t) => [t.id, `${t.channel} ${startKey(t.start)}`])),
  };
}
const sameShape = (a: Shape, b: Shape) => JSON.stringify([Object.entries(a.paths).sort(), Object.entries(a.branch).sort()]) === JSON.stringify([Object.entries(b.paths).sort(), Object.entries(b.branch).sort()]);
const NO_SHAPE: Shape = { paths: {}, branch: {} };

async function run(seed: number, faults?: ReadonlySet<SaveFault>) {
  const r = rng(seed);
  // A third stream for the declined paths and the win-back branch (ticket 16b); none on a recorded seed.
  const r3 = rng(seed ^ 0x16b0_16b0);
  const branchEdits = !REGRESSIONS.includes(seed);
  // A second stream for what was added later (the late answer after a load), so the first stream's
  // choices, and the recorded seeds, stay as they were until it first acts.
  const r2 = rng(seed ^ 0x5eed_c0de);
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
  const phoneCoverage = { phoneSaved: false, phoneAny: false, winBackSaved: false, declinedSaved: false, branchArranged: false };
  const putRaw = async (body: Request["body"]) => {
    const out = await h.request<unknown>("PUT", path, body);
    if (out.status === 200) {
      const view = out.body as SequenceView;
      if (body.save) accepted.add(`${body.save.session}/${body.save.seq}`);
      const tracks = (body as unknown as CampaignDefinition).tracks;
      if (tracks.some((t) => !t.removed && t.channel === "call" && t.callSkipLimitDays !== undefined && t.callSkipLimitDays !== 2)) phoneCoverage.phoneSaved = true;
      if (tracks.some((t) => !t.removed && t.channel === "call")) phoneCoverage.phoneAny = true;
      if (tracks.some((t) => !t.removed && t.channel === "call" && t.declinedPath === "win_back") && tracks.some((t) => !t.removed && t.branch === "win_back")) phoneCoverage.winBackSaved = true;
      if (tracks.some((t) => !t.removed && t.branch === "win_back" && t.start.kind === "after")) phoneCoverage.branchArranged = true;
      if (tracks.some((t) => !t.removed && t.channel === "call" && (t.declinedPath === "stop" || t.declinedPath === "continue"))) phoneCoverage.declinedSaved = true;
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
   * An arrangement edit through the editor's own operations (ticket 13b), or an edit of a phone
   * track's calling hours or skip limit (ticket 14c), with the edit's marker in the call script so
   * invariants 1, 5 and 6 can tell which draft is which. New texts get copy, so a launch can start;
   * a call keeps none. A skip limit of 0 is a draft that cannot be saved, as a bad wait is.
   */
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const pick3 = <T,>(xs: readonly T[]): T => xs[Math.floor(r3() * xs.length)]!;
  /**
   * A declined path or a win-back branch edit (ticket 16b), through the editor's operations, from its own
   * stream: what the inspector's path choice and the branch's add, starts, delays and remove do. Refused
   * ones (win back with no branch track, the branch's last track under win back, a connection across
   * branches, a phone track in the branch) leave the draft as it was. Returns the draft and the record.
   */
  const branchEdit = (before: CampaignDefinition, shape: Shape): { definition: CampaignDefinition; shape: Shape } | null => {
    const live = before.tracks.filter((t) => !t.removed);
    const calls = live.filter((t) => t.channel === "call" && t.branch === "main");
    const branch = live.filter((t) => t.branch === "win_back");
    const roll = r3();
    let op: ArrangeOperation;
    // The branch is entered from a phone track's declined path, so a draft with none gets one first.
    if (calls.length === 0) op = { kind: "add", channel: "call" };
    // Win back mostly once the branch has a track; sometimes before, which is refused.
    else if (roll < 0.3) op = { kind: "declined", trackId: pick3(calls).id, path: pick3(branch.length > 0 ? (["stop", "continue", "win_back", "win_back", "win_back"] as const) : (["stop", "continue", "win_back"] as const)) };
    else if (branch.length === 0 || roll < (branch.length > 1 ? 0.45 : 0.6)) op = { kind: "add", channel: pick3(["email", "sms", "sms", "call"] as const), branch: "win_back" };
    else if (roll < 0.75) {
      // After another track of the branch, mostly; sometimes at its entry, or after a main track (refused).
      const subject = pick3(branch);
      const others = branch.filter((t) => t.id !== subject.id);
      const target = r3() < 0.15 || others.length === 0 ? pick3(live) : pick3(others);
      op = { kind: "start", trackId: subject.id, start: r3() < 0.2 ? { kind: "entry" } : { kind: "after", trackId: target.id, delayDays: Math.floor(r3() * 3) } };
    }
    else if (roll < 0.85) op = { kind: "delay", trackId: pick3(branch).id, days: Math.floor(r3() * 4) };
    else op = { kind: "remove", trackId: pick3(branch).id };
    const out = arrange(before, op);
    if (!out.ok) return null;
    // The record: what this operation chose, kept apart from the editor's draft.
    const paths = { ...shape.paths };
    const without = (record: Readonly<Record<string, string>>, id: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== id));
    let kept: Record<string, string> = { ...shape.branch };
    if (op.kind === "declined") paths[op.trackId] = op.path;
    else if (op.kind === "add" && out.added && op.branch !== "win_back") paths[out.added.id] = null;
    else if (op.kind === "add" && out.added) kept[out.added.id] = `${op.channel} entry`;
    else if (op.kind === "start") kept[op.trackId] = `${kept[op.trackId]?.split(" ")[0] ?? ""} ${startKey(op.start)}`;
    else if (op.kind === "delay") kept[op.trackId] = (kept[op.trackId] ?? "").replace(/ \d+$/, ` ${op.days}`);
    else if (op.kind === "remove") kept = without(kept, op.trackId);
    return { definition: out.definition, shape: { paths, branch: kept } };
  };
  /** The record after an edit of the main sequence: a phone track added has no path; one removed has none. */
  const mainShape = (shape: Shape, op: ArrangeOperation, added: string | null): Shape => {
    const paths: Record<string, string | null> = Object.fromEntries(Object.entries(shape.paths).filter(([id]) => op.kind !== "remove" || id !== op.trackId));
    if (op.kind === "add" && op.channel === "call" && added) paths[added] = null;
    return { paths, branch: shape.branch };
  };
  const arranged = (before: CampaignDefinition, subject: string, shape: Shape): { definition: CampaignDefinition; shape: Shape } => {
    const finish = (base: CampaignDefinition, next: Shape) => ({
      definition: {
        ...base,
        callScript: subject,
        tracks: base.tracks.map((t) => (t.channel === "call" ? t : { ...t, steps: t.steps.map((st, k) => ({ ...st, body: st.body || "Text.", subject: t.channel === "email" && k === 0 && !st.subject ? "Hi" : st.subject })) })),
      },
      shape: next,
    });
    if (branchEdits && r3() < (before.tracks.some((t) => !t.removed && t.channel === "call") ? 0.85 : 0.5)) {
      // One to three of them before the save goes, as a user does in the inspector within the debounce.
      let edited = { definition: before, shape };
      for (let n = 1 + Math.floor(r3() * 3); n > 0; n--) edited = branchEdit(edited.definition, edited.shape) ?? edited;
      return finish(edited.definition, edited.shape);
    }
    // The main sequence's own edits never name a branch track (ticket 16b): the branch has its own.
    const live = before.tracks.filter((t) => !t.removed && t.branch === "main");
    const any = () => live[Math.floor(r() * live.length)]!;
    const calls = live.filter((t) => t.channel === "call");
    const phoneEdit = (): Partial<CampaignDefinition["tracks"][number]> =>
      r() < 0.4 ? { window: [1, 2, 3, 4, 5, 6].filter(() => r() < 0.6).map((day) => ({ day, start: 8 + Math.floor(r() * 3), end: 16 + Math.floor(r() * 4) })) } : { callSkipLimitDays: pick([1, 3, 5, 0]) };
    if (calls.length > 0 && r() < 0.4) {
      const call = calls[Math.floor(r() * calls.length)]!;
      const change = phoneEdit();
      return { definition: { ...before, callScript: subject, tracks: before.tracks.map((t) => (t.id === call.id ? { ...t, ...change } : t)) }, shape };
    }
    const roll = r();
    const op: ArrangeOperation =
      live.length === 0 || roll < 0.35 ? { kind: "add", channel: pick(["sms", "sms", "sms", "email", "call"]) }
      : roll < 0.65 ? { kind: "start", trackId: any().id, start: r() < 0.3 ? { kind: "entry" } : { kind: "after", trackId: any().id, delayDays: Math.floor(r() * 3) } }
      : roll < 0.85 ? { kind: "delay", trackId: any().id, days: Math.floor(r() * 4) }
      : live.length > 1 ? { kind: "remove", trackId: any().id }
      : { kind: "add", channel: "sms" };
    const out = arrange(before, op);
    // A phone track just added is often given its hours or skip limit in the same draft, as the
    // inspector it opens in invites; most drafts are replaced before their save goes.
    const added = out.ok && out.added?.channel === "call" && r() < 0.6 ? { id: out.added.id, change: phoneEdit() } : null;
    const base = out.ok ? { ...out.definition, tracks: out.definition.tracks.map((t) => (t.id === added?.id ? { ...t, ...added.change } : t)) } : before;
    return finish(base, out.ok ? mainShape(shape, op, out.added?.id ?? null) : shape);
  };
  // Held in an object and read through a function: a closure sets it, which the checker cannot see.
  const flags = { launched: false };
  const launchedOnce = (): boolean => flags.launched;
  const requests: Request[] = [];
  const pages: Page[] = [];
  const held = (page: Page, kind: Request["kind"], body: Request["body"], keepalive = false, draftAtLaunch?: CampaignDefinition) =>
    new Promise<SequenceView>((resolve, reject) => {
      requests.push({ page, kind, body, keepalive, loads: page.store.loads, answer: null, resolve, reject, ...(draftAtLaunch ? { draftAtLaunch } : {}) });
    });

  const openPage = async (): Promise<Page> => {
    const view = (await h.request<SequenceView>("GET", path)).body;
    const session = `s${pages.length}`;
    const page = { session, frozen: false, gone: false, timer: null, newestTyped: null, newestSendable: null, shape: NO_SHAPE } as Omit<Page, "store"> as Page;
    (page as { store: EditorStore }).store = new EditorStore(view, {
      session,
      put: (body, options) => held(page, "put", body as unknown as Request["body"], options.keepalive === true),
      launch: (definitionVersion) => held(page, "launch", { definitionVersion }, false, page.store.getSnapshot().draft),
      load: () => held(page, "load", {}),
      setTimer: (fire) => (page.timer = fire),
      clearTimer: () => (page.timer = null),
      // The backoff is counted by tries, never waited.
      wait: () => Promise.resolve(),
      ...(faults ? { faults } : {}),
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
  /** Whether a request is held back until its page's load answers. */
  const heldBack = (x: Request) => x.heldPastLoads !== undefined && x.page.store.loads <= x.heldPastLoads && !x.page.gone;
  /** Answers to a save sent before its page loaded the saved version, with what the page showed before them (invariant 6). */
  const late: { page: Page; shown: string }[] = [];
  /** How many late answers to a save sent before its page loaded the saved version this run gave (coverage). */
  let lateAfterLoad = 0;
  const shownBy = (page: Page) => JSON.stringify([page.store.getSnapshot().save, page.store.inConflict, page.store.getSnapshot().draft]);
  const answer = (req: Request, lost: boolean) => {
    requests.splice(requests.indexOf(req), 1);
    if (req.page.gone) return;
    if (req.kind === "put" && req.loads < req.page.store.loads && !req.page.frozen) {
      late.push({ page: req.page, shown: shownBy(req.page) });
      lateAfterLoad++;
    }
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
    // 6, ticket 16b: the draft has the declined paths and branch tracks the page chose.
    if (page.newestTyped !== null && subjectOf(snap.draft) === page.newestTyped && !sameShape(shapeOf(snap.draft), page.shape)) {
      problems.push(`6: ${page.session}'s draft has paths and branch ${JSON.stringify(shapeOf(snap.draft))}, not the chosen ${JSON.stringify(page.shape)}`);
    }
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
      // The record starts from what the page shows when it has typed nothing since loading it.
      const shapeBefore = page.newestTyped === null ? shapeOf(before) : page.shape;
      // Once the draft holds branch work, the generated user mostly carries on with it (ticket 16b), so
      // declined paths and an arranged branch are saved, not replaced at once by a fresh draft.
      const branchWork = branchEdits && before.tracks.some((t) => !t.removed && (t.branch === "win_back" || t.channel === "call"));
      const carryOn = branchEdits && r3() < (branchWork ? 0.75 : 0.2);
      const edit =
        carryOn ? arranged(before, subject, shapeBefore)
        : size < 0.08 ? { definition: definitionWith(subject, pool, 4, 18_000), shape: NO_SHAPE }
        : size < 0.2 ? { definition: definitionWith(subject, pool, 3, Math.floor((DEFINITION_MAX_BYTES - 2_000) / 3)), shape: NO_SHAPE }
        : size < 0.55 ? arranged(before, subject, shapeBefore)
        : { definition: definitionWith(subject, pool), shape: NO_SHAPE };
      const next = edit.definition;
      page.store.update(() => next);
      // Typing is refused once launched and while a launch or a load is in flight: nothing was typed.
      if (page.store.getSnapshot().draft === before && !lockedBefore) problems.push(`6: ${page.session} refused an edit while editing was shown open`);
      if (page.store.getSnapshot().draft !== before) {
        if (lockedBefore) problems.push(`6: ${page.session} took an edit while editing was shown locked`);
        page.newestTyped = subject;
        page.newestSendable = draftProblems(next).length === 0 ? subject : null;
        page.shape = edit.shape;
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
      const req = requests.find((x) => x.answer !== null && !x.page.frozen && !heldBack(x));
      if (req) answer(req, r() < 0.3);
    } else if (roll < 0.73 && live && kindOf(page.store) === "conflict" && page.store.getSnapshot().pending === null) {
      // Invariant 5: until now the refused page still held what was typed.
      if (page.newestTyped !== null && subjectOf(page.store.getSnapshot().draft) !== page.newestTyped) problems.push(`5: ${page.session} lost its draft before loading the stored version`);
      // Loading sets aside what was typed before choosing it, never what was typed after.
      const chosenOver = page.newestTyped;
      // Often the page's saves still out are answered only after the load (council on aebeb80, item 2).
      if (r2() < 0.7) for (const x of requests) if (x.page === page && x.kind === "put") x.heldPastLoads = page.store.loads;
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
    // 6. An answer to a save sent before the user loaded the saved version changes nothing on the page.
    for (const l of late.splice(0)) if (shownBy(l.page) !== l.shown) problems.push(`6: ${l.page.session} changed on a late answer to a save sent before it loaded the saved version`);
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
    const req = requests.find((x) => !heldBack(x)) ?? requests[0];
    if (!req) break;
    if (req.answer === null) await deliver(req);
    answer(req, false);
    await flush();
    for (const l of late.splice(0)) if (shownBy(l.page) !== l.shown) problems.push(`6: ${l.page.session} changed on a late answer to a save sent before it loaded the saved version`);
  }
  await flush();
  for (const p of tabs) check(p, true);

  if (!launchedOnce()) {
    const stored = subjectOf((await h.request<SequenceView>("GET", path)).body.definition);
    const holder = pages.find((p) => p.session === writerNow());
    // Invariant 1: the stored definition is the newest sendable draft of the session that wrote it.
    if (holder?.newestSendable != null && holder.newestSendable === holder.newestTyped && stored !== holder.newestSendable && !holder.store.inConflict) problems.push(`1: stored "${stored}" is not ${holder.session}'s newest "${holder.newestSendable}"`);
    // 1, ticket 16b: the stored declined paths and branch tracks are the ones the writer chose.
    const storedDefinition = (await h.request<SequenceView>("GET", path)).body.definition;
    if (holder?.newestSendable != null && holder.newestSendable === holder.newestTyped && stored === holder.newestSendable && !sameShape(shapeOf(storedDefinition), holder.shape)) {
      problems.push(`1: stored paths and branch ${JSON.stringify(shapeOf(storedDefinition))} are not ${holder.session}'s chosen ${JSON.stringify(holder.shape)}`);
    }
    // Invariant 2's other half: a live page whose newest sendable draft lost to another session shows the conflict.
    for (const p of tabs) {
      if (p.newestSendable !== null && p.newestSendable === p.newestTyped && !accepted.has(`${p.session}/${p.store.edit}`) && writerNow() !== p.session && kindOf(p.store) !== "conflict") {
        problems.push(`2: ${p.session}'s newest "${p.newestSendable}" lost to ${writerNow() ?? "nobody"} with no conflict shown`);
      }
    }
  }
  const stored = (await h.request<SequenceView>("GET", path)).body.definition;
  const smsSaved = stored.tracks.some((t) => !t.removed && t.channel === "sms") && (stored.smsPool ?? []).length > 0;
  return { problems, pending: requests.length, launchedOnce: launchedOnce(), smsSaved, phoneSaved: phoneCoverage.phoneSaved, phoneAny: phoneCoverage.phoneAny, lateAfterLoad, winBackSaved: phoneCoverage.winBackSaved, declinedSaved: phoneCoverage.declinedSaved, branchArranged: phoneCoverage.branchArranged };
}

describe("saving the definition, generated over the real editor state (ADR 0003 1.1.1)", () => {
  // What each coverage seed's run reached; the window's runs are checked for every invariant and counted for nothing.
  const reached: { launched: boolean; smsSaved: boolean; phoneSaved: boolean; lateAfterLoad: number; winBackSaved: boolean; declinedSaved: boolean; branchArranged: boolean }[] = [];
  for (const seed of RUN_SEEDS) {
    test(`run ${seed}`, async () => {
      const out = await run(seed);
      if (COVERAGE_SEEDS.has(seed)) reached.push({ launched: out.launchedOnce, smsSaved: out.smsSaved, phoneSaved: out.phoneSaved, lateAfterLoad: out.lateAfterLoad, winBackSaved: out.winBackSaved, declinedSaved: out.declinedSaved, branchArranged: out.branchArranged });
      expect(out.pending).toBe(0);
      expect(out.problems).toEqual([]);
    });
  }
  const count = (f: (r: (typeof reached)[number]) => boolean) => reached.filter(f).length;
  test.skipIf(!ENOUGH_FOR_COVERAGE)("the runs include launches that start, not only refused ones", () => {
    expect(count((r) => r.launched)).toBeGreaterThan(atLeast(1 / 10));
  });
  test.skipIf(!ENOUGH_FOR_COVERAGE)("the runs answer saves sent before their page loaded the saved version, late (council on aebeb80, item 2)", () => {
    expect(count((r) => r.lateAfterLoad > 0)).toBeGreaterThan(0);
  });
  test.skipIf(!ENOUGH_FOR_COVERAGE)("the runs save arranged SMS tracks with the numbers that connected (ticket 13b)", () => {
    expect(count((r) => r.smsSaved)).toBeGreaterThan(atLeast(1 / 20));
  });
  test.skipIf(!ENOUGH_FOR_COVERAGE)("the runs save phone tracks with their own calling hours and skip limits (ticket 14c)", () => {
    expect(count((r) => r.phoneSaved)).toBeGreaterThan(0);
  });
  test.skipIf(!ENOUGH_FOR_COVERAGE)("the runs save phone tracks with a declined path of win back beside the win-back branch, with stop or continue, and branch tracks arranged after one another (ticket 16b)", () => {
    expect(count((r) => r.winBackSaved)).toBeGreaterThan(atLeast(1 / 20));
    expect(count((r) => r.declinedSaved)).toBeGreaterThan(atLeast(1 / 20));
    expect(count((r) => r.branchArranged)).toBeGreaterThan(atLeast(1 / 40));
  });
  // Each fault in the editor's saving is killed by its recorded fixed seed (ticket 16b).
  for (const fault of Object.keys(FAULT_SEEDS) as SaveFault[]) {
    test(`the fault "${fault}" fails run ${FAULT_SEEDS[fault]}`, async () => {
      const { problems } = await run(FAULT_SEEDS[fault], new Set([fault]));
      expect(problems).not.toEqual([]);
    });
  }
  // Finds each fault's first killing seed among the fixed seeds, to record in FAULT_SEEDS.
  test.skipIf(!process.env["SAVE_QUEUE_FAULT_SEARCH"])("search: the first fixed seed that kills each fault", { timeout: 600_000 }, async () => {
    for (const fault of Object.keys(FAULT_SEEDS) as SaveFault[]) {
      let found: number | null = null;
      for (const seed of FIXED_SEEDS) {
        if ((await run(seed, new Set([fault]))).problems.length > 0) {
          found = seed;
          break;
        }
      }
      console.info(`fault ${fault}: killed by seed ${found ?? "none"}`);
    }
  });
});
