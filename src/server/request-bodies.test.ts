import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../test/support/engine-harness.ts";
import { business, csvOf, person } from "../../test/support/export-builder.ts";
import type { CampaignDefinition } from "../domain/sequence/definition.ts";
import type { CallsView, CallTaskView, LeadSearchResult } from "../shared/api.ts";

/**
 * Every request body the HTTP interface reads refuses fields it does not know, with a 400 that names
 * them, so a request for behaviour this release does not have is never half applied (verifier B4 on
 * a1399ce). The test walks every route the app registers: a new route that reads a body is covered
 * without being listed here, and one whose path names a parameter this test cannot fill fails it.
 */

const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const call = { id: "c1", waitDays: 0, subject: "", body: "", threading: "new_subject" as const, removed: false };
const definition: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: [],
  smsPool: [],
  tracks: [{ id: "p1", channel: "call", branch: "main", window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })), steps: [call], start: { kind: "entry" }, removed: false }],
};

async function world() {
  const h = new EngineHarness({ start: MONDAY_9, accounts: [] });
  await h.tick();
  const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })], people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", direct_phone: "+442079460111" })] };
  const { campaign } = await h.createCampaign("Bodies", rows);
  await h.defineSequence(campaign.id, definition);
  // A second campaign, not launched, whose launch route the walk can try.
  const { campaign: unlaunched } = await h.createCampaign("Unlaunched", rows);
  await h.defineSequence(unlaunched.id, definition);
  expect((await h.launch(campaign.id)).status).toBe(200);
  const taskId = (await h.request<CallsView>("GET", "/api/calls")).body.focusTaskId ?? "";
  return { h, campaignId: campaign.id, unlaunchedId: unlaunched.id, taskId, rows };
}

describe("request bodies refuse fields they do not know (verifier B4)", () => {
  test("every route that takes a body answers 400 naming an unknown field, and changes nothing", async () => {
    const { h, unlaunchedId, taskId } = await world();
    const routes = h.app.routes.filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method));
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) {
      const path = r.path.replace(/:(\w+)/g, (_m, name: string) => {
        if (name === "id" && r.path.startsWith("/api/campaigns/")) return unlaunchedId;
        if (name === "id" && r.path.startsWith("/api/call-tasks/")) return taskId;
        throw new Error(`the route walk cannot fill :${name} in ${r.path}; add it here`);
      });
      const res = await h.request<{ error?: { code: string; message: string } }>(r.method, path, { zzUnexpected: true });
      expect([r.method, r.path, res.status], JSON.stringify(res.body)).toEqual([r.method, r.path, 400]);
      expect(res.body.error?.message, `${r.method} ${r.path}`).toContain("zzUnexpected");
    }
    // Nothing was applied: the unlaunched campaign is still unlaunched, and the call is still open.
    expect((await h.request<{ launchedAt: string | null }>("GET", `/api/campaigns/${unlaunchedId}/sequence`)).body.launchedAt).toBeNull();
    expect((await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body.open).toBe(true);
  });

  test("a nested object refuses unknown fields too", async () => {
    const { h, unlaunchedId } = await world();
    const res = await h.request<{ error: { message: string } }>("PUT", `/api/campaigns/${unlaunchedId}/sequence`, { ...definition, tracks: [{ ...definition.tracks[0], steps: [{ ...call, attachment: "x" }] }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("attachment");
  });

  test("not interested takes its declined path; a field it does not know is refused and leaves the call open (ticket 16)", async () => {
    const { h, taskId, campaignId } = await world();
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
    const unknown = await h.request<{ error: { message: string } }>("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "r-declined", outcome: "not_interested", numberId: view.numbers[0]?.detailId, declined: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe("Nothing was changed. (Fields this release does not accept: declined.)");
    const after = (await h.request<CallTaskView>("GET", `/api/call-tasks/${taskId}`)).body;
    expect(after).toMatchObject({ open: true, touches: [] });
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaignId}`)).body.rows;
    expect(rows[0]?.enrollments[0]?.status).toBe("waiting_on_call");
    expect((await h.request("POST", `/api/call-tasks/${taskId}/outcome`, { requestId: "r-ok", outcome: "not_interested", declinedPath: "continue", numberId: view.numbers[0]?.detailId })).status).toBe(200);
  });

  test("an import with an unknown field is refused before anything is imported", async () => {
    const { h, rows } = await world();
    const res = await h.request<{ error: { message: string } }>("POST", "/api/campaigns", { name: "Extra", ...csvOf(rows), dedupe: "off" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("dedupe");
    expect((await h.request<{ campaigns: unknown[] }>("GET", "/api/campaigns")).body.campaigns).toHaveLength(2);
  });
});
