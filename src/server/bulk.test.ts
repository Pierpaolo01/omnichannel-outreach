import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import { pressOf } from "../web/bulk/press.ts";
import type { BulkAddAnswer, BulkAddPreview, BulkControlAnswer, BulkControlPreview, EnrollmentRead, LeadSearchResult } from "../shared/api.ts";

/**
 * Bulk add, pause, resume and stop on Leads (ticket 18; ADR 0003 "Ticket 18"): a bulk control is the set of per-lead
 * controls its confirmation showed, each through the engine's own control with an id derived from the bulk id, and add
 * uses the import's enrollment rule. Through the real HTTP app, SQLite store and engine on the fake email provider.
 * Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const track = (id: string, steps: StepDefinition[]): TrackDefinition => ({ id, channel: "email", branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false });
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [track("e1", [email("s1"), email("s2", 5), email("s3", 5)])],
};
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const QUAY = business({ business_id: "b2", business_name: "Quayside Clinic", email: "hello@quayside.example", general_emails: "hello@quayside.example" });
const NOLINE = business({ business_id: "b3", business_name: "Fernhill Rooms" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" });
const ODA = person({ person_id: "p3", business_id: "b3", full_name: "Oda Finch" });

async function world() {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  const campaign = async (name: string, people: readonly (typeof PAT)[], launch = true) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR, QUAY, NOLINE], people });
    await h.defineSequence(c.id, DEFINITION);
    if (launch) expect((await h.launch(c.id)).status).toBe(200);
    return c.id;
  };
  const rows = async () => (await h.request<LeadSearchResult>("GET", "/api/leads")).body.rows;
  const row = async (name: string) => {
    const found = (await rows()).find((r) => r.name === name);
    if (!found) throw new Error(`no row ${name}`);
    return found;
  };
  const ref = async (name: string) => {
    const r = await row(name);
    return { kind: r.kind, id: r.id };
  };
  const lead = async (name: string, campaignId: string) => (await row(name)).enrollments.find((e) => e.campaign.id === campaignId)?.id ?? "";
  const read = async (enrollmentId: string) => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${enrollmentId}`)).body;
  const preview = <T>(body: unknown) => h.request<T>("POST", "/api/bulk/preview", body);
  const press = <T>(body: unknown) => h.request<T>("POST", "/api/bulk", body);
  /** The press a confirmation sends: the preview's allowed items, each with the precondition the preview showed. */
  const pressOf = (bulkId: string, p: BulkControlPreview) => ({
    bulkId,
    action: p.action,
    campaignId: p.scope?.id ?? null,
    items: p.items.flatMap((i) => (i.control.allowed ? [{ enrollmentId: i.enrollmentId, expect: { status: i.status, preview: i.control.digest } }] : [])),
  });
  let n = 0;
  const control = (enrollmentId: string, action: string) => h.request("POST", `/api/enrollments/${enrollmentId}/controls`, { requestId: `elsewhere-${++n}`, action });
  return { h, campaign, ref, lead, read, preview, press, pressOf, control };
}

describe("a bulk control's preview resolves its scope once, from one read", () => {
  test("filtered to a campaign: only that campaign's enrollments of the selected people, each with its read's control, and counts that tally the items", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, NIA]);
    const second = await w.campaign("Second", [PAT]);
    const draft = await w.campaign("Draft", [PAT], false);
    await w.h.advanceTo(MONDAY_9 + H);
    const pat = await w.ref("Pat Oneil");
    const nia = await w.ref("Nia Cole");

    const scoped = await w.preview<BulkControlPreview>({ action: "pause", rows: [pat, nia], campaignId: clinics });
    expect(scoped.status).toBe(200);
    expect(scoped.body.scope).toEqual({ id: clinics, name: "Clinics" });
    expect(scoped.body.items.map((i) => i.enrollmentId).sort()).toEqual([await w.lead("Pat Oneil", clinics), await w.lead("Nia Cole", clinics)].sort());
    expect(scoped.body.counts).toEqual({ applies: 2, refused: 0, reasons: [] });

    const everywhere = await w.preview<BulkControlPreview>({ action: "pause", rows: [pat], campaignId: null });
    expect(everywhere.body.scope).toBeNull();
    expect(everywhere.body.items.map((i) => i.campaign.name).sort()).toEqual(["Clinics", "Draft", "Second"]);
    // Each item is the enrollment's own read at that instant: the draft campaign's lead is refused with the action's reason.
    for (const item of everywhere.body.items) expect(item.control).toEqual((await w.read(item.enrollmentId)).controls.find((c) => c.action === "pause"));
    expect(everywhere.body.counts).toEqual({ applies: 2, refused: 1, reasons: [{ reason: "This campaign has not launched: nothing of this lead runs yet.", count: 1 }] });
    expect(second && draft).toBeTruthy();
  });

  test("a selected row with no enrollment in scope is listed apart, never as an item", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT]);
    await w.campaign("Second", [NIA]);
    const res = await w.preview<BulkControlPreview>({ action: "stop", rows: [await w.ref("Pat Oneil"), await w.ref("Nia Cole")], campaignId: clinics });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.outOfScope.map((r) => r.name)).toEqual(["Nia Cole"]);
  });
});

describe("a bulk control applies each per-lead control once, through the engine", () => {
  test("applied per lead, answered per lead; a retry with the same bulk id replays every answer and changes nothing, even after another tab resumed a lead", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, NIA]);
    await w.h.advanceTo(MONDAY_9 + H);
    const p = (await w.preview<BulkControlPreview>({ action: "pause", rows: [await w.ref("Pat Oneil"), await w.ref("Nia Cole")], campaignId: clinics })).body;
    const body = w.pressOf("bulk-1", p);

    const first = await w.press<BulkControlAnswer>(body);
    expect(first.status).toBe(200);
    expect(first.body.results.map((r) => [r.outcome, r.replayed])).toEqual([["applied", false], ["applied", false]]);
    expect(first.body.counts).toEqual({ applied: 2, refused: 0 });
    const patLead = await w.lead("Pat Oneil", clinics);
    expect((await w.read(patLead)).status).toBe("paused");

    // Another tab resumes Pat; the lost answer's retry must not pause Pat again.
    expect((await w.control(patLead, "resume")).status).toBe(200);
    const retry = await w.press<BulkControlAnswer>(body);
    expect(retry.body.results.map((r) => [r.enrollmentId, r.outcome, r.replayed])).toEqual(first.body.results.map((r) => [r.enrollmentId, r.outcome, true]));
    expect((await w.read(patLead)).status).not.toBe("paused");
  });

  test("a lead that changed between the confirmation and the press is refused, and only it", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, NIA]);
    await w.h.advanceTo(MONDAY_9 + H);
    const p = (await w.preview<BulkControlPreview>({ action: "stop", rows: [await w.ref("Pat Oneil"), await w.ref("Nia Cole")], campaignId: clinics })).body;
    const patLead = await w.lead("Pat Oneil", clinics);
    // Stop is still allowed on a paused lead, but this is not what the confirmation showed.
    expect((await w.control(patLead, "pause")).status).toBe(200);
    const answer = (await w.press<BulkControlAnswer>(w.pressOf("bulk-2", p))).body;
    const pat = answer.results.find((r) => r.enrollmentId === patLead);
    expect(pat?.outcome).toBe("refused");
    // Leads' own wording: a row has no confirm of its own (council item 9 on 3555a3e).
    expect(pat?.reason).toBe("This lead changed since you confirmed this, so nothing was changed. Select it again to see what a bulk change would do now.");
    expect(answer.counts).toEqual({ applied: 1, refused: 1 });
    expect((await w.read(patLead)).status).toBe("paused");
  });

  test("two tabs pressing confirmations of one read: each lead changes once, the second tab's items are refused by the lead's own rule", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, NIA]);
    await w.h.advanceTo(MONDAY_9 + H);
    const p = (await w.preview<BulkControlPreview>({ action: "pause", rows: [await w.ref("Pat Oneil"), await w.ref("Nia Cole")], campaignId: clinics })).body;
    await w.press(w.pressOf("tab-a", p));
    const b = (await w.press<BulkControlAnswer>(w.pressOf("tab-b", p))).body;
    expect(b.results.every((r) => r.outcome === "refused" && r.reason === "They are already paused.")).toBe(true);
  });

  test("a bulk id is bound to its body: the same id with other items is refused whole", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, NIA]);
    await w.h.advanceTo(MONDAY_9 + H);
    const p = (await w.preview<BulkControlPreview>({ action: "pause", rows: [await w.ref("Pat Oneil"), await w.ref("Nia Cole")], campaignId: clinics })).body;
    const body = w.pressOf("bulk-3", p);
    await w.press({ ...body, items: body.items.slice(0, 1) });
    const again = await w.press<{ error: { code: string; message: string } }>(body);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("This request id was already used for another action: send a new one.");
    expect((await w.read(await w.lead("Nia Cole", clinics))).status).not.toBe("paused");
  });

  test("the boundary: unknown fields, an empty or oversized selection, a bulk id with a slash, add without a campaign", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT]);
    const pat = await w.ref("Pat Oneil");
    expect((await w.preview({ action: "pause", rows: [pat], campaignId: null, extra: 1 })).status).toBe(400);
    expect((await w.preview({ action: "pause", rows: [], campaignId: null })).status).toBe(400);
    expect((await w.preview({ action: "pause", rows: Array.from({ length: 501 }, () => pat), campaignId: null })).status).toBe(400);
    expect((await w.preview({ action: "add", rows: [pat], campaignId: null })).status).toBe(400);
    expect((await w.preview({ action: "skip", rows: [pat], campaignId: null })).status).toBe(400);
    expect((await w.press({ bulkId: "a/b", action: "pause", campaignId: clinics, items: [{ enrollmentId: "x", expect: { status: "active", preview: "d" } }] })).status).toBe(400);
  });

  test("a press may carry every item a preview can show: more items than rows when the rows are in several campaigns (review bot on 9daf7c0)", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT]);
    // 500 rows in two or more campaigns each give a preview of over 500 items; its press must not be refused for size.
    const items = Array.from({ length: 1_000 }, (_, i) => ({ enrollmentId: `nobody-${i}`, expect: { status: "active", preview: "d" } }));
    const res = await w.press<BulkControlAnswer>({ bulkId: "bulk-big", action: "pause", campaignId: clinics, items });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ applied: 0, refused: 1_000 });
  });

  test("an enrollment that does not exist is answered per item, never by refusing the bulk", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT]);
    const res = await w.press<BulkControlAnswer>({ bulkId: "bulk-4", action: "pause", campaignId: clinics, items: [{ enrollmentId: "nobody", expect: { status: "active", preview: "d" } }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ enrollmentId: "nobody", outcome: "refused", reason: "There is no such lead.", replayed: false }]);
  });
});

describe("add to campaign uses the import's enrollment rule", () => {
  test("enrolled, already enrolled, no usable channel; the preview says each, the press does it once, and a retry replays it", async () => {
    const w = await world();
    const clinics = await w.campaign("Clinics", [PAT, ODA]);
    const second = await w.campaign("Second", [NIA], false);
    const rows = [await w.ref("Pat Oneil"), await w.ref("Nia Cole"), await w.ref("Oda Finch"), await w.ref("Quayside Clinic")];

    const p = await w.preview<BulkAddPreview>({ action: "add", rows, campaignId: second });
    expect(p.status).toBe(200);
    expect(p.body.rows.map((r) => [r.row.name, r.outcome, r.notEnrolled])).toEqual([
      ["Pat Oneil", "enroll", null],
      ["Nia Cole", "already_enrolled", null],
      ["Oda Finch", "not_enrolled", { reason: "no_usable_channel" }],
      ["Quayside Clinic", "already_enrolled", null],
    ]);
    expect(p.body.counts).toEqual({ enroll: 1, alreadyEnrolled: 2, notEnrolled: 1 });

    const body = { bulkId: "add-1", action: "add", campaignId: second, rows };
    const first = await w.press<BulkAddAnswer>(body);
    expect(first.status).toBe(200);
    expect(first.body.results.map((r) => [r.row.name, r.outcome])).toEqual([
      ["Pat Oneil", "enrolled"],
      ["Nia Cole", "already_enrolled"],
      ["Oda Finch", "not_enrolled"],
      ["Quayside Clinic", "already_enrolled"],
    ]);
    const again = await w.press<BulkAddAnswer>(body);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect((await w.lead("Pat Oneil", second)) !== "").toBe(true);
    // One enrollment of Pat in the campaign, never two.
    const leads = (await w.h.request<LeadSearchResult>("GET", `/api/leads?campaign=${second}`)).body.rows.find((r) => r.name === "Pat Oneil");
    expect(leads?.enrollments.filter((e) => e.campaign.id === second)).toHaveLength(1);
    expect(clinics).toBeTruthy();
  });

  test("a row the add preview said would not be added is never sent, even when it became reachable before the press (council item 8 on 3555a3e, Sol's reproduction)", async () => {
    const w = await world();
    await w.campaign("Clinics", [PAT, ODA]);
    const running = await w.campaign("Running", [NIA]);
    const other = await w.campaign("Elsewhere", [NIA]);
    await w.h.advanceTo(MONDAY_9 + 10 * MIN);
    const rows = [await w.ref("Pat Oneil"), await w.ref("Oda Finch")];
    const preview = (await w.preview<BulkAddPreview>({ action: "add", rows, campaignId: running })).body;
    expect(preview.rows.map((r) => [r.row.name, r.outcome])).toEqual([
      ["Pat Oneil", "enroll"],
      ["Oda Finch", "not_enrolled"],
    ]);
    // Another tab re-imports Oda with an email, into another campaign: Oda can be reached now.
    await w.h.reimport(other, { businesses: [HARBOUR, QUAY, NOLINE], people: [{ ...ODA, email: "oda@fernhill.example" }] });
    // The confirmation sends what it showed it would add: Pat, and not Oda.
    const plan = pressOf(preview);
    const answer = (await w.press<BulkAddAnswer>({ bulkId: "add-sol", ...plan.body })).body;
    expect(answer.results.map((r) => [r.row.name, r.outcome])).toEqual([["Pat Oneil", "enrolled"]]);
    expect(await w.lead("Oda Finch", running)).toBe("");
    await w.h.advanceTo(MONDAY_9 + 2 * H);
    // Anything sent to Oda is from the campaign that imported them, never from the one the confirmation left them out of.
    const odaElsewhere = await w.lead("Oda Finch", other);
    expect(w.h.fake.deliveryLog.filter((d) => d.destination === "oda@fernhill.example").every((d) => d.subjectId === odaElsewhere)).toBe(true);
  });

  test("a person enrolled between the confirmation and the press is reported as already enrolled", async () => {
    const w = await world();
    await w.campaign("Clinics", [PAT]);
    const second = await w.campaign("Second", [NIA], false);
    const pat = await w.ref("Pat Oneil");
    const p = (await w.preview<BulkAddPreview>({ action: "add", rows: [pat], campaignId: second })).body;
    expect(p.rows[0]?.outcome).toBe("enroll");
    await w.press({ bulkId: "add-tab-a", action: "add", campaignId: second, rows: [pat] });
    const b = (await w.press<BulkAddAnswer>({ bulkId: "add-tab-b", action: "add", campaignId: second, rows: [pat] })).body;
    expect(b.results.map((r) => r.outcome)).toEqual(["already_enrolled"]);
  });
});
