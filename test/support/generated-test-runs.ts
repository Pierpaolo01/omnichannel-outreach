import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { CampaignDefinition, DeclinedPath, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CallsView, LeadSearchResult, TestRunTab } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { DeliveryLogEntry, HandoverLogEntry } from "./fake-email-port.ts";
import { random } from "./generated-sequences.ts";

/**
 * Generated test runs (ticket 21; ADR 0003 "Ticket 21", the generated test). One campaign with an email track and an
 * SMS track (together, or one after the other), in some runs a phone track after the email track with a declined path
 * and a win-back branch; two or three fictitious leads; one inbox and one SMS number with small capacities and pacing
 * gaps the leads and the tests share. At random instants the generated user saves test contacts (now and then one a
 * lead has), runs a test (now and then while one runs), stops it, replies from a test contact or a lead, logs a test
 * call's outcome, edits the copy, launches, pauses and resumes, and lets time pass.
 *
 * The record imports nothing from src/domain/sequence: it keeps the leads' addresses, the contacts it saved, the edits
 * and Run tests it saw accepted, the replies it made, and reads the providers' logs. After every event it checks T1 to
 * T9 and returns each failure as "T<n>: …".
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
const INBOX = "inbox-a";
const NUMBER = "+447700900900";
const OWN_EMAIL = "alex.own@personal-mail.example";
const OWN_MOBILE = "+447700900456";
/** A test step goes this long after its predecessor at most, when nothing holds it and its sender has room (T6). */
const PROMPT_MS = 30 * MIN;

export interface TestRunOptions {
  readonly rules?: Partial<Rules>;
  /** Changes the world after it is built: a mutation of the store, the providers or the database. */
  readonly patch?: (h: EngineHarness, world: { readonly leadEmails: readonly string[]; readonly renderAsOf: (runId: string) => string | null }) => void;
  readonly maxWrites?: number;
}

export interface TestRunStats {
  readonly features: readonly string[];
}

/** The invariant a failure names: "T4: …" names T4. */
export const testRunInvariantOf = (problem: string): string => /^(T\d+)/.exec(problem)?.[1] ?? "";

const step = (id: string, waitDays: number, rand: () => number): StepDefinition => ({
  id,
  waitDays,
  subject: `Subject ${id}`,
  body: `Hello {{first_name|there}}, message ${id} for {{company}} (${Math.floor(rand() * 1000)}).`,
  threading: "new_subject",
  removed: false,
});
const callStep = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });

interface Lead {
  readonly name: string;
  readonly email: string | null;
  readonly mobile: string | null;
}

/** One run of the generated user against the app. */
export async function runTestRuns(seed: number, options: TestRunOptions = {}): Promise<{ problems: string[]; stats: TestRunStats }> {
  const rand = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const features = new Set<string>();
  const problems: string[] = [];

  // ---- The world.
  const emailCap = 3 + Math.floor(rand() * 4);
  const smsCap = 3 + Math.floor(rand() * 4);
  const emailGap = pick([MIN, 2 * MIN, 5 * MIN]);
  const smsGap = pick([MIN, 3 * MIN]);
  const k = pick([1, 2]);
  const leads: Lead[] = [
    { name: "Pat Oneil", email: "pat@harbour.example", mobile: "+447700900111" },
    { name: "Nia Cole", email: rand() < 0.8 ? "nia@harbour.example" : null, mobile: rand() < 0.7 ? "+447700900112" : null },
    ...(rand() < 0.6 ? [{ name: "Owen Hart", email: "owen@quayside.example", mobile: rand() < 0.5 ? "+447700900113" : null }] : []),
  ];
  const emailSteps = 1 + Math.floor(rand() * 3);
  const smsSteps = 1 + Math.floor(rand() * 2);
  const together = rand() < 0.5;
  const phone = rand() < 0.5;
  const path: DeclinedPath = pick(["stop", "continue", "win_back"]);
  const tracks: TrackDefinition[] = [
    { id: "e", channel: "email", branch: "main", window: ALWAYS, steps: Array.from({ length: emailSteps }, (_, i) => step(`e${i + 1}`, i === 0 ? 0 : 1 + Math.floor(rand() * 3), rand)), start: { kind: "entry" }, removed: false },
    { id: "m", channel: "sms", branch: "main", window: ALWAYS, steps: Array.from({ length: smsSteps }, (_, i) => step(`m${i + 1}`, i === 0 ? 0 : 1 + Math.floor(rand() * 2), rand)), start: together ? { kind: "entry" } : { kind: "after", trackId: "e", delayDays: Math.floor(rand() * 3) }, removed: false },
    ...(phone
      ? [
          { id: "p", channel: "call" as const, branch: "main" as const, window: WEEKDAYS, steps: [callStep("c1")], start: { kind: "after" as const, trackId: "e", delayDays: 1 }, removed: false, declinedPath: path },
          { id: "w", channel: "email" as const, branch: "win_back" as const, window: ALWAYS, steps: [step("w1", 0, rand)], start: { kind: "entry" as const }, removed: false },
        ]
      : []),
  ];
  let definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [INBOX], smsPool: [NUMBER], ...(phone ? { callScript: "Ask who handles bookings." } : {}), tracks };

  const h = new EngineHarness({
    start: MONDAY_9,
    accounts: [{ id: INBOX, capacity: emailCap, gapMs: emailGap, k, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: NUMBER, capacity: smsCap, gapMs: smsGap, k, healthy: true, resetZone: "Europe/London" }] },
    random: random(seed ^ 0x21),
    engine: { waitFor: quickWait },
    ...(options.rules ? { rules: options.rules } : {}),
  });
  h.maxWrites = options.maxWrites ?? null;
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 10, userZone: "Europe/London" });
  const { campaign } = await h.createCampaign("Clinics, London", {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio" }), business({ business_id: "b2", business_name: "Quayside Physio" })],
    people: leads.map((l, i) =>
      person({ person_id: `p${i + 1}`, business_id: l.name === "Owen Hart" ? "b2" : "b1", full_name: l.name, ...(l.email ? { email: l.email } : {}), ...(l.mobile ? { dial_phone: l.mobile, dial_phone_type: "mobile" } : {}) }),
    ),
  });
  await h.defineSequence(campaign.id, definition);
  const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const enrollmentOf = new Map(rows.map((r) => [r.name, r.enrollments[0]?.id ?? ""]));
  const leadIds = new Set([...enrollmentOf.values()].filter((id) => id !== ""));
  const leadEmails = leads.flatMap((l) => (l.email ? [l.email] : []));
  const leadKeys = new Set([...leadEmails, ...leads.flatMap((l) => (l.mobile ? [l.mobile] : []))]);

  // ---- The record.
  const db = (h.store.engine as unknown as { db: DatabaseSync }).db;
  const runs = new Map<string, { contacts: Set<string>; startedAt: number; endedAt: number | null; renderAs: string; replyAt: number | null; replyHandovers: number; editAt: number | null; editHandovers: number }>();
  let savedContacts = new Set<string>();
  let testedSinceEdit = false;
  let launched = false;
  let paused = false;
  let requests = 0;
  const leadReplied = new Set<string>();
  options.patch?.(h, { leadEmails, renderAsOf: (id) => runs.get(id)?.renderAs ?? null });

  const handovers = (): HandoverLogEntry[] => [...h.fake.handoverLog, ...h.sms.handoverLog];
  const deliveries = (): DeliveryLogEntry[] => [...h.fake.deliveryLog, ...h.sms.deliveryLog];
  const isTest = (subjectId: string) => subjectId.startsWith("test-");
  const tab = async () => (await h.request<TestRunTab>("GET", `/api/campaigns/${campaign.id}/test-runs`)).body;

  // T2's first half, by observation: every store transaction on a test run leaves every enrollment's rows as they were.
  const leadRows = () =>
    JSON.stringify(
      ["enrollments", "track_progress", "step_results", "attempts", "call_tasks", "call_attempts", "replies"].map((t) =>
        db.prepare(t === "enrollments" ? "SELECT * FROM enrollments ORDER BY id" : `SELECT * FROM ${t} WHERE subject_id IN (SELECT id FROM enrollments) ORDER BY rowid`).all(),
      ),
    );
  const engineStore = h.store.engine;
  for (const method of ["update", "updateNow", "controlSubject"] as const) {
    const original = (engineStore[method] as (...args: unknown[]) => unknown).bind(engineStore);
    (engineStore as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const id = args[0] as string;
      if (!isTest(id)) return original(...args);
      const before = leadRows();
      const out = original(...args);
      if (leadRows() !== before) problems.push(`T2: a transaction on test run ${id} (${method}) changed a lead's records`);
      return out;
    };
  }
  for (const method of ["startTestRun", "saveTestContacts"] as const) {
    const original = (engineStore[method] as (...args: unknown[]) => unknown).bind(engineStore);
    (engineStore as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const before = leadRows();
      const out = original(...args);
      if (leadRows() !== before) problems.push(`T2: ${method} changed a lead's records`);
      return out;
    };
  }

  /** The invariants, after every event. */
  const check = async (event: string) => {
    // When each run ended, as stored: the instant the engine ended it (a reply, a stop, an edit, the end of its steps).
    for (const [id, r] of runs) {
      const row = db.prepare("SELECT ended, ended_wall FROM test_runs WHERE id = ?").get(id);
      if (row?.["ended"] != null && r.endedAt === null) r.endedAt = Number(row["ended_wall"]);
    }
    const hs = handovers();
    const ds = deliveries();
    // T1 and T3.
    for (const x of hs) {
      if (isTest(x.subjectId)) {
        const r = runs.get(x.subjectId);
        if (!r?.contacts.has(x.destination)) problems.push(`T1: test run ${x.subjectId} handed ${x.stepId} to ${x.destination}, not its test contact (${event})`);
        if (leadKeys.has(x.destination)) problems.push(`T1: test run ${x.subjectId} handed ${x.stepId} to a lead's ${x.destination} (${event})`);
      }
    }
    for (const d of ds) if (savedContacts.has(d.destination) || d.destination === OWN_EMAIL || d.destination === OWN_MOBILE) if (!isTest(d.subjectId)) problems.push(`T3: lead ${d.subjectId} was sent ${d.stepId} at the test contact ${d.destination} (${event})`);
    // T4: capacity per reset day, and the pacing gap per sender, every send counted, tests included.
    const perDay = new Map<string, number>();
    for (const d of ds) {
      const zone = d.sender === NUMBER ? "Europe/London" : "UTC";
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(d.at);
      perDay.set(`${d.sender}/${day}`, (perDay.get(`${d.sender}/${day}`) ?? 0) + 1);
    }
    for (const [k, n] of perDay) if (n > (k.startsWith(NUMBER) ? smsCap : emailCap)) problems.push(`T4: ${k} sent ${n}, over its capacity (${event})`);
    for (const sender of [INBOX, NUMBER]) {
      const firsts = new Map<string, number>();
      for (const x of hs) if (x.sender === sender && !firsts.has(x.key)) firsts.set(x.key, x.at);
      const times = [...firsts.values()].sort((a, b) => a - b);
      const gap = sender === NUMBER ? smsGap : emailGap;
      for (let i = 1; i < times.length; i++) if ((times[i] ?? 0) - (times[i - 1] ?? 0) < gap) problems.push(`T4: ${sender} made two sends ${(times[i] ?? 0) - (times[i - 1] ?? 0)} ms apart, under its gap (${event})`);
    }
    // T6: each test step after the first in its track goes a minute or more after its predecessor's send, and promptly.
    for (const [id, r] of runs) {
      for (const t of definition.tracks) {
        const sent = t.steps.map((s) => ds.find((d) => d.subjectId === id && d.stepId === s.id));
        t.steps.forEach((s, i) => {
          const prev = i === 0 ? undefined : sent[i - 1];
          if (!prev) return;
          const first = hs.find((x) => x.subjectId === id && x.stepId === s.id);
          if (first && s.waitDays > 0 && first.at < prev.at + MIN) problems.push(`T6: test run ${id} handed ${s.id} ${first.at - prev.at} ms after ${t.steps[i - 1]?.id} was sent (${event})`);
          const ended = r.endedAt ?? Infinity;
          const capacityLeft = (perDay.get(`${prev.sender}/${new Intl.DateTimeFormat("en-CA", { timeZone: prev.sender === NUMBER ? "Europe/London" : "UTC" }).format(prev.at + PROMPT_MS)}`) ?? 0) < (prev.sender === NUMBER ? smsCap : emailCap) - 1;
          if (!first && h.clock > prev.at + MIN + PROMPT_MS && ended > prev.at + MIN + PROMPT_MS && capacityLeft) {
            problems.push(`T6: test run ${id} has not handed ${s.id} ${Math.round((h.clock - prev.at) / MIN)} min after ${t.steps[i - 1]?.id} was sent (${event})`);
          }
        });
      }
      // T7: after its contact's reply, and after an edit stopped it, nothing new is handed over for the run.
      const own = hs.filter((x) => x.subjectId === id);
      const firstKeys = new Set<string>();
      own.forEach((x, i) => {
        const fresh = !firstKeys.has(x.key);
        firstKeys.add(x.key);
        if (fresh && r.replyAt !== null && i >= r.replyHandovers) problems.push(`T7: test run ${id} handed ${x.stepId} after its contact replied (${event})`);
        if (fresh && r.editAt !== null && i >= r.editHandovers) problems.push(`T7: test run ${id} handed ${x.stepId} after an edit stopped it (${event})`);
      });
    }
    // T2's second half: a lead ends replied only after a reply of its own.
    for (const row of db.prepare("SELECT id, status FROM enrollments").all()) {
      if (row["status"] === "replied" && !leadReplied.has(String(row["id"]))) problems.push(`T2: lead ${String(row["id"])} ended replied with no reply of its own (${event})`);
    }
    // T5, from the record's own account of edits and Run tests.
    const read = await tab();
    if (read.noTestSinceEdit !== !testedSinceEdit) problems.push(`T5: the read says noTestSinceEdit ${String(read.noTestSinceEdit)}; the record says ${String(!testedSinceEdit)} (${event})`);
    // T9: an ended test holds no SMS conversation.
    for (const b of db.prepare("SELECT b.owner_subject FROM sms_bindings b JOIN test_runs t ON t.id = b.owner_subject WHERE b.released_at IS NULL AND t.ended IS NOT NULL").all()) {
      problems.push(`T9: ended test run ${String(b["owner_subject"])} still holds its SMS conversation (${event})`);
    }
    for (const [id, r] of runs) {
      const row = db.prepare("SELECT ended FROM test_runs WHERE id = ?").get(id);
      if (r.replyAt !== null && h.clock > r.replyAt + 10 * MIN && row?.["ended"] == null) problems.push(`T7: test run ${id} still runs 10 minutes after its contact replied (${event})`);
    }
  };

  const runningRun = () => [...runs.keys()].find((id) => db.prepare("SELECT ended FROM test_runs WHERE id = ?").get(id)?.["ended"] == null) ?? null;

  // ---- The events.
  const events = 18 + Math.floor(rand() * 14);
  for (let e = 0; e < events && problems.length === 0 && !h.stopped; e++) {
    const roll = rand();
    const running = runningRun();
    let event = "";
    // A test call on the list is logged more often than chance would: the outcomes are what the call paths are about.
    const ready = phone && running !== null ? (await h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((c) => c.test) : undefined;
    if (ready && rand() < 0.6) {
      const outcome = pick(["no_answer", "not_interested", "not_interested", "interested"] as const);
      const view = (await h.request<{ numbers: { detailId: string }[] }>("GET", `/api/call-tasks/${ready.taskId}`)).body;
      const declined = outcome === "not_interested" ? { declinedPath: rand() < 0.5 ? path : pick(["stop", "continue", "win_back"] as const) } : {};
      await h.request("POST", `/api/call-tasks/${ready.taskId}/outcome`, { requestId: `call-${++requests}`, outcome, numberId: view.numbers[0]?.detailId, note: "", ...declined });
      features.add(`a-test-call-${outcome.replace("_", "-")}${"declinedPath" in declined ? `-${declined.declinedPath.replace("_", "-")}` : ""}`);
      event = "log a test call";
    } else if (roll < 0.1) {
      const lead = rand() < 0.25 ? pick(leads.filter((l) => l.email !== null)) : null;
      const body = lead ? { email: lead.email ?? "", mobile: "" } : { email: rand() < 0.85 ? OWN_EMAIL : "", mobile: rand() < 0.8 ? OWN_MOBILE : "" };
      const res = await h.request("PUT", `/api/campaigns/${campaign.id}/test-contacts`, body);
      if (lead) {
        features.add("a-lead-s-email-refused-as-a-test-contact");
        if (res.status !== 409) problems.push(`T1: a lead's email was accepted as a test contact (${res.status})`);
      } else if (res.status === 200) savedContacts = new Set([body.email, body.mobile].filter((x) => x !== ""));
      event = "save contacts";
    } else if (roll < 0.3) {
      const renderAs = pick([...leadIds].sort());
      const version = (await tab()).definitionVersion;
      const before = runs.size;
      const res = await h.request<TestRunTab & { error?: { message: string } }>("POST", `/api/campaigns/${campaign.id}/test-runs`, { requestId: `run-${++requests}`, renderAs, expect: { definitionVersion: version } });
      if (running !== null) {
        features.add("run-test-refused-while-one-runs");
        if (res.status !== 409) problems.push(`T8: a second Run test was accepted while ${running} runs`);
      }
      if (res.status === 200 && res.body.run) {
        if (runs.has(res.body.run.id) || before !== runs.size) problems.push("T8: an accepted Run test is not a new run");
        runs.set(res.body.run.id, { contacts: new Set(savedContacts), startedAt: h.clock, endedAt: null, renderAs, replyAt: null, replyHandovers: 0, editAt: null, editHandovers: 0 });
        testedSinceEdit = true;
        features.add(launched ? (paused ? "a-test-on-a-paused-campaign" : "a-test-on-a-running-campaign") : "a-test-before-launch");
        if ([...runs.values()].filter((r) => r.endedAt !== null).length > 0) features.add("a-test-after-another-ended");
      }
      event = "run test";
    } else if (roll < 0.36 && running !== null) {
      await h.request("POST", `/api/test-runs/${running}/stop`, { requestId: `stop-${++requests}` });
      features.add("stop-test");
      event = "stop test";
    } else if (roll < 0.46 && running !== null) {
      const r = runs.get(running);
      const email = deliveries().some((d) => d.subjectId === running && d.destination === OWN_EMAIL);
      const sms = deliveries().some((d) => d.subjectId === running && d.destination === OWN_MOBILE);
      const replied = email && (rand() < 0.5 || !sms) ? h.fake.prospectReplies(OWN_EMAIL) : sms ? h.sms.prospectTexts(OWN_MOBILE) : false;
      if (replied && r) {
        r.replyAt = h.clock;
        r.replyHandovers = handovers().filter((x) => x.subjectId === running).length;
        features.add(email && !sms ? "a-test-email-reply" : "a-test-reply");
      }
      event = "test contact replies";
    } else if (roll < 0.5) {
      const lead = pick(leads);
      const id = enrollmentOf.get(lead.name) ?? "";
      const replied = lead.email !== null && deliveries().some((d) => d.destination === lead.email) && h.fake.prospectReplies(lead.email);
      if (replied) {
        leadReplied.add(id);
        features.add("a-lead-reply");
      }
      event = "lead replies";
    } else if (roll < 0.58) {
      // An edit of one email's copy: accepted, it stops the running test (question Q27).
      const handed = running === null ? 0 : handovers().filter((x) => x.subjectId === running).length;
      definition = { ...definition, tracks: definition.tracks.map((t) => (t.id === "e" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, body: `${s.body} Edited ${e}.` } : s)) } : t)) };
      const res = await h.request("PUT", `/api/campaigns/${campaign.id}/sequence`, definition);
      if (res.status === 200) {
        testedSinceEdit = false;
        if (running !== null) {
          const r = runs.get(running);
          if (r) {
            r.editAt = h.clock;
            r.editHandovers = handed;
          }
          features.add("an-edit-during-a-test");
          const read = (await tab()).run;
          if (read?.id === running && read.running) problems.push(`T7: an accepted edit left test run ${running} running`);
        }
      }
      event = "edit";
    } else if (roll < 0.63 && !launched) {
      const res = await h.request<{ error?: unknown }>("POST", `/api/campaigns/${campaign.id}/launch`, { definitionVersion: (await tab()).definitionVersion });
      if (res.status === 200) {
        launched = true;
        // A launch with the warning showing is accepted: the warning never blocks (T5).
        features.add(testedSinceEdit ? "launch-after-a-test" : "launch-with-the-warning");
      } else problems.push(`T5: launch refused (${res.status}): ${JSON.stringify(res.body)}`);
      event = "launch";
    } else if (roll < 0.68 && launched) {
      const res = await h.request("POST", `/api/campaigns/${campaign.id}/${paused ? "resume" : "pause"}`, { requestId: `pause-${++requests}` });
      if (res.status === 200) {
        paused = !paused;
        if (paused) features.add("a-campaign-pause");
      }
      event = paused ? "pause" : "resume";
    } else {
      const ms = pick([30_000, MIN, 3 * MIN, 10 * MIN, H, 6 * H, DAY]);
      await h.advanceTo(h.clock + ms);
      event = `advance ${ms / MIN} min`;
    }
    await check(event);
  }
  // The drain: time passes with no events.
  if (problems.length === 0 && !h.stopped) {
    await h.advanceTo(h.clock + 2 * H);
    await check("drain");
  }
  if ([...runs.keys()].some((id) => deliveries().some((d) => d.subjectId === id && d.destination === OWN_MOBILE))) features.add("a-test-text");
  if (deliveries().some((d) => isTest(d.subjectId) && d.stepId === "w1")) features.add("a-test-in-win-back");
  if (deliveries().some((d) => leadIds.has(d.subjectId)) && deliveries().some((d) => isTest(d.subjectId))) features.add("tests-and-leads-share-senders");
  await h.store.close();
  return { problems: [...new Set(problems)], stats: { features: [...features].sort() } };
}
