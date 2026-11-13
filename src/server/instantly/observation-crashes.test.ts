import { describe, expect, test } from "vitest";
import { FakeInstantly } from "../../../test/support/fake-instantly.ts";
import type { HandoverRequest, ProviderEvent } from "../engine/ports.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import { InstantlyClient } from "./client.ts";
import { InstantlyEmailPort } from "./port.ts";

/**
 * Generated runs of the adapter's poller with the process dying at points inside observation, an
 * engine that dies between receiving a batch and storing its checkpoint, and provider outages that
 * fail polls in the same process (council on `387a19b`, items 1 and 4; the verifier's follow-up;
 * review bot on `c942fd2`). Each seed draws a sequence of provider happenings and
 * polls; an independent record, kept by the test from what it told the fake to do, says which
 * replies and unsubscribes must reach the engine and which mail must never. Small pages make every
 * scan span several polls. Runs are bounded by a count of steps, not by time. Fictitious data.
 */

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-16T10:00:00Z");
const SEEDS = Array.from({ length: 40 }, (_, i) => 20261300 + i);
const STEPS = 30;

class Crash extends Error {}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEADS = ["pat@harbour.example", "nia@harbour.example", "sam@harbour.example"];
const INBOX = "ada@sender.example";

async function run(seed: number): Promise<{ missing: string[]; unexpected: string[]; violations: string[] }> {
  const rnd = random(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  let clock = T0;
  const now = () => clock;
  const fake = new FakeInstantly({ now, accounts: [{ email: INBOX, status: 1, daily_limit: 30 }] });
  const store = openSqliteStore(":memory:");
  const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: true, now, timeoutMs: 10_000 });
  let crashAt: { point: string; after: number } | null = null;
  const build = () =>
    new InstantlyEmailPort({
      client,
      store: store.instantly,
      now,
      config: { resetZone: "UTC", pollIntervalMs: 0, pageSize: 2, pagesPerPoll: 2, freshnessMs: 365 * 24 * 60 * MINUTE },
      subjectCampaign: () => Promise.resolve({ kind: "enrollment", campaignId: "camp-1" }),
      crashPoint: (point) => {
        if (crashAt?.point !== point) return;
        if (crashAt.after-- > 0) return;
        crashAt = null;
        throw new Crash(point);
      },
    });
  let port = build();
  const advance = (ms: number) => {
    clock += ms;
    fake.advance();
  };

  // The independent record.
  const mustReach = new Set<string>();
  const mustNotReach = new Set<string>();
  const foreignThreads = new Set<string>();
  const foreignCampaigns = new Set<string>();
  const refs = new Map<string, string>();
  // The engine: it applies a batch, then stores its checkpoint; it may die in between.
  let stored: string | null = null;
  const applied = new Map<string, ProviderEvent>();
  const violations: string[] = [];
  // The independent clock of observed time: gaps between two polls in a row that both succeeded in one process.
  const created = new Map<string, number>();
  const observed = new Map<string, number>();
  let chainLast: number | null = null;
  const breakChain = () => {
    chainLast = null;
  };
  const engineObserve = async (dieBeforeStoring: boolean) => {
    try {
      const r = await port.observe(stored);
      if (chainLast !== null) {
        const last = chainLast;
        for (const [id, at] of created) observed.set(id, (observed.get(id) ?? 0) + Math.max(0, clock - Math.max(last, at)));
      }
      chainLast = clock;
      const upTo = dieBeforeStoring ? Math.floor(rnd() * (r.events.length + 1)) : r.events.length;
      for (const e of r.events.slice(0, upTo)) {
        applied.set(e.id, e);
        if (e.kind === "reply") {
          const lead = LEADS.includes(e.from) ? e.from : null;
          if (!lead || e.inbox !== INBOX) violations.push(`reply ${e.id} from ${e.from} reached the engine`);
          if (e.providerRef !== null && e.providerRef !== refs.get(e.from)) violations.push(`reply ${e.id} names ${e.providerRef}, not ${e.from}'s work`);
          // A fallback with no reference only after the settling period of observed time.
          if (e.providerRef === null && e.id.startsWith("reply:") && (observed.get(e.id) ?? 0) < 15 * MINUTE) violations.push(`reply ${e.id} fell back after ${String((observed.get(e.id) ?? 0) / MINUTE)} observed minutes`);
        }
        if (mustNotReach.has(e.id)) violations.push(`${e.id} must never reach the engine`);
      }
      if (!dieBeforeStoring) stored = r.checkpoint;
      else {
        port = build();
        breakChain();
      }
    } catch (error) {
      breakChain();
      // A crash restarts the process; a provider outage only fails the poll.
      if (error instanceof Crash) port = build();
      else if (outage === 0) throw error;
    }
    if (outage > 0 && --outage === 0) fake.failWith = null;
  };
  let outage = 0;

  await port.observe(null).then((r) => (stored = r.checkpoint));
  let n = 0;
  const lost = new Set<string>();
  for (const lead of LEADS) {
    n++;
    const request: HandoverRequest = {
      attemptId: `att-${String(n)}`,
      idempotencyKey: `key-${lead}`,
      sender: INBOX,
      destination: lead,
      rendered: { subject: "Hello", body: "A note." },
      threadRef: null,
      threading: "new_subject",
      subjectId: `enr-${lead}`,
      trackId: "t1",
      stepId: "s1",
    };
    fake.loseAddResponses = rnd() < 0.3;
    const answer = await port.handover(request);
    fake.loseAddResponses = false;
    if (answer.kind === "accepted") refs.set(lead, answer.providerRef);
    else lost.add(lead);
  }
  advance(2 * MINUTE);

  for (let step = 0; step < STEPS; step++) {
    const action = rnd();
    if (action < 0.2) {
      const lead = pick(LEADS);
      const email = fake.reply(lead, { onThread: rnd() < 0.7, withLead: rnd() < 0.5 });
      // The fake answers the latest campaign email the lead received, which may be another campaign's.
      const foreign = (email.thread_id !== null && foreignThreads.has(email.thread_id)) || (email.campaign_id !== null && foreignCampaigns.has(email.campaign_id));
      (foreign ? mustNotReach : mustReach).add(`reply:${email.id}`);
      created.set(`reply:${email.id}`, clock);
    } else if (action < 0.35) {
      for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) mustNotReach.add(`reply:${fake.receive({ from_address_email: `stranger-${String(step)}-${String(i)}@else.example`, eaccount: INBOX }).id}`);
    } else if (action < 0.42) {
      const lead = pick(LEADS);
      const foreign = fake.foreignSend(lead, INBOX);
      if (foreign.thread_id !== null) foreignThreads.add(foreign.thread_id);
      if (foreign.campaign_id !== null) foreignCampaigns.add(foreign.campaign_id);
      advance(MINUTE);
      mustNotReach.add(`reply:${fake.receive({ from_address_email: lead, eaccount: INBOX, thread_id: foreign.thread_id, ...(rnd() < 0.5 ? { campaign_id: foreign.campaign_id, lead_id: foreign.lead_id, lead } : {}) }).id}`);
    } else if (action < 0.5) {
      const lead = pick(LEADS.filter((l) => !lost.has(l)));
      if (lead) {
        fake.setLeadStatus(lead, -2);
        const id = fake.leads.find((l) => l.email === lead && !l.deleted)?.id;
        if (id) mustReach.add(`unsubscribed:${id}`);
      }
    } else if (action < 0.55) {
      // The provider fails every request for the next few polls.
      fake.failWith = 500;
      outage = 2 + Math.floor(rnd() * 14);
    } else if (action < 0.62) {
      crashAt = { point: pick(["observe:page", "observe:before_commit", "observe:after_commit"]), after: Math.floor(rnd() * 3) };
      await engineObserve(false);
      crashAt = null;
    } else if (action < 0.7) {
      await engineObserve(true);
    } else {
      await engineObserve(false);
    }
    advance((1 + Math.floor(rnd() * 3)) * MINUTE);
  }
  // Quiet: clean polls once a minute until everything has had its settling period in observed time.
  for (let i = 0; i < 80; i++) {
    await engineObserve(false);
    advance(MINUTE);
  }
  const missing = [...mustReach].filter((id) => !applied.has(id));
  const unexpected = [...applied.keys()].filter((id) => id.startsWith("reply:") && !mustReach.has(id));
  await store.close();
  return { missing, unexpected, violations };
}

describe("generated observation runs with crashes inside the poll", () => {
  for (const seed of SEEDS) {
    test(`seed ${String(seed)}: every reply and unsubscribe reaches the engine, nothing else does, and every reference is its own work's`, async () => {
      expect(await run(seed)).toEqual({ missing: [], unexpected: [], violations: [] });
    });
  }
});
