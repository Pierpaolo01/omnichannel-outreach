import type { DatabaseSync } from "node:sqlite";
import { enterMain, end, evaluate } from "../../src/domain/sequence/progress.ts";
import type { CallDay, SubjectState } from "../../src/domain/sequence/state.ts";
import { startOfLocalDay } from "../../src/domain/sequence/clock.ts";
import { DEFAULT_RULES } from "../../src/server/engine/rules.ts";
import type { TestRunOptions } from "./generated-test-runs.ts";

/**
 * Deliberately broken test runs (ADR 0003 "Ticket 21"): each swaps one rule of the engine, or patches the store, so that
 * one invariant of the ticket breaks. The generated test runs (generated-test-runs.ts) must fail the invariant it names
 * on its recorded seed in `pnpm check`, and in the search on its seed or one of the first offsets. Seeds are offsets
 * from TEST_RUN_SEED.
 */

const R = DEFAULT_RULES;
const isTest = (s: SubjectState) => s.subject.kind === "test_run";
/** A test run's state as a lead's: the mutation that makes a test wait in days uses it for evaluation only. */
const asLead = (s: SubjectState): SubjectState => ({ ...s, subject: { ...s.subject, kind: "enrollment" }, campaign: { ...s.campaign, launchedAt: s.campaign.launchedAt ?? 0, pausedSince: null } });
const asTest = (s: SubjectState, was: SubjectState): SubjectState => ({ ...s, subject: { ...s.subject, kind: was.subject.kind }, campaign: was.campaign });

export interface TestRunMutation extends TestRunOptions {
  readonly invariant: string;
  readonly seed: number;
}

export const TEST_RUN_MUTATIONS: Readonly<Record<string, TestRunMutation>> = {
  "a test is exempt from pacing": {
    invariant: "T4",
    seed: 0,
    // A test's send neither waits for the account's pacing slot nor takes it, at the handover or after its call.
    patch: (h) => {
      const store = h.store.engine;
      const push = store.pushSlot.bind(store);
      store.pushSlot = (accountId, callStart) => {
        const last = [...h.fake.handoverLog, ...h.sms.handoverLog].filter((x) => x.sender === accountId).sort((x, y) => x.at - y.at).at(-1);
        return last?.subjectId.startsWith("test-") ? Promise.resolve() : push(accountId, callStart);
      };
    },
    rules: {
      handoverFailures: (s, a, account, now) => R.handoverFailures(s, a, account, now).filter((f) => !isTest(s) || f !== 16),
      handOver: (s, a, account, now) => {
        const out = R.handOver(s, a, account, now);
        return isTest(s) ? { ...out, accounts: { ...out.accounts, [account.id]: { ...(out.accounts[account.id] ?? account), nextSlotAt: account.nextSlotAt } } } : out;
      },
    },
  },
  "a test's sends are not counted against capacity": {
    invariant: "T4",
    seed: 7,
    rules: { chooseAccount: (s, now, stepId) => R.chooseAccount(isTest(s) ? { ...s, accounts: Object.fromEntries(Object.entries(s.accounts).map(([id, a]) => [id, { ...a, used: 0 }])) } : s, now, stepId) },
  },
  "a test sends to the lead it renders as": {
    invariant: "T1",
    seed: 2,
    patch: (_h, world) => {
      mutated.toLeadEmail = world.leadEmails[0] ?? null;
    },
    rules: {
      claim: (s, item, account, input) => {
        const out = R.claim(s, item, account, input);
        if (!isTest(s) || mutated.toLeadEmail === null) return out;
        return { ...out, attempts: out.attempts.map((a) => (a.id === input.attemptId && a.destination.includes("@") ? { ...a, destination: mutated.toLeadEmail ?? a.destination } : a)) };
      },
    },
  },
  "a test reply also stops the lead it renders as": {
    invariant: "T2",
    seed: 2,
    patch: (h, world) => {
      const store = h.store.engine;
      const update = store.update.bind(store);
      store.update = async (id, now, decide) => {
        const out = await update(id, now, decide);
        const lead = world.renderAsOf(id);
        if (out?.subject.ended === "replied" && lead !== null) await update(lead, now, (s) => (s.subject.ended === null ? end(s, "replied", now) : null));
        return out;
      };
    },
  },
  "a test waits whole days": {
    invariant: "T6",
    seed: 7,
    rules: {
      evaluate: (s, now) => (isTest(s) ? asTest(evaluate(asLead(s), now), s) : evaluate(s, now)),
      enterMain: (s, now) => (isTest(s) ? asTest(enterMain(asLead(s), now), s) : enterMain(s, now)),
    },
  },
  "the warning reads any test ever, not since the last edit": {
    invariant: "T5",
    seed: 2,
    patch: (h) => {
      const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
      h.store.engine.noTestSinceEdit = (campaignId) => Promise.resolve(db.prepare("SELECT 1 FROM test_runs WHERE campaign_id = ?").get(campaignId) === undefined);
    },
  },
  "a test-run binding is never released": {
    invariant: "T9",
    seed: 0,
    patch: (h) => {
      const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
      db.exec("CREATE TRIGGER keep_test_bindings BEFORE UPDATE OF released_at ON sms_bindings WHEN NEW.owner_subject LIKE 'test-%' BEGIN SELECT RAISE(IGNORE); END;");
    },
  },
  // Review bot on 55d6ac6: the committed-calls count leaves out a test's call carried into a day that starts while its
  // campaign is paused, though the list shows it (a test run is not held by the campaign pause).
  "a paused campaign's carried test calls take no capacity": {
    invariant: "T10",
    seed: 1,
    patch: (h) => {
      const store = h.store.engine as unknown as { callDayAt: (now: number) => CallDay; db: DatabaseSync };
      const counted = store.callDayAt.bind(store);
      store.callDayAt = (now) => {
        const day = counted(now);
        const start = startOfLocalDay(day.day, day.userZone);
        if ([0, 6].includes(new Date(start + 12 * 3_600_000).getUTCDay())) return day;
        const left = Number(
          store.db
            .prepare(
              `SELECT COUNT(*) AS n FROM call_tasks t JOIN test_runs r ON r.id = t.subject_id
               WHERE t.placed_wall < :start AND (t.closed_wall IS NULL OR t.closed_wall > :start) AND (r.ended_wall IS NULL OR r.ended_wall >= :start)
                 AND EXISTS (SELECT 1 FROM hold_intervals hi WHERE hi.scope = 'campaign' AND hi.owner_id = r.campaign_id AND hi.from_wall <= :start AND (hi.to_wall IS NULL OR hi.to_wall > :start))`,
            )
            .get({ start })?.["n"] ?? 0,
        );
        return { ...day, committed: Math.max(0, day.committed - left) };
      };
    },
  },
  "an edit leaves the test running": {
    invariant: "T7",
    seed: 2,
    rules: { stopTestOnEdit: (s) => s },
  },
  // Question Q7 answered (council on bebdc06, item 2): the version guard without the SMS conversations, so an evaluation
  // made while another test owned the conversation is stored after that test released it.
  "a skip is stored without re-checking the bindings": {
    invariant: "T11",
    seed: 25,
    rules: {
      versionsMatch: (a, b) =>
        a.subject.version === b.subject.version && a.campaign.version === b.campaign.version && a.campaign.definitionVersion === b.campaign.definitionVersion && JSON.stringify(a.lead) === JSON.stringify(b.lead),
    },
  },
};

/** State a mutation keeps between its patch and its rules, reset for every run by its patch. */
const mutated: { toLeadEmail: string | null } = { toLeadEmail: null };
