import type { DatabaseSync } from "node:sqlite";
import { enterMain, end, evaluate } from "../../src/domain/sequence/progress.ts";
import type { SubjectState } from "../../src/domain/sequence/state.ts";
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
  "an edit leaves the test running": {
    invariant: "T7",
    seed: 2,
    rules: { stopTestOnEdit: (s) => s },
  },
};

/** State a mutation keeps between its patch and its rules, reset for every run by its patch. */
const mutated: { toLeadEmail: string | null } = { toLeadEmail: null };
