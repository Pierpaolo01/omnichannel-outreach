/**
 * What a write to one lead costs the worker's caches (ADR 0004, "The conversations' version"; the re-check of 8c85b2f,
 * item 1). Four shapes, each a fresh in-memory world: 500 or 2,000 leads, each either with no pair (an email track) or owning
 * an SMS pair (a text sent, a follow-up pending). For each it prints the launch (the launch request and the ticks until every
 * first step went), a quiet tick (nothing due), and a tick after 20 progress writes (an update of 20 leads' track rows, as
 * any progress write is), each with the subjects the tick read. It uses only what the integration tip's harness has too, so
 * the same file runs on the tip and on this branch. Fictitious data only; nothing leaves the machine.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/bench-conversation-caches.ts
 */
import type { DatabaseSync } from "node:sqlite";
import type { CampaignDefinition, TrackDefinition } from "../src/domain/sequence/definition.ts";
import { EngineHarness } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";

const H = 3_600_000;
const START = Date.parse("2026-11-02T09:00:00Z");
/** Enough sender accounts that every first step goes within a few ticks: an account hands over one step per instant. */
const ACCOUNTS = 100;
const INBOXES = Array.from({ length: ACCOUNTS }, (_, i) => `inbox-${i}`);
const NUMBERS = Array.from({ length: ACCOUNTS }, (_, i) => `+4477009${String(20_000 + i).slice(-5)}`);
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

async function shape(leads: number, pairs: boolean): Promise<string> {
  const h = new EngineHarness({
    start: START,
    accounts: INBOXES.map((id) => ({ id, capacity: 10_000, gapMs: 1, k: 10_000, healthy: true, quotaAvailable: true, resetZone: "UTC" })),
    sms: { numbers: NUMBERS.map((id) => ({ id, capacity: 10_000, gapMs: 1, k: 10_000, healthy: true, resetZone: "Europe/London" })) },
  });
  await h.tick();
  const people = Array.from({ length: leads }, (_, i) =>
    person({ person_id: `p${i}`, business_id: "b1", full_name: `Lead${i} Fictional`, email: `lead${i}@fictional.example`, dial_phone: `+4477009${String(10_000 + i).slice(-5)}`, dial_phone_type: "mobile" }),
  );
  const { campaign } = await h.createCampaign("Bench", { businesses: [business({ business_id: "b1", business_name: "Fictional Clinic", phone_e164: "+442079460101" })], people });
  const channel = pairs ? "sms" : "email";
  const track: TrackDefinition = {
    id: "t",
    channel,
    branch: "main",
    window: ALWAYS,
    steps: [
      { id: "t1", waitDays: 0, subject: pairs ? "" : "Hello", body: "A first message.", threading: "new_subject", removed: false },
      { id: "t2", waitDays: 3, subject: pairs ? "" : "Again", body: "A follow-up.", threading: "new_subject", removed: false },
    ],
    start: { kind: "entry" },
    removed: false,
  };
  const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: INBOXES, smsPool: NUMBERS, tracks: [track] };
  await h.defineSequence(campaign.id, definition);

  // Every subject read by a tick, counted on the store.
  const store = h.store.engine as unknown as { subject: (...args: unknown[]) => Promise<unknown> };
  const load = store.subject.bind(store);
  let reads = 0;
  store.subject = (...args: unknown[]) => {
    reads++;
    return load(...args);
  };
  const timed = async (run: () => Promise<void>) => {
    reads = 0;
    const t0 = performance.now();
    await run();
    return { ms: Math.round(performance.now() - t0), reads };
  };

  const sent = () => (pairs ? h.sms.deliveryLog.length : h.fake.deliveryLog.length);
  const launch = await timed(async () => {
    const r = await h.launch(campaign.id);
    if (r.status !== 200) throw new Error(`launch refused: ${JSON.stringify(r.body)}`);
    for (let i = 0; i < 200 && sent() < leads; i++) await h.advanceTo(h.clock + 60_000);
  });
  if (sent() < leads) throw new Error(`only ${sent()} of ${leads} first steps went`);
  await h.advanceTo(h.clock + H);
  await h.tick();
  const quiet = await timed(() => h.tick());
  const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
  const ids = (db.prepare("SELECT subject_id FROM track_progress ORDER BY subject_id LIMIT 20").all() as { subject_id: string }[]).map((r) => r.subject_id);
  for (const id of ids) db.prepare("UPDATE track_progress SET due_zone = due_zone WHERE subject_id = ?").run(id);
  const written = await timed(() => h.tick());
  await h.store.close();
  return `| ${leads} | ${pairs ? "an SMS pair each" : "none"} | ${launch.ms} | ${quiet.ms} (${quiet.reads} read) | ${written.ms} (${written.reads} read) |`;
}

console.info("| Leads | Pairs | Launch, ms | Quiet tick, ms (subjects read) | Tick after 20 progress writes, ms (subjects read) |");
console.info("| - | - | - | - | - |");
// BENCH_LEADS narrows the sizes for a trial run ("50"); by default the four shapes the re-check measured.
const sizes = (process.env["BENCH_LEADS"] ?? "500,2000").split(",").map(Number);
for (const leads of sizes) for (const pairs of [false, true]) console.info(await shape(leads, pairs));
