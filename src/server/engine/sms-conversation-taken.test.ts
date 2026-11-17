import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { FakeNumber } from "../../../test/support/fake-sms-port.ts";
import { TRACK_MUTATIONS } from "../../../test/support/track-mutations.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { Rules } from "./rules.ts";
import type { ActivityView, LeadSearchResult, NeedsAttention } from "../../shared/api.ts";

/**
 * Question Q7 answered (ADR 0003, 15 November 2026): a mobile whose SMS conversation on every number a campaign may use
 * belongs to another campaign has that campaign's SMS track skipped, with the reason shown, like a missing channel.
 * Through the real HTTP app, SQLite store and engine, against the fake email provider and the fake SMS provider. No SMS
 * provider exists; the fake is a test double. Data is fictitious.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const N1 = "+447700900001";
const N2 = "+447700900002";
const PAT_MOBILE = "+447700900101";
const NIA_MOBILE = "+447700900102";
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
/** Tuesdays only, all day, London. */
const TUESDAY = [{ day: 2, start: 0, end: 24 }];

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "Hello {{first_name|there}}", body: `Email ${id}.`, threading: "new_subject", removed: false });
const text = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: "", body: `Text ${id}, {{first_name|there}}.`, threading: "new_subject", removed: false });
const track = (id: string, channel: "email" | "sms", steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }, window = ALWAYS): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window,
  steps,
  start,
  removed: false,
});
const after = (trackId: string, delayDays: number) => ({ kind: "after" as const, trackId, delayDays });
const definition = (tracks: TrackDefinition[], smsPool: string[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool, tracks });
const number = (id: string, fields: Partial<FakeNumber> = {}): FakeNumber => ({ id, capacity: 50, gapMs: MIN, k: 2, healthy: true, resetZone: "Europe/London", ...fields });

const PAT = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" });
const PAT_NO_EMAIL = person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", dial_phone: PAT_MOBILE, dial_phone_type: "mobile" });
const NIA = person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", dial_phone: NIA_MOBILE, dial_phone_type: "mobile" });
const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });

async function world(options: { numbers?: FakeNumber[]; rules?: Partial<Rules> } = {}) {
  const h = new EngineHarness({
    start: MONDAY_9 - H,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: options.numbers ?? [number(N1), number(N2)] },
    ...(options.rules ? { rules: options.rules } : {}),
  });
  await h.tick();
  h.clock = MONDAY_9;
  const ids: Record<string, string> = {};
  /** Creates a campaign with these tracks for these people and launches it now; returns each person's enrollment id. */
  const campaign = async (name: string, tracks: TrackDefinition[], smsPool: string[], people = [PAT]) => {
    const { campaign: c } = await h.createCampaign(name, { businesses: [HARBOUR], people });
    ids[name] = c.id;
    await h.defineSequence(c.id, definition(tracks, smsPool));
    const launched = await h.launch(c.id);
    if (launched.status !== 200) throw new Error(`launch refused: ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    return (who: string) => rows.find((r) => r.name === who)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  };
  /** Saves a changed definition of a running campaign, as the editor does. */
  const edit = async (name: string, tracks: TrackDefinition[], smsPool: string[]) => h.defineSequence(ids[name]!, definition(tracks, smsPool));
  const texts = (to: string) => h.sms.deliveryLog.filter((d) => d.destination === to);
  const emails = (to: string) => h.fake.deliveryLog.filter((d) => d.destination === to);
  const activity = async (who: string) => {
    const row = (await h.request<LeadSearchResult>("GET", `/api/leads?q=${encodeURIComponent(who)}`)).body.rows.find((r) => r.name === who)!;
    return (await h.request<ActivityView>("GET", `/api/people/${row.id}/activity`)).body.entries;
  };
  const attention = async () => (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
  return { h, campaign, edit, texts, emails, activity, attention, ids };
}

describe("a mobile whose conversation is taken on every number skips the SMS track (ADR 0003 question Q7 answered)", () => {
  test("the second campaign's SMS track is skipped with the owner named, its email starts after its delay from the skip, nothing is held, and a late reply stops only the owner", async () => {
    const { h, campaign, texts, emails, activity, attention } = await world();
    const a = await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    h.clock = MONDAY_9 + 2 * H;
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")], after("t1", 1))], [N1]);
    await h.advanceTo(MONDAY_9 + 3 * H);

    expect(texts(PAT_MOBILE).map((d) => d.subjectId)).toEqual([a("Pat Oneil")]);
    const skipped = await h.progress(b("Pat Oneil"));
    expect(skipped.tracks[0]).toMatchObject({ trackId: "t1", finishReason: "skipped_conversation_taken", finishedAt: new Date(MONDAY_9 + 2 * H).toISOString(), hold: null, conversationOwners: [{ name: "Spring clinics", test: false, lead: null }] });
    const held = await attention();
    expect(held.heldTracks).toEqual([]);

    // The email track waits one calendar day in the prospect's zone, counted from the skip: Tuesday 00:00 London.
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(emails("pat@harbour.example").map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-03T00:00:00.000Z"]);
    expect((await h.progress(b("Pat Oneil"))).status).toBe("sequence_finished_no_response");

    const entries = (await activity("Pat Oneil")).filter((e) => e.campaign.name === "Autumn clinics");
    expect(entries).toContainEqual(expect.objectContaining({ kind: "skipped", channel: "sms", stepNumber: null, reason: "sms_conversation_taken", owners: [{ name: "Spring clinics", test: false, lead: null }] }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "released", channel: "email", because: "skipped" }));

    // A late answer on the conversation reaches its owner only, after both have ended.
    h.sms.prospectTexts(PAT_MOBILE, "Who is this?");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(a("Pat Oneil"))).status).toBe("replied");
    expect((await h.progress(b("Pat Oneil"))).status).toBe("sequence_finished_no_response");
  });

  test("a running second campaign is never stopped by a reply on the conversation its SMS track skipped", async () => {
    const { h, campaign, attention } = await world();
    const a = await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")], after("t1", 3))], [N1]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]?.finishReason).toBe("skipped_conversation_taken");
    h.sms.prospectTexts(PAT_MOBILE, "STOP");
    await h.advanceTo(MONDAY_9 + 3 * H);
    expect((await h.progress(a("Pat Oneil"))).status).toBe("replied");
    const running = await h.progress(b("Pat Oneil"));
    expect(running.status).toBe("queued");
    expect(running.reply).toBeNull();
    expect((await attention()).heldTracks).toEqual([]);
  });

  test("the skip waits for the moment of the handover: a number that joins the pool before the window opens is used", async () => {
    const { h, campaign, edit, texts } = await world();
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const tracks = [track("t1", "sms", [text("m1")], { kind: "entry" }, TUESDAY)];
    const b = await campaign("Autumn clinics", tracks, [N1]);
    // Monday: due, but its window is shut, so no handover would happen yet and nothing is decided.
    await h.advanceTo(MONDAY_9 + 6 * H);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: null, hold: null });
    await edit("Autumn clinics", tracks, [N1, N2]);
    await h.advanceTo(MONDAY_9 + DAY + 6 * H);
    expect(texts(PAT_MOBILE).map((d) => [d.subjectId, d.sender, new Date(d.at).toISOString()])).toContainEqual([b("Pat Oneil"), N2, "2026-11-03T00:00:00.000Z"]);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]?.finishReason).toBe("completed");
  });

  test("with the window shut and no number joining, the skip happens when the window opens", async () => {
    const { h, campaign } = await world();
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")], { kind: "entry" }, TUESDAY), track("t2", "email", [email("s1")], after("t1", 0))], [N1]);
    await h.advanceTo(MONDAY_9 + DAY + 6 * H);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: "2026-11-03T00:00:00.000Z" });
  });

  test("the skip is final: a free number that joins the pool afterwards does not reopen the track", async () => {
    const { h, campaign, edit, texts } = await world();
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const tracks = [track("t1", "sms", [text("m1"), text("m2", 1)]), track("t2", "email", [email("s1")], after("t1", 2))];
    const b = await campaign("Autumn clinics", tracks, [N1]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const before = (await h.progress(b("Pat Oneil"))).tracks[0];
    expect(before?.finishReason).toBe("skipped_conversation_taken");
    await edit("Autumn clinics", tracks, [N1, N2]);
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(texts(PAT_MOBILE).filter((d) => d.subjectId === b("Pat Oneil"))).toEqual([]);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: before?.finishedAt });
  });

  test("a free number with no room today is a wait for capacity, not a skip: the text goes from it the next day", async () => {
    const { h, campaign, texts } = await world({ numbers: [number(N1), number(N2, { capacity: 1 })] });
    // Nia takes N2's one text today in another campaign; Pat's conversation on N1 belongs to Spring clinics.
    await campaign("Winter clinics", [track("t1", "sms", [text("m1")])], [N2], [NIA]);
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")])], [N1, N2]);
    await h.advanceTo(MONDAY_9 + 6 * H);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: null, hold: null });
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(texts(PAT_MOBILE).filter((d) => d.subjectId === b("Pat Oneil")).map((d) => [d.sender, new Date(d.at).toISOString()])).toEqual([[N2, "2026-11-03T00:00:00.000Z"]]);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]?.finishReason).toBe("completed");
  });

  test("an unhealthy free number is an account wait, not a skip: the text goes once it can send", async () => {
    const { h, campaign, texts } = await world({ numbers: [number(N1), number(N2, { healthy: false })] });
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")])], [N1, N2]);
    await h.advanceTo(MONDAY_9 + 6 * H);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: null, hold: null });
    h.sms.numbers.get(N2)!.healthy = true;
    await h.advanceTo(MONDAY_9 + 7 * H);
    expect(texts(PAT_MOBILE).filter((d) => d.subjectId === b("Pat Oneil")).map((d) => d.sender)).toEqual([N2]);
  });

  test("a lead whose only remaining channel was that SMS track finishes with no usable channel, and Needs attention says why", async () => {
    const { h, campaign, attention, activity } = await world();
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1], [PAT_NO_EMAIL]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")], after("t1", 1))], [N1], [PAT_NO_EMAIL]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    const ended = await h.progress(b("Pat Oneil"));
    expect(ended).toMatchObject({ status: "finished_no_usable_channel", endedAt: new Date(MONDAY_9 + H).toISOString() });
    const entry = (await attention()).noUsableChannel.find((x) => x.enrollmentId === b("Pat Oneil"));
    expect(entry?.channels).toEqual([
      { channel: "sms", why: "conversation_taken", owners: [{ name: "Spring clinics", test: false, lead: null }] },
      { channel: "email", why: "missing", owners: [] },
    ]);
    const entries = (await activity("Pat Oneil")).filter((e) => e.campaign.name === "Autumn clinics").map((e) => e.kind);
    expect(entries).toEqual(expect.arrayContaining(["skipped", "ended"]));
  });

  test("a second SMS track later in the sequence still runs, from a number that joined the pool before its moment", async () => {
    const { h, campaign, edit, texts } = await world();
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1], [PAT_NO_EMAIL]);
    await h.advanceTo(MONDAY_9 + H);
    const tracks = [track("t1", "sms", [text("m1")]), track("t2", "sms", [text("n1")], after("t1", 2))];
    const b = await campaign("Autumn clinics", tracks, [N1], [PAT_NO_EMAIL]);
    await h.advanceTo(MONDAY_9 + 2 * H);
    // The first SMS track is skipped; the second is still to run, so SMS still reaches Pat and the lead runs on.
    const first = await h.progress(b("Pat Oneil"));
    expect(first.status).toBe("queued");
    expect(first.tracks.map((t) => t.finishReason)).toEqual(["skipped_conversation_taken", null]);
    await edit("Autumn clinics", tracks, [N1, N2]);
    await h.advanceTo(MONDAY_9 + 4 * DAY);
    expect(texts(PAT_MOBILE).filter((d) => d.subjectId === b("Pat Oneil")).map((d) => [d.stepId, d.sender])).toEqual([["n1", N2]]);
    expect((await h.progress(b("Pat Oneil"))).status).toBe("sequence_finished_no_response");
  });

  test("a track that has already texted from its number is unaffected when another campaign takes the conversation on the other number", async () => {
    const { h, campaign, texts } = await world();
    const a = await campaign("Spring clinics", [track("t1", "sms", [text("m1"), text("m2", 1)])], [N1, N2]);
    await h.advanceTo(MONDAY_9 + H);
    // Autumn clinics takes the other number's conversation with Pat; Spring clinics keeps its own.
    await campaign("Autumn clinics", [track("t1", "sms", [text("m1")])], [N1, N2]);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(texts(PAT_MOBILE).filter((d) => d.subjectId === a("Pat Oneil")).map((d) => [d.stepId, d.sender])).toEqual([["m1", N1], ["m2", N1]]);
    expect((await h.progress(a("Pat Oneil"))).tracks[0]?.finishReason).toBe("completed");
  });

  test("a lead whose evaluation the worker cached is skipped in the tick in which another lead takes the conversation, not at its next wake (review bot on bebdc06)", async () => {
    // Both campaigns' texts fall due at 09:00, when the window opens, on the one number. Autumn clinics' lead is evaluated
    // and cached from 08:01; at 09:00 Spring clinics' lead takes the conversation, and nothing of Autumn's lead changes.
    const NINE_TO_FIVE = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 9, end: 17 }));
    const { h, campaign, texts, emails } = await world({ numbers: [number(N1, { k: 1 })] });
    h.clock = MONDAY_9 - H;
    await campaign("Spring clinics", [track("t1", "sms", [text("m1")], { kind: "entry" }, NINE_TO_FIVE)], [N1]);
    h.clock = MONDAY_9 - H + MIN;
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")], { kind: "entry" }, NINE_TO_FIVE), track("t2", "email", [email("s1")], after("t1", 1))], [N1]);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    expect(texts(PAT_MOBILE).map((d) => [d.sender, new Date(d.at).toISOString()])).toEqual([[N1, "2026-11-02T09:00:00.000Z"]]);
    expect((await h.progress(b("Pat Oneil"))).tracks[0]).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: "2026-11-02T09:00:00.000Z" });
    // One calendar day after the skip, London: Tuesday 00:00.
    expect(emails("pat@harbour.example").map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-03T00:00:00.000Z"]);
  });

  test("leads held under the interim are skipped at the first tick after the upgrade, their waiting tracks start after their delay from it, and nothing is sent twice", async () => {
    // The interim engine left a taken conversation unskipped; its one changed rule is `evaluate`.
    const interim: { -readonly [K in keyof Rules]?: Rules[K] } = { evaluate: TRACK_MUTATIONS["held instead of skipped"]!.rules.evaluate! };
    const { h, campaign, texts, emails } = await world({ rules: interim });
    const a = await campaign("Spring clinics", [track("t1", "sms", [text("m1")])], [N1]);
    await h.advanceTo(MONDAY_9 + H);
    const b = await campaign("Autumn clinics", [track("t1", "sms", [text("m1")]), track("t2", "email", [email("s1")], after("t1", 1))], [N1]);
    await h.advanceTo(MONDAY_9 + 2 * DAY);
    // Held under the interim engine: nothing finished, nothing sent.
    const held = await h.store.engine.subject(b("Pat Oneil"), h.clock);
    expect(held?.tracks.find((t) => t.trackId === "t1")?.finishReason).toBeNull();
    expect(emails("pat@harbour.example")).toEqual([]);

    // The upgrade: the same database under the engine as built.
    delete interim.evaluate;
    h.clock = Date.parse("2026-11-04T10:00:00Z");
    await h.restart();
    await h.tick();
    const upgraded = await h.progress(b("Pat Oneil"));
    expect(upgraded.tracks[0]).toMatchObject({ finishReason: "skipped_conversation_taken", finishedAt: "2026-11-04T10:00:00.000Z" });
    await h.advanceTo(Date.parse("2026-11-08T00:00:00Z"));
    // One calendar day after the skip, in London: Thursday 00:00. Once.
    expect(emails("pat@harbour.example").map((d) => new Date(d.at).toISOString())).toEqual(["2026-11-05T00:00:00.000Z"]);
    expect(texts(PAT_MOBILE).map((d) => d.subjectId)).toEqual([a("Pat Oneil")]);
  });
});
