/**
 * A scripted run of the sequence engine through the Instantly adapter (ticket 12c) against the fake
 * Instantly service, through the real HTTP app and an in-memory SQLite store. The fake answers
 * with the documented API shapes only; this is not provider proof (ADR 0002 X1 to X9 are
 * unverified). Fictitious data only; nothing reaches a real provider.
 *
 *   node --import ./src/server/quiet-sqlite-warning.ts scripts/scenario-instantly-adapter.ts
 */
import type { CampaignDefinition } from "../src/domain/sequence/definition.ts";
import { InstantlyClient } from "../src/server/instantly/client.ts";
import { InstantlyEmailPort } from "../src/server/instantly/port.ts";
import type { EmailProviderStatus, EnrollmentProgress, LeadSearchResult } from "../src/shared/api.ts";
import { EngineHarness, type Provider } from "../test/support/engine-harness.ts";
import { business, person } from "../test/support/export-builder.ts";
import { FakeInstantly } from "../test/support/fake-instantly.ts";

const H = 3_600_000;
const DAY = 24 * H;
const start = Date.parse("2026-11-16T08:00:00Z"); // Monday, London
const at = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const log = (line: string) => console.info(line);

const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["ada@sender.example"],
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
      steps: [
        { id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject", removed: false },
        { id: "s2", waitDays: 2, subject: "", body: "Following up, {{first_name|there}}.", threading: "continue_thread", removed: false },
      ],
      start: { kind: "entry" },
      removed: false,
    },
  ],
};

async function run(writes: boolean): Promise<void> {
  const built: { fake?: FakeInstantly } = {};
  const h = new EngineHarness({
    start,
    accounts: [],
    port: (store, now) => {
      const fake = new FakeInstantly({ now, accounts: [{ email: "ada@sender.example", status: 1, daily_limit: 30 }] });
      built.fake = fake;
      const client = new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes, now, timeoutMs: 1_000 });
      // The script's clock jumps between events with no poll in between, so freshness is long here.
      const port = new InstantlyEmailPort({ client, store: store.instantly, now, config: { resetZone: "UTC", pollIntervalMs: 0, freshnessMs: 30 * DAY } });
      return Object.assign(port, { advance: () => fake.advance(), nextActivityAt: () => fake.nextActivityAt() }) satisfies Provider;
    },
  });
  const fake = built.fake;
  if (!fake) throw new Error("no fake");
  fake.bouncing.add("sam@harbour.example");
  log(`=== Writes ${writes ? "ON (fake service only)" : "OFF (the default)"} ===`);
  const { campaign } = await h.createCampaign("Scenario: autumn physio", {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
    people: [
      person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
      person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
      person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
    ],
  });
  await h.tick();
  await h.tick();
  const view = await h.defineSequence(campaign.id, definition);
  log(`Sender inboxes from Instantly: ${view.accounts.map((a) => `${a.id} healthy=${String(a.healthy)} capacity=${a.capacity}`).join("; ")}`);
  log(`Launch blockers: ${view.launch.blockers.length === 0 ? "none" : view.launch.blockers.map((b) => b.message).join("; ")}`);

  h.clock = Date.parse("2026-11-16T09:00:00Z");
  await h.tick();
  const launched = await h.launch(campaign.id);
  log(`${at(h.clock)}  launch -> HTTP ${launched.status}`);
  const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const enrollment = (name: string) => leads.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
  const names = ["Pat Oneil", "Nia Cole", "Sam Lee"];

  if (writes) {
    await h.advanceTo(Date.parse("2026-11-16T12:00:00Z"));
    log(`${at(h.clock)}  Nia replies in her thread`);
    fake.reply("Nia Cole <nia@harbour.example>");
  }
  await h.advanceTo(start + 7 * DAY);

  log("Requests the fake Instantly service received, by endpoint:");
  const byEndpoint = new Map<string, number>();
  for (const r of fake.requests) byEndpoint.set(`${r.method} ${r.path.replace(/camp-\d+/, "{id}").replace(/lead-\d+/, "{id}")}`, (byEndpoint.get(`${r.method} ${r.path.replace(/camp-\d+/, "{id}").replace(/lead-\d+/, "{id}")}`) ?? 0) + 1);
  for (const [k, v] of [...byEndpoint].sort()) log(`  ${String(v).padStart(4)}  ${k}`);
  log(`Writes received: ${fake.writes().length}`);
  log(`Dispatch campaigns: ${fake.campaigns.map((c) => `${c.name.replace(campaign.id, "<campaign>")} status=${c.status} stop_on_reply=${String(c.settings.stop_on_reply)} stop_for_company=${String(c.settings.stop_for_company)} unsubscribe_header=${String(c.settings.insert_unsubscribe_header)} tracking=${String(c.settings.open_tracking || c.settings.link_tracking)}`).join("; ") || "none"}`);
  log("Delivered by the fake (what it actually sent):");
  for (const d of fake.deliveries()) log(`  ${at(d.at)}  to ${d.to} from ${d.inbox}  "${d.subject}" / "${d.body}"`);
  if (fake.deliveries().length === 0) log("  nothing");
  log("Final state per lead:");
  for (const name of names) {
    const p = (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${enrollment(name)}`)).body;
    const track = p.tracks[0];
    log(`  ${name.padEnd(10)} status=${p.status}; ${track ? track.steps.map((s) => `${s.stepId}:${s.result ?? "-"}`).join(" ") : "no track"}; next=${track?.nextStep?.stepId ?? "-"}`);
  }
  const status = (await h.request<EmailProviderStatus>("GET", "/api/email-provider")).body;
  log(`GET /api/email-provider: sending=${status.sending} followUps=${status.followUps} inboxes=${status.inboxes.map((i) => `${i.id}:${i.reason ?? "ok"}`).join(",")} waitingFollowUps=${status.waitingFollowUps.map((w) => `${names.find((n) => enrollment(n) === w.enrollmentId) ?? w.enrollmentId}/${w.stepId}`).join(",") || "none"}`);
  log("");
  await h.store.close();
}

await run(false);
await run(true);
