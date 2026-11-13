import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeInstantly } from "../../../test/support/fake-instantly.ts";
import type { HandoverRequest } from "../engine/ports.ts";
import { openSqliteStore } from "../persistence/sqlite-store.ts";
import type { OutreachStore } from "../persistence/store.ts";
import { InstantlyClient } from "./client.ts";
import { InstantlyEmailPort } from "./port.ts";

/**
 * Two application processes on one SQLite file (the verifier's B7 on `c66a0c8`): each has its own
 * store connection and adapter, so the adapter's single-flight cannot serialize them. Only the
 * database can. Fictitious data; the fake Instantly service is shared, as the real one would be.
 */

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-16T10:00:00Z");
let dir: string | null = null;
const stores: OutreachStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const flush = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("two processes on one database", () => {
  test("B7: both create a dispatch campaign at once; one id is adopted, the same-key adds are identical, and the lead's unsubscribe is seen", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "oo-two-processes-"));
    const file = path.join(dir, "outreach.sqlite");
    let clock = T0;
    const now = () => clock;
    const fake = new FakeInstantly({ now, accounts: [{ email: "ada@sender.example", status: 1, daily_limit: 30 }] });
    const first = openSqliteStore(file);
    const second = openSqliteStore(file);
    stores.push(first, second);
    const port = (store: OutreachStore) =>
      new InstantlyEmailPort({
        client: new InstantlyClient({ apiKey: "test-key-not-real", fetch: fake.fetch, writes: true, now, timeoutMs: 10_000 }),
        store: store.instantly,
        now,
        config: { resetZone: "UTC", pollIntervalMs: 0 },
        subjectCampaign: () => Promise.resolve({ kind: "enrollment", campaignId: "camp-1" }),
      });
    const a = port(first);
    const b = port(second);
    await a.observe(null);
    await b.observe(null);
    // The second process reads the dispatch record as it stood before the first saved its id, once:
    // a legal interleaving of two connections, which nothing in the second process can see.
    const read = second.instantly.dispatchCampaign.bind(second.instantly);
    let reads = 0;
    second.instantly.dispatchCampaign = (key) => {
      const record = read(key);
      reads++;
      return reads === 2 && record ? { ...record, instantlyId: null, timestampUpdated: null } : record;
    };
    const request: HandoverRequest = {
      attemptId: "att-1",
      idempotencyKey: "key-pat",
      sender: "ada@sender.example",
      destination: "pat@harbour.example",
      rendered: { subject: "Hello Pat", body: "A note." },
      threadRef: null,
      threading: "new_subject",
      subjectId: "enr-1",
      trackId: "t1",
      stepId: "s1",
    };
    const open = fake.hold("POST", "/api/v2/campaigns");
    const fromA = a.handover(request);
    await flush();
    const fromB = b.handover(request);
    await flush();
    open();
    const answers = await Promise.all([fromA, fromB]);
    expect(answers.map((x) => x.kind)).toEqual(["accepted", "accepted"]);

    const key = "enrollment|camp-1|t1|s1|ada@sender.example";
    const adopted = first.instantly.dispatchCampaign(key)?.instantlyId;
    expect(read(key)?.instantlyId).toBe(adopted);
    // The same key, the same lead, the same campaign: byte-identical requests.
    const adds = fake.requests.filter((r) => r.path === "/api/v2/leads/add").map((r) => JSON.stringify(r.body));
    expect(adds).toHaveLength(2);
    expect(adds[1]).toBe(adds[0]);
    const lead = fake.leads.find((l) => l.email === "pat@harbour.example");
    expect(lead?.campaign).toBe(adopted);
    expect(first.instantly.dispatched("key-pat")?.instantlyCampaignId).toBe(adopted);

    // The lead unsubscribes; every later status scan reads the lead's real campaign.
    clock += 2 * MINUTE;
    fake.advance();
    fake.setLeadStatus("pat@harbour.example", -2);
    const observed = await a.observe("c0");
    expect(observed.events.filter((e) => e.kind === "reply" && e.id.startsWith("unsubscribed:"))).toHaveLength(1);
  });

  test("two polls of two processes that overlap: the later commit does not overwrite the earlier one's batch; it fails and the next poll carries on", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "oo-two-processes-"));
    const file = path.join(dir, "outreach.sqlite");
    let clock = T0;
    const now = () => clock;
    const fake = new FakeInstantly({ now, accounts: [{ email: "ada@sender.example", status: 1, daily_limit: 30 }] });
    const first = openSqliteStore(file);
    const second = openSqliteStore(file);
    stores.push(first, second);
    // The second process's own network, held at its status read.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch: typeof fake.fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : input.toString()).pathname === "/api/v2/leads/list") await held;
      return fake.fetch(input, init);
    };
    const port = (store: OutreachStore, fetch: typeof fake.fetch) =>
      new InstantlyEmailPort({
        client: new InstantlyClient({ apiKey: "test-key-not-real", fetch, writes: true, now, timeoutMs: 10_000 }),
        store: store.instantly,
        now,
        config: { resetZone: "UTC", pollIntervalMs: 0 },
        subjectCampaign: () => Promise.resolve({ kind: "enrollment", campaignId: "camp-1" }),
      });
    const a = port(first, fake.fetch);
    const b = port(second, slowFetch);
    await a.observe(null);
    await a.handover({ attemptId: "att-1", idempotencyKey: "key-pat", sender: "ada@sender.example", destination: "pat@harbour.example", rendered: { subject: "Hello", body: "A note." }, threadRef: null, threading: "new_subject", subjectId: "enr-1", trackId: "t1", stepId: "s1" });
    clock += 2 * MINUTE;
    fake.advance();
    const start = (await a.observe("c0")).checkpoint;
    fake.setLeadStatus("pat@harbour.example", -2);
    const slow = b.observe(start);
    await flush();
    const fast = await a.observe(start);
    release();
    // The second commit would overwrite the first one's batch, which its engine may not have applied.
    await expect(slow).rejects.toThrow(/another poll/);
    expect(fast.events.filter((e) => e.id.startsWith("unsubscribed:"))).toHaveLength(1);
    // The batch the store holds is the one the first process reported: replayed until it is acknowledged.
    const again = await a.observe("someone-else");
    expect(again.events.filter((e) => e.id.startsWith("unsubscribed:"))).toHaveLength(1);
  });
});
