import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../domain/sequence/definition.ts";
import type { Rules } from "./engine/rules.ts";
import type { BulkControlAnswer, BulkControlPreview, EnrollmentRead, LeadSearchResult } from "../shared/api.ts";

/**
 * A confirmation is a snapshot of the read it was opened on, checked against the same thing the read showed (ticket 17b).
 * The read evaluates its lead as of its own instant; so must the check, in the action's transaction (the review bot on
 * 712884b). Every name and address is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
/** Monday 9 November 2026, 10:00 London (GMT). */
const MONDAY_10 = Date.parse("2026-11-09T10:00:00Z");
/** Wednesday 11 November 2026, 00:00 London: the user day the call's skip limit ends it. */
const WEDNESDAY_0 = Date.parse("2026-11-11T00:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({ id, waitDays: 0, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false, ...fields });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start, removed: false });
// The reviewer's campaign: an always-open call track with a skip limit of two days, and an email track five days after it.
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [track("phone", "call", [step("c1", { subject: "", body: "" })]), track("email", "email", [step("e1")], { kind: "after", trackId: "phone", delayDays: 5 })],
};
const LARK = business({ business_id: "b1", business_name: "Lark Street Clinic", phone_e164: "+441174960303" });
const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@larkstreet.example", direct_phone: "+441174960901" });

async function world(definition: CampaignDefinition = DEFINITION, rules: Partial<Rules> = {}) {
  const h = new EngineHarness({ start: MONDAY_10, rules, accounts: [{ id: "inbox-a", capacity: 50, gapMs: 10 * MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  expect((await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" })).status).toBe(200);
  const { campaign } = await h.createCampaign("Spring follow-up, Bristol", { businesses: [LARK], people: [PAT] });
  await h.defineSequence(campaign.id, definition);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const pat = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]?.enrollments[0]?.id ?? "";
  // The call left unworked; Wednesday's midnight reached with no worker round.
  await h.advanceTo(WEDNESDAY_0 - H);
  h.clock = WEDNESDAY_0;
  const read = async () => (await h.request<EnrollmentRead>("GET", `/api/enrollments/${pat}`)).body;
  return { h, campaign, pat, read };
}

describe("a confirmation is checked against the lead as the read showed it: evaluated as of its instant (review bot on 712884b)", () => {
  test("the reviewer's reproduction: stored waiting_on_call, read queued; Stop confirmed with the read's own expect is applied, not refused as changed", async () => {
    const { h, pat, read } = await world();
    expect((await h.store.engine.subject(pat, h.clock))?.subject.status).toBe("waiting_on_call");
    const r = await read();
    expect(r.status).toBe("queued");
    const stop = r.controls.find((c) => c.action === "stop");
    expect(stop?.allowed).toBe(true);
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "stop-1", action: "stop", expect: { status: r.status, preview: stop?.allowed ? stop.digest : "" } });
    expect(res.status).toBe(200);
    expect((await read()).status).toBe("stopped_manually");
  });

  test("the same lead in a bulk Stop: the preview's precondition holds at the press", async () => {
    const { h, campaign, pat } = await world();
    const rowRef = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0];
    const p = (await h.request<BulkControlPreview>("POST", "/api/bulk/preview", { action: "stop", rows: [{ kind: rowRef?.kind, id: rowRef?.id }], campaignId: campaign.id })).body;
    expect(p.items.map((i) => [i.enrollmentId, i.status, i.control.allowed])).toEqual([[pat, "queued", true]]);
    const items = p.items.flatMap((i) => (i.control.allowed ? [{ enrollmentId: i.enrollmentId, expect: { status: i.status, preview: i.control.digest } }] : []));
    const answer = await h.request<BulkControlAnswer>("POST", "/api/bulk", { bulkId: "bulk-stop-1", action: "stop", campaignId: campaign.id, items });
    expect(answer.status).toBe(200);
    expect(answer.body.results.map((x) => x.outcome)).toEqual(["applied"]);
  });

  test("a genuinely stale confirmation is still refused: another client pauses the lead between the read and the press", async () => {
    const { h, pat, read } = await world();
    const r = await read();
    const stop = r.controls.find((c) => c.action === "stop");
    expect((await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "pause-elsewhere", action: "pause" })).status).toBe(200);
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "stop-stale", action: "stop", expect: { status: r.status, preview: stop?.allowed ? stop.digest : "" } });
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/changed since you confirmed/);
    expect((await read()).status).toBe("paused");
  });

  test("the re-check's Pause: confirmed on a fresh read between rounds, it is stored, and the next round sends nothing to that lead", async () => {
    // The email track starts the moment the call ends, so at Wednesday's midnight its email is due between rounds.
    const now = { ...DEFINITION, tracks: DEFINITION.tracks.map((t) => (t.id === "email" ? { ...t, start: { kind: "after" as const, trackId: "phone", delayDays: 0 } } : t)) };
    const { h, pat, read } = await world(now);
    const r = await read();
    const pause = r.controls.find((c) => c.action === "pause");
    expect(pause?.allowed).toBe(true);
    const res = await h.request("POST", `/api/enrollments/${pat}/controls`, { requestId: "pause-1", action: "pause", expect: { status: r.status, preview: pause?.allowed ? pause.digest : "" } });
    expect(res.status).toBe(200);
    expect((await read()).status).toBe("paused");
    await h.tick();
    await h.advanceTo(h.clock + H);
    expect(h.fake.deliveryLog.filter((d) => d.subjectId === pat)).toEqual([]);
  });

  test("the mutation \"the confirmation check judges the stored subject, not the evaluated one\" is caught: the reproduction's Stop is refused as changed", async () => {
    const { h, pat, read } = await world(DEFINITION, { confirmedAgainst: (stored) => stored });
    const r = await read();
    const stop = r.controls.find((c) => c.action === "stop");
    const res = await h.request<{ error?: { message: string } }>("POST", `/api/enrollments/${pat}/controls`, { requestId: "stop-1", action: "stop", expect: { status: r.status, preview: stop?.allowed ? stop.digest : "" } });
    expect(res.status).toBe(409);
  });
});
