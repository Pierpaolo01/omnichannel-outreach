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
    expect((await api.get<NeedsAttention>("/api/needs-attention")).body).toEqual({ overdueCallbacks: [], stalledInboxes: [], heldTracks: [], accountWaits: [], senderProblems: [], heldCapacity: [], anomalies: [] });
  });
});

describe("saving the definition: sessions, numbers and the base revision (ADR 0003 1.1.1)", () => {
  const body = (subject: string, save?: { session: string; seq: number; base: number }, bodyText = "Hello.") => ({
    timezone: "Europe/London",
    emailPool: [],
    tracks: [track({ steps: [{ id: "s1", waitDays: 0, subject, body: bodyText, threading: "new_subject" }] })],
    ...(save ? { save } : {}),
  });
  const code = async (res: Response) => ((await res.json()) as ApiError).error.code;
  const subject = async (api: ReturnType<typeof testApi>, id: string) => (await api.get<SequenceView>(`/api/campaigns/${id}/sequence`)).body;

  async function fresh() {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/London");
    return { api, id: campaign.id };
  }

  test("a session's first save starts from the stored revision; its later saves continue the session", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("One", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    // Continuing the session: the base it last saw no longer matters, the number does.
    expect((await put(api, id, body("Two", { session: "A", seq: 3, base: 0 }))).status).toBe(200);
    expect((await subject(api, id)).definition.tracks[0]!.steps[0]!.subject).toBe("Two");
  });

  test("a later save of the same session that arrives first leaves the older one superseded (B6)", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("Newest", { session: "A", seq: 2, base: 0 }))).status).toBe(200);
    const late = await put(api, id, body("Older", { session: "A", seq: 1, base: 0 }));
    expect([late.status, await code(late)]).toEqual([409, "superseded"]);
    expect((await subject(api, id)).definition.tracks[0]!.steps[0]!.subject).toBe("Newest");
  });

  test("the same session and number with the same content is a retry after a lost answer: it succeeds and changes nothing (B8)", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("Kept", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    const retry = await put(api, id, body("Kept", { session: "A", seq: 1, base: 0 }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as SequenceView).definitionVersion).toBe(1);
  });

  test("the same session and number with other content is a conflict", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("Kept", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    const clash = await put(api, id, body("Other", { session: "A", seq: 1, base: 0 }));
    expect([clash.status, await code(clash)]).toEqual([409, "edit_conflict"]);
  });

  test("a stale tab, based on a revision another tab has replaced, is refused and overwrites nothing (B7)", async () => {
    const { api, id } = await fresh();
    // Both tabs load revision 0. Tab B saves; tab A, still on revision 0, saves later.
    expect((await put(api, id, body("Tab B protected subject", { session: "B", seq: 1, base: 0 }))).status).toBe(200);
    const stale = await put(api, id, body("Old subject", { session: "A", seq: 9, base: 0 }, "Tab A later body"));
    expect([stale.status, await code(stale)]).toEqual([409, "edit_conflict"]);
    const stored = await subject(api, id);
    expect([stored.definition.tracks[0]!.steps[0]!.subject, stored.definitionVersion]).toEqual(["Tab B protected subject", 1]);
    // Once tab A has loaded revision 1, its save starts from the stored revision and is accepted.
    expect((await put(api, id, body("Tab A after loading", { session: "A", seq: 10, base: 1 }))).status).toBe(200);
  });

  test("a save with no session (an API client, a test) is stored as before", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("Session", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    expect((await put(api, id, body("No session"))).status).toBe(200);
    expect((await subject(api, id)).definition.tracks[0]!.steps[0]!.subject).toBe("No session");
  });

  test("a definition larger than 56 KiB is refused, so a save on leaving can always carry one (boundary)", async () => {
    const { api, id } = await fresh();
    const big = { ...body("Big", { session: "A", seq: 1, base: 0 }), tracks: [track({ steps: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, waitDays: n === 1 ? 0 : 1, subject: n === 1 ? "Big" : "", body: "x".repeat(15_000), threading: n === 1 ? "new_subject" : "continue_thread" })) })] };
    const res = await put(api, id, big);
    expect([res.status, await code(res)]).toEqual([413, "too_large"]);
  });

  test("launch starts only the revision the page shows", async () => {
    const { api, id } = await fresh();
    expect((await put(api, id, body("Shown", { session: "A", seq: 1, base: 0 }))).status).toBe(200);
    const res = await api.post<ApiError>(`/api/campaigns/${id}/launch`, { definitionVersion: 0 });
    expect([res.status, res.body.error.code]).toEqual([409, "changed_elsewhere"]);
  });
});

describe("the answers are the rows written, not read afterwards (PR 41 council, item 4)", () => {
  const body = (subject: string, save: { session: string; seq: number; base: number }) => ({
    timezone: "Europe/London",
    emailPool: [],
    tracks: [track({ steps: [{ id: "s1", waitDays: 0, subject, body: "Hello.", threading: "new_subject" }] })],
    save,
  });

  test("a save answers with the definition it stored, even if another tab's save commits right after it", async () => {
    const api = testApi();
    const campaign = await api.createCampaign("Autumn", "Europe/London");
    const engine = api.store.engine;
    const save = engine.saveDefinition.bind(engine);
    let raced = false;
    engine.saveDefinition = async (...args) => {
      const out = await save(...args);
      if (!raced) {
        raced = true;
        // Another tab's save, based on the revision just stored, commits before the answer is built.
        await save(args[0], { ...args[1], tracks: [{ ...args[1].tracks[0]!, steps: [{ ...args[1].tracks[0]!.steps[0]!, subject: "Other tab" }] }] }, args[2], { session: "B", seq: 1, base: 1 });
      }
      return out;
    };
    const res = await put(api, campaign.id, body("Mine", { session: "A", seq: 1, base: 0 }));
    const view = (await res.json()) as SequenceView;
    expect([view.definition.tracks[0]!.steps[0]!.subject, view.definitionVersion]).toEqual(["Mine", 1]);
  });
});
