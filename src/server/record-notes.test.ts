import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { ActivityView, CallTaskView, CallsView, CompanyRecord, LeadSearchResult, NoteAnswer, PersonRecord, RecordColleagues } from "../shared/api.ts";

/**
 * Notes typed on a person's or company lead's record, and the colleagues' last call notes (ticket 18): a person note shows
 * on that person's timeline; a company note on everyone's at the company; a note written with a call shows on the call's
 * entry. Through the real HTTP app, SQLite store and engine. Data is fictitious.
 */

const MIN = 60_000;
/** Monday 2 November 2026, 10:00 London (GMT). */
const MONDAY_10 = Date.parse("2026-11-02T10:00:00Z");
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const phone: TrackDefinition = { id: "p1", channel: "call", branch: "main", window: WEEKDAYS, steps: [call("c1")], start: { kind: "entry" }, removed: false };
const DEFINITION: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], callScript: "Ask for the owner.", tracks: [phone] };
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
const QUAY = business({ business_id: "b2", business_name: "Quayside Clinic", phone_e164: "+442079460201", general_emails: "hello@quayside.example" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", direct_phone: "+442079460111" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", direct_phone: "+442079460112" });

async function world() {
  const h = new EngineHarness({ start: MONDAY_10, accounts: [] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR, QUAY], people: [PAT, NIA] });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_10 + MIN);
  const rows = (await h.request<LeadSearchResult>("GET", "/api/leads")).body.rows;
  const id = (name: string) => rows.find((r) => r.name === name)?.id ?? "";
  const activity = async (path: string) => (await h.request<ActivityView>("GET", `${path}/activity`)).body;
  const note = (path: string, body: unknown) => h.request<NoteAnswer & { error?: { message: string } }>("POST", `${path}/notes`, body);
  const logWithNote = async (who: string, note: string, noteScope: "person" | "company") => {
    const queue = (await h.request<CallsView>("GET", "/api/calls")).body;
    const item = [...queue.readyNow, ...queue.laterToday].find((i) => i.person?.name === who);
    if (!item) throw new Error(`no call for ${who}`);
    const task = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
    const numberId = task.numbers.find((n) => !n.bad)?.detailId;
    const res = await h.request("POST", `/api/call-tasks/${item.taskId}/outcome`, { requestId: `call-${who}`, outcome: "no_answer", numberId, note, noteScope });
    expect(res.status).toBe(200);
  };
  return { h, pat: `/api/people/${id("Pat Oneil")}`, nia: `/api/people/${id("Nia Cole")}`, quay: `/api/companies/${id("Quayside Clinic")}`, activity, note, logWithNote };
}

describe("notes typed on a record", () => {
  test("a person note shows on that person only; a company note shows for everyone at the company", async () => {
    const w = await world();
    expect((await w.note(w.pat, { requestId: "n1", body: "Prefers mornings.", scope: "person" })).status).toBe(201);
    await w.h.advanceTo(MONDAY_10 + 2 * MIN);
    expect((await w.note(w.pat, { requestId: "n2", body: "Front desk closes at 16:00.", scope: "company" })).status).toBe(201);

    const pat = await w.activity(w.pat);
    expect(pat.notes.map((n) => [n.scope, n.body])).toEqual([
      ["company", "Front desk closes at 16:00."],
      ["person", "Prefers mornings."],
    ]);
    const nia = await w.activity(w.nia);
    expect(nia.notes.map((n) => [n.scope, n.body])).toEqual([["company", "Front desk closes at 16:00."]]);
  });

  test("a retry with the same request id stores the note once; the same id with another body is refused and stores nothing", async () => {
    const w = await world();
    const first = await w.note(w.pat, { requestId: "n1", body: "Prefers mornings.", scope: "person" });
    const again = await w.note(w.pat, { requestId: "n1", body: "Prefers mornings.", scope: "person" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ note: first.body.note, replayed: true });
    const other = await w.note(w.pat, { requestId: "n1", body: "Something else.", scope: "person" });
    expect(other.status).toBe(409);
    expect((await w.activity(w.pat)).notes).toHaveLength(1);
  });

  test("a company lead's record takes company notes, shown for the people at the company too", async () => {
    const w = await world();
    expect((await w.note(w.quay, { requestId: "q1", body: "Reception answers until 18:00." })).status).toBe(201);
    expect((await w.activity(w.quay)).notes.map((n) => [n.scope, n.body])).toEqual([["company", "Reception answers until 18:00."]]);
  });

  test("the boundary: an empty note, one over 10,000 characters, an unknown scope or field, no such record", async () => {
    const w = await world();
    expect((await w.note(w.pat, { requestId: "e1", body: "   ", scope: "person" })).status).toBe(400);
    expect((await w.note(w.pat, { requestId: "e2", body: "x".repeat(10_001), scope: "person" })).status).toBe(400);
    expect((await w.note(w.pat, { requestId: "e3", body: "Hi", scope: "everyone" })).status).toBe(400);
    expect((await w.note(w.quay, { requestId: "e4", body: "Hi", scope: "company" })).status).toBe(400);
    expect((await w.note("/api/people/nobody", { requestId: "e5", body: "Hi", scope: "person" })).status).toBe(404);
  });
});

describe("a note written with a call", () => {
  test("shows on the call's entry on that lead's record, and as a company note on a colleague's", async () => {
    const w = await world();
    await w.logWithNote("Pat Oneil", "Owner is away until Friday.", "company");
    const pat = await w.activity(w.pat);
    expect(pat.notes).toEqual([]);
    expect(pat.entries.some((e) => e.kind === "call" && e.note === "Owner is away until Friday.")).toBe(true);
    expect((await w.activity(w.nia)).notes.map((n) => [n.scope, n.body])).toEqual([["company", "Owner is away until Friday."]]);
  });
});

describe("colleagues on a record carry their last call note", () => {
  test("Nia's last call note on Pat's record, and on the company's people", async () => {
    const w = await world();
    await w.logWithNote("Nia Cole", "Asked to call after lunch.", "person");
    const record = (await w.h.request<PersonRecord & RecordColleagues>("GET", w.pat)).body;
    const nia = record.colleagues.find((c) => c.name === "Nia Cole");
    expect(record.colleagueNotes.find((c) => c.personId === nia?.id)?.lastCallNote).toMatchObject({ note: "Asked to call after lunch.", outcome: "no_answer" });
    expect(record.colleagueNotes.find((c) => c.personId !== nia?.id)).toBeUndefined();
    const company = (await w.h.request<CompanyRecord & RecordColleagues>("GET", w.quay)).body;
    expect(company.colleagueNotes).toEqual([]);
  });
});
