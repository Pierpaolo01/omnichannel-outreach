import { describe, expect, test } from "vitest";
import { testApi } from "../../test/support/http.ts";
import type { ApiError, NeedsAttention, SequenceView, SmsProviderStatus } from "../shared/api.ts";

const track = (fields: Record<string, unknown> = {}) => ({
  id: "t1",
  channel: "email",
  branch: "main",
  window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })),
  steps: [
    { id: "s1", waitDays: 0, subject: "Hello {{first_name|there}}", body: "A note for {{company}}.", threading: "new_subject" },
    { id: "s2", waitDays: 2, body: "Following up.", threading: "continue_thread" },
  ],
  ...fields,
});

const put = (api: ReturnType<typeof testApi>, campaignId: string, body: unknown) =>
  api.raw(`/api/campaigns/${campaignId}/sequence`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the sequence interface (tickets 12b and 13)", () => {
  test("a new campaign has an empty sequence in its default zone, and nothing to launch", async () => {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/Paris");
    const { status, body } = await api.get<SequenceView>(`/api/campaigns/${campaign.id}/sequence`);
    expect(status).toBe(200);
    expect(body.definition).toEqual({ timezone: "Europe/Paris", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [] });
    expect(body.launch).toEqual({ blockers: [], nothingToLaunch: true, canLaunch: false });
    expect(body.launchedAt).toBeNull();
    const launch = await api.post<ApiError>(`/api/campaigns/${campaign.id}/launch`, {});
    expect(launch).toEqual({ status: 409, body: { error: { code: "launch_blocked", message: "Add a track to launch." } } });
  });

  test("the running app has no connected email provider yet, so an email track is blocked by the sender blocker", async () => {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/London");
    const saved = await put(api, campaign.id, { timezone: "Europe/London", emailPool: ["any-inbox"], tracks: [track()] });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as SequenceView;
    expect(view.accounts).toEqual([]);
    expect(view.launch.blockers.map((b) => b.message)).toEqual(["The email track has no connected sender inbox."]);
    expect(view.definitionVersion).toBe(1);
    const launch = await api.post<ApiError>(`/api/campaigns/${campaign.id}/launch`, {});
    expect(launch.body.error.message).toBe("Launch is blocked: The email track has no connected sender inbox.");
  });

  test("definitions refused at the boundary come back as one plain message", async () => {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/London");
    const call = await put(api, campaign.id, { timezone: "Europe/London", emailPool: [], tracks: [track(), track({ id: "t2", channel: "call", steps: [] })] });
    expect(call.status).toBe(400);
    expect(((await call.json()) as ApiError).error.message).toContain("The phone track is one call with no follow-ups");
    const circle = await put(api, campaign.id, { timezone: "Europe/London", emailPool: [], tracks: [track({ start: { kind: "after", trackId: "t1", delayDays: 1 } })] });
    expect(((await circle.json()) as ApiError).error).toMatchObject({ code: "invalid_sequence" });
    const malformed = await put(api, campaign.id, { timezone: "Europe/London", tracks: "none" });
    expect(malformed.status).toBe(400);
  });

  test("an SMS track beside email, connected after a delay, is saved with its SMS pool (ticket 13)", async () => {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/London");
    const sms = track({ id: "t2", channel: "sms", steps: [{ id: "m1", waitDays: 0, body: "Hi {{first_name|there}}", threading: "new_subject" }], start: { kind: "after", trackId: "t1", delayDays: 2 } });
    const saved = await put(api, campaign.id, { timezone: "Europe/London", emailPool: ["any-inbox"], smsPool: ["+447700900001"], tracks: [track(), sms] });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as SequenceView;
    expect(view.definition.smsPool).toEqual(["+447700900001"]);
    expect(view.definition.tracks[1]).toMatchObject({ channel: "sms", start: { kind: "after", trackId: "t1", delayDays: 2 } });
    // No provider exists on either channel in the running app: "no connected sender" per channel.
    expect(view.launch.blockers.map((b) => b.message)).toEqual(["The email track has no connected sender inbox.", "The SMS track has no connected sender number."]);
  });

  test("the running app reports that no SMS provider is connected, so an SMS track cannot launch", async () => {
    const api = testApi();
    expect((await api.get<SmsProviderStatus>("/api/sms-provider")).body).toEqual({ provider: "none", message: "No SMS provider is connected, so SMS tracks cannot launch.", numbers: [] });
    const campaign = await api.createCampaign("Texts only", "Europe/London");
    const sms = track({ channel: "sms", steps: [{ id: "m1", waitDays: 0, body: "Hello", threading: "new_subject" }] });
    expect((await put(api, campaign.id, { timezone: "Europe/London", emailPool: [], smsPool: ["+447700900001"], tracks: [sms] })).status).toBe(200);
    const launch = await api.post<ApiError>(`/api/campaigns/${campaign.id}/launch`, {});
    expect(launch).toEqual({ status: 409, body: { error: { code: "launch_blocked", message: "Launch is blocked: The SMS track has no connected sender number." } } });
  });

  test("unknown campaigns and enrollments are 404s; Needs attention starts empty", async () => {
    const api = testApi();
    expect((await api.get("/api/campaigns/nope/sequence")).status).toBe(404);
    expect((await api.get("/api/enrollments/nope")).status).toBe(404);
    expect((await put(api, "nope", { timezone: "UTC", emailPool: [], tracks: [] })).status).toBe(404);
    expect((await api.get<NeedsAttention>("/api/needs-attention")).body).toEqual({ stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [] });
  });
});
