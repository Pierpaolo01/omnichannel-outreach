import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { EditImpactView, LeadSearchResult } from "../../shared/api.ts";

/**
 * Editing a running campaign (ticket 19; ADR 0003 "Ticket 19") through the real HTTP app, SQLite store and engine,
 * against the fake email provider. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0, body = `Email ${id} for {{company}}.`): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body, threading: "new_subject", removed: false });
const track = (id: string, steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({ id, channel: "email", branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false, ...fields });
const def = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], callScript: "", tracks });
const THREE = def([track("e1", [email("s1"), email("s2", 2), email("s3", 3)])]);

const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" });

async function world(definition = THREE) {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT, NIA] });
  await h.defineSequence(campaign.id, definition);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const lead = (who: string) => rows.find((r) => r.name === who)?.enrollments[0]?.id ?? "";
  const save = (next: CampaignDefinition) => h.request<{ error?: { code: string; message: string } }>("PUT", `/api/campaigns/${campaign.id}/sequence`, next);
  const sent = (id: string) => h.fake.deliveryLog.filter((d) => d.subjectId === id).map((d) => d.stepId);
  const handovers = (id: string) => h.fake.handoverLog.filter((d) => d.subjectId === id);
  return { h, id: campaign.id, lead, save, sent, handovers };
}

describe("a running campaign takes edits", () => {
  test("a removed step is skipped by leads not yet at it, and the next one is due from the same basis", async () => {
    const w = await world();
    const pat = w.lead("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + H);
    expect(w.sent(pat)).toEqual(["s1"]);
    const saved = await w.save(def([track("e1", [email("s1"), { ...email("s2", 2), removed: true }, email("s3", 3)])]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // s3 is three days after s1's send: Thursday 5 November 00:00. Nothing goes on Wednesday.
    await w.h.advanceTo(Date.parse("2026-11-04T23:00:00Z"));
    expect(w.sent(pat)).toEqual(["s1"]);
    await w.h.advanceTo(Date.parse("2026-11-05T01:00:00Z"));
    expect(w.sent(pat)).toEqual(["s1", "s3"]);
  });

  test("changed copy reaches the next message handed over, not one already sent", async () => {
    const w = await world();
    const pat = w.lead("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.save(def([track("e1", [email("s1", 0, "Changed first."), email("s2", 2, "New second for {{company}}."), email("s3", 3)])]))).status).toBe(200);
    await w.h.advanceTo(Date.parse("2026-11-04T01:00:00Z"));
    const bodies = w.handovers(pat).map((x) => [x.stepId, x.rendered.body]);
    expect(bodies).toEqual([["s1", "Email s1 for Harbour Lane Physio."], ["s2", "New second for Harbour Lane Physio."]]);
  });

  test("a deleted step or a branch move is refused, and so is a launch blocker; a refused edit changes nothing", async () => {
    const w = await world();
    await w.h.advanceTo(MONDAY_9 + H);
    const before = await w.h.request("GET", `/api/campaigns/${w.id}/sequence`);
    const deleted = await w.save(def([track("e1", [email("s1"), email("s3", 3)])]));
    expect(deleted.status).toBe(400);
    expect(deleted.body.error?.message).toContain("cannot be deleted on a running campaign");
    const empty = await w.save(def([track("e1", [email("s1"), email("s2", 2, ""), email("s3", 3)])]));
    expect(empty.status).toBe(409);
    expect(empty.body.error?.code).toBe("blocked");
    expect((await w.h.request("GET", `/api/campaigns/${w.id}/sequence`)).body).toEqual(before.body);
  });

  test("a paused campaign's edits apply on its resume by the same rules", async () => {
    const w = await world();
    const pat = w.lead("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + H);
    expect((await w.h.request("POST", `/api/campaigns/${w.id}/pause`, { requestId: "p1" })).status).toBe(200);
    expect((await w.save(def([track("e1", [email("s1"), email("s2", 1), email("s3", 3)])]))).status).toBe(200);
    // Paused for one day: s2, now one day after Monday's send, is due Tuesday 00:00 plus the day paused.
    await w.h.advanceTo(MONDAY_9 + DAY + H);
    expect((await w.h.request("POST", `/api/campaigns/${w.id}/resume`, { requestId: "p2" })).status).toBe(200);
    await w.h.advanceTo(Date.parse("2026-11-03T23:30:00Z"));
    expect(w.sent(pat)).toEqual(["s1"]);
    await w.h.advanceTo(Date.parse("2026-11-04T01:00:00Z"));
    expect(w.sent(pat)).toEqual(["s1", "s2"]);
  });

  test("an added track reaches every running lead; a finished track is never restarted", async () => {
    const w = await world(def([track("e1", [email("s1")]), track("e2", [email("x1")], { start: { kind: "after", trackId: "e1", delayDays: 3 } })]));
    const pat = w.lead("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + H);
    expect(w.sent(pat)).toEqual(["s1"]);
    // e1 is finished for Pat; a step added to it is never sent. e2 is reconnected to start one day after e1.
    const saved = await w.save(def([track("e1", [email("s1"), email("s2", 1)]), track("e2", [email("x1")], { start: { kind: "after", trackId: "e1", delayDays: 1 } }), track("e3", [email("y1")])]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await w.h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(w.sent(pat).sort()).toEqual(["s1", "x1", "y1"]);
    const x1 = w.handovers(pat).find((x) => x.stepId === "x1")!;
    expect(x1.at).toBeGreaterThanOrEqual(Date.parse("2026-11-03T00:00:00Z"));
    expect(x1.at).toBeLessThan(Date.parse("2026-11-03T01:00:00Z"));
  });
});

describe("the editor's read of what a draft would do (ADR 0003 \"Ticket 19\")", () => {
  test("leads before, inside and past the affected step are counted as the save would treat them; nothing is stored", async () => {
    const w = await world();
    const pat = w.lead("Pat Oneil");
    await w.h.advanceTo(MONDAY_9 + H);
    // Nia replies, so she is past everything.
    w.h.fake.prospectReplies("nia@harbour.example");
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    const draft = def([track("e1", [email("s1", 0, "Changed."), { ...email("s2", 2), removed: true }, email("s3", 3), email("s4", 1)])]);
    const read = await w.h.request<import("../../shared/api.ts").EditImpactView>("POST", `/api/campaigns/${w.id}/sequence/impact`, { definition: draft });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.leads).toBe(2);
    expect(read.body.changes.map((c) => [c.kind, c.stepId, c.reaches, c.skips, c.inFlight, c.untouched])).toEqual([
      ["step_copy", "s1", 0, 0, 0, 2],
      ["step_removed", "s2", 0, 1, 0, 1],
      ["step_added", "s4", 1, 0, 0, 1],
    ]);
    expect(read.body.problems).toEqual([]);
    // A draft that deletes a step is refused before Apply, in the save's own words.
    const deleting = await w.h.request<import("../../shared/api.ts").EditImpactView>("POST", `/api/campaigns/${w.id}/sequence/impact`, { definition: def([track("e1", [email("s1")])]) });
    expect(deleting.body.problems.join(" ")).toContain("cannot be deleted on a running campaign");
    expect(w.sent(pat)).toEqual(["s1"]);
    expect((await w.h.request<{ definitionVersion: number }>("GET", `/api/campaigns/${w.id}/sequence`)).body.definitionVersion).toBe(read.body.definitionVersion);
  });
});

describe("a page opened before launch cannot save as you type onto the running campaign (ADR 0003 \"Ticket 19\", Q24)", () => {
  test("launch moves the revision on and forgets the writing session, so that page's next save is a conflict", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT] });
    const saved = await h.request<{ definitionVersion: number }>("PUT", `/api/campaigns/${campaign.id}/sequence`, { ...THREE, save: { session: "other-tab", seq: 1, base: 0 } });
    expect(saved.status).toBe(200);
    expect((await h.launch(campaign.id)).status).toBe(200);
    const typed = def([track("e1", [email("s1", 0, "Half typ"), email("s2", 2), email("s3", 3)])]);
    const late = await h.request<{ error?: { code: string } }>("PUT", `/api/campaigns/${campaign.id}/sequence`, { ...typed, save: { session: "other-tab", seq: 2, base: saved.body.definitionVersion } });
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe("edit_conflict");
  });
});

describe("a running edit is checked over what leads still run (review bot on 7afa03d)", () => {
  test("clearing a pending email and removing its track is refused: leads that started the track would still send it", async () => {
    const w = await world();
    await w.h.advanceTo(MONDAY_9 + H);
    const cleared = def([track("e1", [email("s1"), email("s2", 2, ""), email("s3", 3)], { removed: true }), track("e9", [email("x1")])]);
    const read = await w.h.request<{ blockers: { kind: string }[] }>("POST", `/api/campaigns/${w.id}/sequence/impact`, { definition: cleared });
    expect(read.body.blockers.map((b) => b.kind)).toContain("empty_copy");
    const saved = await w.save(cleared);
    expect(saved.status).toBe(409);
    expect(saved.body.error?.code).toBe("blocked");
    await w.h.advanceTo(MONDAY_9 + 5 * DAY);
    expect(w.h.fake.handoverLog.filter((x) => x.rendered.body.trim() === "")).toEqual([]);
  });
});

describe("Apply sends exactly what the read was for (review bot on 7afa03d, the 17b class)", () => {
  test("the read carries a digest of the body and the campaign's state; a save with another body or state is refused in place", async () => {
    const w = await world();
    await w.h.advanceTo(MONDAY_9 + H);
    const shown = def([track("e1", [email("s1"), email("s2", 1), email("s3", 3)])]);
    const read = await w.h.request<{ digest: string }>("POST", `/api/campaigns/${w.id}/sequence/impact`, { definition: shown });
    expect(read.body.digest).toMatch(/^[0-9a-f]{64}$/);
    // Another body than the one read: refused, nothing stored.
    const other = await w.save({ ...def([track("e1", [email("s1"), email("s2", 0), email("s3", 3)])]), impact: read.body.digest } as CampaignDefinition);
    expect([other.status, other.body.error?.code]).toEqual([409, "impact_changed"]);
    // The campaign paused since the read: refused too.
    expect((await w.h.request("POST", `/api/campaigns/${w.id}/pause`, { requestId: "p" })).status).toBe(200);
    const paused = await w.save({ ...shown, impact: read.body.digest } as CampaignDefinition);
    expect([paused.status, paused.body.error?.code]).toEqual([409, "impact_changed"]);
    // Read again on the state as it is: applied.
    const again = await w.h.request<{ digest: string }>("POST", `/api/campaigns/${w.id}/sequence/impact`, { definition: shown });
    expect((await w.save({ ...shown, impact: again.body.digest } as CampaignDefinition)).status).toBe(200);
  });
});

describe("a zone edit while a step is with the provider (council on 93bed86, item 8)", () => {
  test("Sol's case: withdrawn after the edit, Email 2 goes at the new zone's deadline, not five hours early", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["late-send"], random: () => 0.5 });
    await h.tick();
    // A lead on the campaign's default zone: neither the person nor the company has one.
    const { campaign } = await h.createCampaign("Clinics", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", timezone: "" })], people: [person({ ...PAT, timezone: "" })] });
    await h.defineSequence(campaign.id, THREE);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-04T00:00:30Z"));
    const pat = h.fake.handoverLog.filter((x) => x.stepId === "s2");
    expect(pat).toHaveLength(1);
    expect(h.fake.deliveryLog.some((d) => d.stepId === "s2")).toBe(false);
    const moved = { ...def([track("e1", [email("s1"), email("s2", 5), email("s3", 3)])]), timezone: "America/New_York" };
    expect((await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, moved)).status).toBe(200);
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/pause`, { requestId: "p1" })).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-04T00:10:00Z"));
    expect(h.fake.withdrawLog.map((w) => w.answer)).toContain("withdrawn");
    expect((await h.request("POST", `/api/campaigns/${campaign.id}/resume`, { requestId: "p2" })).status).toBe(200);
    const resumedAt = h.clock;
    const paused = resumedAt - Date.parse("2026-11-04T00:00:30Z");
    await h.advanceTo(Date.parse("2026-11-08T00:00:00Z"));
    const again = h.fake.handoverLog.filter((x) => x.stepId === "s2").at(1);
    // Five New York days after Email 1 (sent Monday morning New York time): Saturday 00:00 New York, 05:00 UTC, moved by the pause.
    expect(again?.at).toBeGreaterThanOrEqual(Date.parse("2026-11-07T05:00:00Z") + paused);
    expect(again?.at).toBeLessThan(Date.parse("2026-11-07T06:00:00Z") + paused);
  });
});

describe("the read's counts are what the run then does (council on 93bed86, item 9)", () => {
  test("a step inserted behind work already with the provider: the read says the lead is past it, and it is never sent", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }], modes: ["late-send"], random: () => 0.5 });
    await h.tick();
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [PAT] });
    await h.defineSequence(campaign.id, THREE);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-04T00:00:30Z"));
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1"]);
    expect(h.fake.handoverLog.map((x) => x.stepId)).toEqual(["s1", "s2"]);
    const inserted = def([track("e1", [email("s1"), email("s1b", 1), email("s2", 2), email("s3", 3)])]);
    const read = await h.request<EditImpactView>("POST", `/api/campaigns/${campaign.id}/sequence/impact`, { definition: inserted });
    expect(read.body.changes.map((c) => [c.kind, c.stepId, c.reaches, c.untouched])).toEqual([["step_added", "s1b", 0, 1]]);
    expect((await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, inserted)).status).toBe(200);
    await h.advanceTo(Date.parse("2026-11-12T00:00:00Z"));
    expect(h.fake.deliveryLog.map((d) => d.stepId)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("lengthening a phone track's skip limit on a running campaign (council on 93bed86, item 13)", () => {
  test("every open call's deadline is re-resolved from its original due date with the new limit", async () => {
    const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
    await h.tick();
    expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
    const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" })] });
    const phone: TrackDefinition = { id: "p1", channel: "call", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [{ id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false }], start: { kind: "entry" }, removed: false, callSkipLimitDays: 2 };
    const calls = { ...def([phone]), callScript: "Ask who books." };
    await h.defineSequence(campaign.id, calls);
    expect((await h.launch(campaign.id)).status).toBe(200);
    await h.advanceTo(MONDAY_9 + H);
    const id = h.store.engine as unknown as { subject(id: string, now: number): Promise<{ callTasks: { skipDeadline: number; dueWall: number }[] } | null> };
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
    const lead = rows[0]!.enrollments[0]!.id;
    const before = (await id.subject(lead, h.clock))!.callTasks[0]!;
    expect((await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, { ...calls, tracks: [{ ...phone, callSkipLimitDays: 4 }] })).status).toBe(200);
    const after = (await id.subject(lead, h.clock))!.callTasks[0]!;
    expect(after.skipDeadline - before.skipDeadline).toBe(2 * DAY);
  });
});
