/**
 * Hand-written regressions that take the engine's rules (ADR 0003 9.2, PR 37 review round 3): the
 * lifecycle tests run them with the real rules, and the mutation oracle runs each with the broken
 * rules of a mutation the generated test does not reach, which must make it fail.
 */
import { expect } from "vitest";
import { ENGINE_PARAMS } from "../../src/domain/sequence/attempt.ts";
import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { AccountStatus } from "../../src/server/engine/ports.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { EnrollmentView, NeedsAttention } from "../../src/shared/api.ts";
import { EngineHarness } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import { ScriptedEmailPort } from "./scripted-email-port.ts";

/** The rules the scenario runs with: the real ones, or a mutation's. */
let current: Partial<Rules> | undefined;
const withRules = () => (current ? { rules: current } : {});

export const MIN = 60_000;
export const H = 60 * MIN;
export const DAY = 24 * H;
export const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
export const { SETTLING, MAX_QUEUED_LOOKUPS } = ENGINE_PARAMS;

export const inbox = (id: string, fields: Partial<AccountStatus> = {}): AccountStatus => ({
  id,
  channel: "email",
  label: id,
  capacity: 30,
  gapMs: MIN,
  k: 1,
  healthy: true,
  resetZone: "UTC",
  quotaAvailable: true,
  ...fields,
});

export const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({
  id,
  waitDays: 0,
  subject: "",
  body: "A note for {{company}}.",
  threading: "continue_thread",
  removed: false,
  ...fields,
});

export const twoSteps = (pool = ["inbox-a"]): CampaignDefinition => ({
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: pool,
  tracks: [
    {
      id: "t1",
      channel: "email",
      branch: "main",
      window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })),
      steps: [step("s1", { subject: "Hello", threading: "new_subject" }), step("s2", { waitDays: 1 })],
      start: { kind: "entry" },
      removed: false,
    },
  ],
});

export const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
];

/** Immediately-settling port waits: a wait that has not resolved by the next turn counts as timed out. */
export const quickWaits = { waitFor: <T,>(promise: Promise<T>, _ms: number, timedOut: T) => Promise.race([promise, new Promise<T>((resolve) => setImmediate(() => resolve(timedOut)))]) };

export async function launched(accounts: AccountStatus[], people = [PEOPLE[0]!], definition = twoSteps()) {
  let clock = MONDAY_9 - H;
  const port = new ScriptedEmailPort(() => clock, accounts);
  const h = new EngineHarness({ ...withRules(), start: clock, accounts: [], port, engine: quickWaits });
  Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
  const { campaign } = await h.createCampaign("Round one", { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people });
  await h.tick();
  await h.defineSequence(campaign.id, definition);
  return { h, port, campaign, start: async () => {
    clock = MONDAY_9;
    const res = await h.launch(campaign.id);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    const rows = (await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    return (name: string) => rows.find((r) => r.name === name)?.enrollments[0]?.id ?? "";
  } };
}

/** a send for a withdrawn attempt's key, arriving while its inheritor is claimed, settles on the original work (review: Opus 4, GPT P1) */
export async function sendSettlesOnOriginalWork(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "unknown", sendAfter: 30 * MIN });
    const answer = port.handover.bind(port);
    port.handover = async (request) => {
      await answer(request);
      return { kind: "unknown" };
    };
    port.lookupOverride = (work, now) => (work && now < MONDAY_9 + 40 * MIN ? { kind: "not-sent" } : null);
    const lead = await start();
    // After the third call is refused a retry, the lookup's not-sent withdraws it; the inheritor cannot get a pre-send check.
    await h.advanceTo(MONDAY_9 + 20 * MIN);
    port.presend = () => Promise.resolve({ kind: "unavailable" });
    await h.advanceTo(MONDAY_9 + 35 * MIN);
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    const sent = s.attempts.filter((a) => a.state === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.handedWall).toBe(MONDAY_9);
    expect(s.results).toEqual([expect.objectContaining({ stepId: "s1", atWall: MONDAY_9 + 30 * MIN, attemptId: sent[0]!.id })]);
    expect(s.attempts.filter((a) => a.state !== "sent").every((a) => a.state === "withdrawn")).toBe(true);
  } finally {
    current = undefined;
  }
}

/** unknown, then not-sent: the keyed attempt is withdrawn as lookup_not_sent and keeps when it became unresolved (review: Opus 3, GPT P2) */
export async function unresolvedThenNotSent(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    let lookups = 0;
    port.lookupOverride = () => (++lookups === 1 ? { kind: "unknown" } : { kind: "not-sent" });
    const lead = await start();
    // No pre-send check from then on, so no inheritor is handed over before the work is read.
    await h.advanceTo(MONDAY_9 + SETTLING + MIN);
    port.presend = () => Promise.resolve({ kind: "unavailable" });
    await h.advanceTo(MONDAY_9 + 2 * SETTLING + MIN);
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(s.attempts[0]).toMatchObject({ state: "withdrawn", endedBy: "lookup_not_sent" });
    expect(s.work[0]?.unresolvedSince).toBe(MONDAY_9 + SETTLING);
  } finally {
    current = undefined;
  }
}

/** attempt.ts:81: a late acceptance during a pending retry still reaches lookup and settles, freeing the inbox's in-flight place */
export async function lateAcceptanceSettles(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a", { gapMs: 2 * MIN })]);
    // The response is lost; nothing is observable; the work is queued at the provider.
    port.onCall = () => ({ answer: "unknown", sendAfter: null });
    port.lookupOverride = () => ({ kind: "queued" });
    await start();
    const [attempt] = await h.store.engine.openAttempts();
    expect(attempt).toMatchObject({ state: "handed", retry: "wanted" });
    h.clock += 1000;
    await h.engine.receiveLateAnswer(attempt!.id, { kind: "accepted", providerRef: "msg-1" });
    await h.advanceTo(MONDAY_9 + 4 * H);
    const after = await h.store.engine.attempt(attempt!.id);
    expect(after).toMatchObject({ state: "accepted", retry: "none" });
    expect((await h.store.engine.work(after!.idempotencyKey))!.queuedLookups).toBeGreaterThan(10);
  } finally {
    current = undefined;
  }
}

/** rules.ts:62: a re-import that gives a phone-only lead an email between evaluation and apply is not overwritten by the stale ending */
export async function reimportBeatsStaleEnding(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const h = new EngineHarness({ ...withRules(), start: MONDAY_9 - H, accounts: [{ id: "inbox-a", capacity: 30, gapMs: MIN, k: 1, healthy: true, quotaAvailable: true, resetZone: "UTC" }], engine: quickWaits });
    const businesses = [business({ business_id: "b1", business_name: "Harbour Lane Physio" })];
    const { campaign } = await h.createCampaign("Race", { businesses, people: [PEOPLE[0]!] });
    await h.tick();
    await h.defineSequence(campaign.id, twoSteps());
    h.clock = MONDAY_9;
    await h.launch(campaign.id);
    // A phone-only person is enrolled after launch; while the engine evaluates them, a re-import gives them an email.
    const omarPhone = person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", dial_phone: "+447700900104", dial_phone_type: "mobile" });
    const omarEmail = person({ person_id: "p4", business_id: "b1", full_name: "Omar Reed", email: "omar@harbour.example" });
    let raced = false;
    h.hooks = {
      beforeApplyEvaluation: async (subjectId) => {
        if (raced || (await h.store.engine.subject(subjectId, h.clock))?.lead.details.some((d) => d.channel === "email")) return;
        raced = true;
        await h.reimport(campaign.id, { businesses, people: [PEOPLE[0]!, omarEmail] });
      },
    };
    h.clock = MONDAY_9 + H;
    await h.reimport(campaign.id, { businesses, people: [PEOPLE[0]!, omarPhone] });
    await h.advanceTo(MONDAY_9 + DAY);
    expect(raced).toBe(true);
    const rows = (await h.request<{ rows: { name: string; enrollments: EnrollmentView[] }[] }>("GET", "/api/leads")).body.rows;
    const omar = rows.find((r) => r.name === "Omar Reed")!.enrollments[0]!.id;
    expect((await h.progress(omar)).status).not.toBe("finished_no_usable_channel");
    expect(h.fake.deliveryLog.some((d) => d.subjectId === omar)).toBe(true);
  } finally {
    current = undefined;
  }
}

/** a reply on a thread the app never learns falls back after one settling period to work sent at or before it, pausing that inbox's sends to the address meanwhile; refused work and work handed after the reply are not matched */
export async function fallbackScopeAndPause(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    let clock = MONDAY_9 - H;
    const port = new ScriptedEmailPort(() => clock, [inbox("inbox-a")]);
    const h = new EngineHarness({ ...withRules(), start: clock, accounts: [], port, engine: quickWaits });
    Object.defineProperty(h, "clock", { get: () => clock, set: (v: number) => (clock = v) });
    const rows = { businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" })], people: [PEOPLE[0]!] };
    const sent = await h.createCampaign("Sent", rows);
    const refused = await h.createCampaign("Refused", rows);
    const later = await h.createCampaign("Later", rows);
    await h.tick();
    for (const c of [sent, refused, later]) await h.defineSequence(c.campaign.id, twoSteps());
    const leadOf = async (c: typeof sent) => (await h.store.engine.subjectsOf(c.campaign.id))[0]!;
    port.onCall = (request) => (request.subjectId === refusedLead ? { answer: "rejected", sendAfter: null } : { answer: "accepted", sendAfter: 0 });
    let refusedLead = "";
    clock = MONDAY_9;
    await h.launch(sent.campaign.id);
    refusedLead = await leadOf(refused);
    clock = MONDAY_9 + 2 * MIN;
    await h.launch(refused.campaign.id);
    expect(port.calls.map((c) => c.request.subjectId)).toEqual([await leadOf(sent), refusedLead]);
    // At 10:00 a reply arrives on a thread no message of the app's has.
    clock = MONDAY_9 + H;
    port.events.push({ visibleAt: clock, event: { id: "reply-x", kind: "reply", providerRef: "thread-unknown", at: clock, inbox: "inbox-a", from: "pat@harbour.example" } });
    await h.tick();
    // A campaign launched while the reply is pending is paused for that inbox and address.
    clock = MONDAY_9 + H + 5 * MIN;
    await h.launch(later.campaign.id);
    await h.advanceTo(MONDAY_9 + H + SETTLING - MIN);
    const pausedLead = await leadOf(later);
    expect(port.calls.filter((c) => c.request.subjectId === pausedLead)).toEqual([]);
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect((await h.progress(await leadOf(sent))).status).toBe("replied");
    expect((await h.progress(refusedLead)).status).not.toBe("replied");
    expect((await h.progress(await leadOf(later))).status).not.toBe("replied");
    const laterLead = await leadOf(later);
    const laterCalls = port.calls.filter((c) => c.request.subjectId === laterLead);
    expect(laterCalls.length).toBeGreaterThan(0);
    expect(laterCalls[0]!.at).toBeGreaterThanOrEqual(MONDAY_9 + H + SETTLING);
  } finally {
    current = undefined;
  }
}

/** lookup confirms a send whose sent event never arrives: the live attempt carries the reference at once, and the continue-thread follow-up is called with it */
export async function lookupSentKeepsThread(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "unknown", sendAfter: 0, eventDelay: Infinity });
    const call = port.handover.bind(port);
    port.handover = async (request) => {
      await call(request);
      return { kind: "unknown" };
    };
    const lead = await start();
    // Retries take the three calls; the lookup a settling period after the last one confirms the send.
    await h.advanceTo(MONDAY_9 + 2 * SETTLING);
    const s1 = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts.find((a) => a.stepId === "s1");
    expect(s1).toMatchObject({ state: "sent", endedBy: "lookup" });
    expect((await h.store.engine.work(s1!.idempotencyKey))?.providerRef).toBe("msg-1");
    await h.advanceTo(MONDAY_9 + 3 * DAY);
    expect(port.calls.filter((c) => c.request.stepId === "s2").map((c) => c.request.threadRef)).toEqual(["msg-1"]);
  } finally {
    current = undefined;
  }
}

/** Work the provider accepts and holds is looked up until MAX_QUEUED_LOOKUPS queued answers, then unresolved, and cannot be marked not sent while queued. */
export async function acceptedWorkSettles(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    port.lookupOverride = () => ({ kind: "queued" });
    await start();
    await h.advanceTo(MONDAY_9 + SETTLING * (MAX_QUEUED_LOOKUPS + 2));
    const [attempt] = await h.store.engine.openAttempts();
    const work = await h.store.engine.work(attempt!.idempotencyKey);
    expect(work).toMatchObject({ lookupAnswer: "queued", unresolvedSince: MONDAY_9 + SETTLING * MAX_QUEUED_LOOKUPS });
    expect(await h.engine.markAttempt(attempt!.id, "not_sent")).toBe(false);
  } finally {
    current = undefined;
  }
}
/** progress.ts:387 (review bot on 0dc88ab): when work settles, its claimed inheritor is withdrawn in the same change and never handed over; a provider skip still holds the track. */
export async function claimedInheritorRetired(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a")]);
    // The opener is accepted and never sent; the lookup at 09:15 says not sent, so an inheritor takes its key.
    port.onCall = () => ({ answer: "accepted", sendAfter: null });
    port.lookupOverride = () => ({ kind: "not-sent" });
    const lead = await start();
    // No pre-send check, so the inheritor stays claimed.
    port.presend = () => Promise.resolve({ kind: "unavailable" });
    await h.advanceTo(MONDAY_9 + SETTLING + MIN);
    const before = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    const key = before.attempts[0]!.idempotencyKey;
    expect(before.attempts.map((a) => [a.state, a.idempotencyKey])).toEqual([["withdrawn", key], ["claimed", key]]);
    // At 09:16 the provider reports it skipped the original work, and the pre-send check is back.
    port.events.push({ visibleAt: h.clock, event: { id: "skip-1", kind: "rejected", key, providerRef: port.works[0]!.ref, reason: "provider_skipped" } });
    port.presend = () => Promise.resolve({ kind: "clear" });
    await h.advanceTo(MONDAY_9 + DAY);
    const after = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(after.work[0]?.settled).toBe("rejected");
    expect(after.attempts[1]).toMatchObject({ state: "withdrawn", calls: 0 });
    expect(port.calls).toHaveLength(1);
    expect((await h.store.engine.accounts(h.clock))[0]!.inFlight).toBe(0);
    expect((await h.progress(lead("Pat Oneil"))).tracks[0]?.hold).toBe("provider_skipped");
  } finally {
    current = undefined;
  }
}

/** attempt.ts:218: capacity 1, the work is unresolved and the user marks it not sent: the held capacity is listed, then freed, and the next lead sends that day */
export async function markNotSentFreesCapacity(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a", { capacity: 1 })], PEOPLE);
    // Pat's first work is accepted and never sent; the lookup cannot say. Later work sends at once.
    port.onCall = () => (port.calls.length === 1 ? { answer: "accepted", sendAfter: null } : { answer: "accepted", sendAfter: 0 });
    port.lookupOverride = (work) => (work === port.works[0] ? { kind: "unknown" } : null);
    const lead = await start();
    await h.advanceTo(MONDAY_9 + 2 * H);
    const before = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body;
    const pat = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts[0]!;
    expect(before.heldCapacity).toEqual([{ accountId: "inbox-a", held: 1, capacity: 1, sentToday: 0, work: [expect.objectContaining({ attemptId: pat.id, enrollmentId: lead("Pat Oneil"), stepId: "s1", destination: "pat@harbour.example", unresolvedSince: expect.any(String) })] }]);
    expect(port.deliveries.map((d) => d.subjectId)).toEqual([]);
    expect(await h.engine.markAttempt(pat.id, "not_sent")).toBe(true);
    await h.advanceTo(MONDAY_9 + 3 * H);
    // The freed daily send goes out that day: Pat's step again, under a new key, first by priority.
    expect(port.deliveries.filter((d) => d.at < MONDAY_9 + 15 * H).map((d) => d.subjectId)).toEqual([lead("Pat Oneil")]);
    expect((await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity).toEqual([]);
  } finally {
    current = undefined;
  }
}

/** progress.ts:304: once a key's work settles (the user's not sent on its inheritor), no later attempt inherits it: the next attempt takes a fresh key and sends */
export async function settledKeyNotInherited(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, lead, attempts } = await inheritorUnresolved();
    const listed = (await h.request<NeedsAttention>("GET", "/api/needs-attention")).body.heldCapacity;
    expect(listed[0]!.work.map((w) => w.attemptId)).toEqual([attempts[1]!.id]);
    expect(await h.engine.markAttempt(attempts[1]!.id, "not_sent")).toBe(true);
    port.onCall = () => ({ answer: "accepted", sendAfter: 0 });
    await h.advanceTo(MONDAY_9 + 2 * H);
    const after = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts;
    expect(after[2]!.idempotencyKey).not.toBe(attempts[0]!.id);
    expect(port.deliveries.map((d) => d.subjectId)).toEqual([lead("Pat Oneil")]);
  } finally {
    current = undefined;
  }
}

/** A same-key retry is never called once a withdrawal was requested (5.6): the lead's address goes bad while a retry waits for its slot. */
export async function noRetryAfterWithdraw(rules?: Partial<Rules>): Promise<void> {
  current = rules;
  try {
    const { h, port, start } = await launched([inbox("inbox-a", { gapMs: 10 * MIN })]);
    // The answer is lost and nothing is sent, so a retry is wanted and waits ten minutes for its slot.
    port.onCall = () => ({ answer: "unknown", sendAfter: null });
    port.withdrawAnswer = "unknown";
    const lead = await start();
    const s = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!;
    expect(s.attempts[0]).toMatchObject({ state: "handed", retry: "wanted" });
    // The address is marked bad elsewhere: the track fails and the attempt is asked to withdraw.
    h.clock = MONDAY_9 + MIN;
    await h.store.markContactDetailBad(s.tracks[0]!.destinationDetailId!);
    await h.advanceTo(MONDAY_9 + H);
    expect(port.calls.map((c) => c.at)).toEqual([MONDAY_9]);
  } finally {
    current = undefined;
  }
}

/** Pat's opener is accepted and never sent; the first lookup says not sent, so an inheritor takes its key; later lookups cannot say. */
export async function inheritorUnresolved() {
  const { h, port, start } = await launched([inbox("inbox-a")]);
  port.onCall = () => ({ answer: "accepted", sendAfter: null });
  let lookups = 0;
  port.lookupOverride = () => (++lookups === 1 ? { kind: "not-sent" } : { kind: "unknown" });
  const lead = await start();
  await h.advanceTo(MONDAY_9 + 31 * MIN);
  const attempts = (await h.store.engine.subject(lead("Pat Oneil"), h.clock))!.attempts;
  expect(attempts.map((a) => [a.state, a.endedBy, a.idempotencyKey])).toEqual([["withdrawn", "lookup_not_sent", attempts[0]!.id], ["accepted", null, attempts[0]!.id]]);
  return { h, port, lead, attempts };
}
