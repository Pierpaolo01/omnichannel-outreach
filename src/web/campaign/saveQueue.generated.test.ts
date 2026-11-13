import { describe, expect, test } from "vitest";
import { testApi } from "../../../test/support/http.ts";
import type { ApiError, CampaignDefinition, SequenceView } from "../../shared/api.ts";
import { DEFINITION_MAX_BYTES } from "../../shared/limits.ts";
import { NoAnswer, SaveQueue, draftProblems, type SaveStatus } from "./saveQueue.ts";

/**
 * The saving rule of ADR 0003 1.1.1, generated: the real client queue against the real HTTP app.
 * Two tabs edit one campaign. Each run mixes edits (some near or over the size bound), debounced
 * saves, requests delivered late and out of order, lost answers and the queue's own retries,
 * leaving a tab (kept for Back, or gone with a new page and session loaded), restores, loading the
 * stored version after a conflict, and finally a launch. Requests are never lost; answers may be.
 *
 * Invariants, once the network settles (3 also after every step):
 * 1. The stored definition is the newest draft typed in the session that wrote it, when that draft
 *    can be sent; one over the size bound is refused in place and the page says so.
 * 2. No session's accepted save is replaced by another session's save unless that session had
 *    seen it (its base was the stored revision); a refused page shows the conflict.
 * 3. A page's status is never "Saving…" or "Not saved" when the server has accepted its newest
 *    draft, and never "Saved" when it has not. (Another tab may later replace it, having seen it,
 *    under invariant 2; a page is not told of that until it saves again.)
 * 4. Launch never starts a definition other than the one on the page.
 * 5. A refused page keeps what the user typed until they load the stored version.
 *
 * Mutations that make it fail, each checked by hand when this was written:
 * - the server accepting a save whatever its base (sqlite-engine-store.ts: drop the base and
 *   session condition): invariant 2;
 * - the server treating a repeat of the same session and number as a conflict: invariant 3;
 * - a leave-save that does not report into the queue, with restore doing nothing: invariant 3.
 */
const SEEDS = Number(process.env["SAVE_QUEUE_SEEDS"] ?? 60);

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
const definitionWith = (subject: string, emails = 0, bodyLength = 0): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [{ day: 1, start: 9, end: 17 }],
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
/** Read through a function: callbacks change a page's status, which the checker cannot see. */
const statusOf = (p: { status: SaveStatus }): SaveStatus["kind"] => p.status.kind;

interface Page {
  readonly session: string;
  readonly queue: SaveQueue;
  draft: CampaignDefinition;
  /** The revision the page last had from the server. */
  version: number;
  status: SaveStatus;
  frozen: boolean;
  gone: boolean;
  debouncing: boolean;
  /** The newest draft typed here, if it can be sent (within the size bound); null once one that cannot is typed. */
  newestSendable: string | null;
  /** The newest draft typed here, sendable or not. */
  newestTyped: string | null;
  /** The number of the newest edit made here. */
  seq: number;
}

interface Request {
  readonly page: Page;
  readonly body: { save?: { session: string; seq: number; base: number } } & Record<string, unknown>;
  readonly keepalive: boolean;
  answer: { status: number; json: unknown } | null;
  readonly resolve: (view: SequenceView) => void;
  readonly reject: (error: Error) => void;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function run(seed: number) {
  const r = rng(seed);
  const api = testApi();
  const campaign = await api.createCampaign("Generated", "Europe/London");
  const path = `/api/campaigns/${campaign.id}/sequence`;
  const problems: string[] = [];
  // The server's history of accepted saves, as seen from outside: who wrote, from which base.
  // Held in an object: closures assign them, which a plain variable would hide from the checker.
  const server = { writer: null as string | null, version: 0 };
  const writerNow = (): string | null => server.writer;
  /** Every save the server accepted, as session/number. */
  const accepted = new Set<string>();
  const putRaw = async (body: Request["body"]) => {
    const res = await api.raw(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as unknown;
    if (res.status === 200) {
      const view = json as SequenceView;
      if (body.save) accepted.add(`${body.save.session}/${body.save.seq}`);
      if (view.definitionVersion > server.version) {
        const session = body.save?.session ?? null;
        // Invariant 2: another session replaces a save only if it had seen it.
        if (server.writer !== null && session !== server.writer && body.save?.base !== server.version) problems.push(`2: ${session} replaced ${server.writer}'s revision ${server.version} from base ${body.save?.base}`);
        server.writer = session;
        server.version = view.definitionVersion;
      }
    }
    return { status: res.status, json };
  };
  expect((await putRaw({ ...definitionWith("start") })).status).toBe(200);
  server.writer = null;

  let typed = 0;
  const requests: Request[] = [];
  const pages: Page[] = [];

  const openPage = async (): Promise<Page> => {
    const view = (await api.get<SequenceView>(path)).body;
    const session = `s${pages.length}`;
    const page = {
      session,
      draft: view.definition,
      version: view.definitionVersion,
      status: { kind: "idle" },
      frozen: false,
      gone: false,
      debouncing: false,
      newestSendable: null,
      newestTyped: null,
      seq: 0,
    } as Omit<Page, "queue"> as Page;
    (page as { queue: SaveQueue }).queue = new SaveQueue({
      session,
      read: () => ({ draft: page.draft, accountIds: [], version: page.version }),
      put: (definition, options, save) =>
        new Promise<SequenceView>((resolve, reject) => {
          requests.push({ page, body: { ...definition, save }, keepalive: options.keepalive === true, answer: null, resolve, reject });
        }),
      onStatus: (s) => {
        if (!page.gone) page.status = s;
      },
      onAccepted: (v) => {
        page.version = v.definitionVersion;
      },
    });
    pages.push(page);
    return page;
  };

  const answer = (req: Request, lost: boolean) => {
    requests.splice(requests.indexOf(req), 1);
    if (req.page.gone) return;
    if (lost || !req.answer) return req.reject(new NoAnswer());
    if (req.answer.status === 200) return req.resolve(req.answer.json as SequenceView);
    const error = (req.answer.json as ApiError).error;
    req.reject(Object.assign(new Error(error.message), { code: error.code }));
  };

  const loadStored = async (page: Page) => {
    const view = (await api.get<SequenceView>(path)).body;
    page.draft = view.definition;
    page.version = view.definitionVersion;
    page.newestSendable = null;
    page.newestTyped = null;
    page.queue.loadedStored();
  };

  const stored = async () => subjectOf((await api.get<SequenceView>(path)).body.definition);
  const checkStatus = (page: Page, settled: boolean) => {
    if (page.gone || page.frozen || page.newestTyped === null) return;
    const newestAccepted = accepted.has(`${page.session}/${page.seq}`);
    // Invariant 3.
    if (newestAccepted && (page.status.kind === "error" || page.status.kind === "conflict" || (settled && page.status.kind === "saving"))) problems.push(`3: ${page.session} shows ${page.status.kind} though its newest draft was accepted`);
    if (!newestAccepted && page.status.kind === "saved") problems.push(`3: ${page.session} shows saved though "${page.newestTyped}" was not accepted`);
  };

  const tabs = [await openPage(), await openPage()];
  for (let step = 0; step < 50; step++) {
    const roll = r();
    const t = Math.floor(r() * 2);
    const page = tabs[t]!;
    const live = !page.frozen;
    if (roll < 0.25 && live) {
      const size = r();
      // Most drafts are small; some are near the size bound (each email within the server's
      // 20,000 characters), a few beyond it.
      const subject = `typed ${++typed}`;
      page.draft = size < 0.08 ? definitionWith(subject, 4, 18_000) : size < 0.2 ? definitionWith(subject, 3, Math.floor((DEFINITION_MAX_BYTES - 2_000) / 3)) : definitionWith(subject);
      page.newestTyped = subject;
      // Only the draft on the page can be sent: one over the bound replaces the last sendable one.
      page.newestSendable = draftProblems(page.draft).length === 0 ? subject : null;
      page.queue.edited();
      page.seq++;
      if (!page.queue.inConflict) page.status = { kind: "saving" };
      page.debouncing = true;
    } else if (roll < 0.38 && live && page.debouncing) {
      page.debouncing = false;
      void page.queue.save();
    } else if (roll < 0.56) {
      const pending = requests.filter((x) => x.answer === null);
      const req = pending[Math.floor(r() * pending.length)];
      if (req) req.answer = await putRaw(req.body);
    } else if (roll < 0.72) {
      const req = requests.find((x) => x.answer !== null && !x.page.frozen);
      if (req) answer(req, r() < 0.3);
    } else if (roll < 0.78 && live && page.status.kind === "conflict") {
      // Invariant 5: until now the refused page still held what was typed.
      if (page.newestTyped !== null && subjectOf(page.draft) !== page.newestTyped) problems.push(`5: ${page.session} lost its draft before loading the stored version`);
      await loadStored(page);
    } else if (roll < 0.85 && live) {
      page.queue.sendNow();
      page.debouncing = false;
      page.frozen = true;
    } else if (roll < 0.91 && page.frozen) {
      page.frozen = false;
      void page.queue.restored();
    } else if (roll < 0.95) {
      if (!page.frozen) page.queue.sendNow();
      page.gone = true;
      for (const req of [...requests]) if (req.page === page && !req.keepalive && req.answer === null && r() < 0.5) requests.splice(requests.indexOf(req), 1);
      tabs[t] = await openPage();
    }
    await flush();
    for (const p of tabs) checkStatus(p, false);
  }

  // The network settles: both tabs are live, pending saves fire, every request arrives and is answered.
  for (const page of tabs) {
    if (page.frozen) {
      page.frozen = false;
      void page.queue.restored();
    }
    if (page.debouncing) void page.queue.save();
  }
  for (let guard = 0; guard < 1_000; guard++) {
    await flush();
    const req = requests[0];
    if (!req) break;
    if (req.answer === null) req.answer = await putRaw(req.body);
    answer(req, false);
  }
  await flush();
  for (const p of tabs) checkStatus(p, true);

  // Invariant 1: the stored definition is the newest sendable draft of the session that wrote it.
  const holder = pages.find((p) => p.session === writerNow());
  if (holder?.newestSendable != null && (await stored()) !== holder.newestSendable && !holder.queue.inConflict) problems.push(`1: stored "${await stored()}" is not ${holder.session}'s newest "${holder.newestSendable}"`);
  // Invariant 2's other half: a live page whose newest sendable draft lost to another session shows the conflict.
  for (const p of tabs) {
    if (p.newestSendable !== null && p.newestSendable === p.newestTyped && !accepted.has(`${p.session}/${p.seq}`) && writerNow() !== p.session && statusOf(p) !== "conflict") {
      problems.push(`2: ${p.session}'s newest "${p.newestSendable}" lost to ${writerNow() ?? "nobody"} with no conflict shown`);
    }
  }

  // Invariant 4: a launch from a tab starts exactly what that tab shows, or nothing.
  const launcher = tabs[Math.floor(r() * 2)]!;
  const launchSave: { outcome: Awaited<ReturnType<SaveQueue["save"]>> | null } = { outcome: null };
  void launcher.queue.save().then((o) => (launchSave.outcome = o));
  for (let guard = 0; guard < 1_000 && launchSave.outcome === null; guard++) {
    await flush();
    const req = requests[0];
    if (!req) continue;
    if (req.answer === null) req.answer = await putRaw(req.body);
    answer(req, false);
  }
  const saved = launchSave.outcome;
  if (!saved) problems.push("the launch's save never settled");
  if (saved?.ok) {
    const launched = await api.post<SequenceView | ApiError>(`/api/campaigns/${campaign.id}/launch`, { definitionVersion: launcher.version });
    const started = (await api.get<SequenceView>(path)).body;
    if (launched.status === 200 && JSON.stringify(started.definition.tracks) !== JSON.stringify(launcher.draft.tracks)) problems.push("4: launch started a definition other than the page's");
  }
  return { problems, pending: requests.length };
}

describe("saving the definition, generated (ADR 0003 1.1.1)", () => {
  for (const seed of Array.from({ length: SEEDS }, (_, i) => 7000 + i)) {
    test(`run ${seed}`, async () => {
      const out = await run(seed);
      expect(out.pending).toBe(0);
      expect(out.problems).toEqual([]);
    });
  }
});
