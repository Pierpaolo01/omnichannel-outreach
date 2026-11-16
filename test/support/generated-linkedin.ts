import { Crash, EngineHarness } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { ProfileScript } from "./fake-linkedin-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, firstOpen, local, type Hours } from "./sequence-model.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { LeadSearchResult } from "../../src/shared/api.ts";

/**
 * The generated LinkedIn runs (ticket 24, ADR 0004 section 10). The real HTTP app, SQLite store and engine run one or two
 * campaigns with a LinkedIn track (and in half of them an email track together with it or after it) against the simulated
 * LinkedIn provider and the fake email provider. The record below imports nothing from `src/domain/sequence/`: it keeps
 * its own copy of each definition, the allowances, each lead's held intervals, the user's marks and the providers' logs,
 * and from them, with its own calendar arithmetic (`sequence-model.ts`), predicts what L1 to L10 require. Every profile and
 * person is fictitious. A run reports its problems, each prefixed with the invariant it breaks.
 */

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const SETTLING = 15 * MIN;
/** Monday 2 November 2026, 08:00 UTC. */
const START = Date.parse("2026-11-02T08:00:00Z");
const ZONES = ["Europe/London", "America/New_York", "Australia/Sydney"] as const;
const SESSIONS = ["li-a", "li-b"] as const;

/** Sending windows as the control runs draw them (ADR 0003 "Reads that say when"): weekdays, hours, all day often. */
const DAYSETS = [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6], [1, 3, 5]] as const;
const HOURS = [[9, 17], [8, 12], [13, 18], [20, 24], [22, 2], [0, 24], [0, 24], [0, 24]] as const;

export interface LinkedinRunOptions {
  readonly rules?: Partial<Rules>;
  readonly maxWrites?: number;
  /** A replay also stops after this many engine ticks: a broken engine can tick for ever writing little. */
  readonly maxTicks?: number;
}

export interface LinkedinRun {
  readonly problems: string[];
  readonly stats: { readonly features: Set<string>; readonly writes: number; readonly ticks: number };
}

/**
 * The wall instant a span of `running` milliseconds of the lead's clock, counted from `from`, ends at: the clock stands
 * still through every held interval (a pause; the record's own list), so each one it meets moves the end by its length.
 */
export function afterHolds(from: number, running: number, holds: readonly { readonly from: number; readonly to: number | null }[]): number {
  let cursor = from;
  let left = running;
  for (const x of [...holds].sort((a, b) => a.from - b.from)) {
    const to = x.to ?? Infinity;
    if (to <= cursor) continue;
    if (x.from > cursor) {
      if (cursor + left <= x.from) return cursor + left;
      left -= x.from - cursor;
    }
    cursor = to;
  }
  return cursor + left;
}

/** The invariant a problem names ("L4: ..."). */
export const linkedinInvariantsOf = (problem: string): string[] => [problem.split(":")[0] ?? ""];

interface Allowance {
  readonly invites: number;
  readonly messages: number;
  readonly notes: number;
}

interface Lead {
  readonly campaign: number;
  readonly name: string;
  readonly profile: string | null;
  readonly email: string;
  readonly zone: string;
  readonly script: ProfileScript | null;
  id: string;
}

interface Campaign {
  id: string;
  readonly definition: CampaignDefinition;
  readonly li: TrackDefinition;
  readonly email: TrackDefinition | null;
}

const pickOf = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;

function windowOf(rnd: () => number): Hours[] {
  const days = pickOf(rnd, DAYSETS);
  const [start, end] = pickOf(rnd, HOURS);
  return days.map((day) => ({ day, start, end }));
}

export async function runLinkedin(seed: number, options: LinkedinRunOptions = {}): Promise<LinkedinRun> {
  const rnd = random(seed);
  // The events the review of 194fc44 added (council item 2) draw from a stream of their own, so the first stream's draws
  // are unchanged: two campaigns sharing people, stops, campaign pauses, skips, a crash, a session signing out, running edits.
  const rnd2 = random(seed * 7 + 13);
  const features = new Set<string>();
  const problems: string[] = [];
  const problem = (text: string) => {
    if (!problems.includes(text)) problems.push(text);
  };

  // --- The world.
  const sessions = SESSIONS.slice(0, rnd() < 0.5 ? 1 : 2).map((id) => ({ id, gapMs: pickOf(rnd, [5 * MIN, 30 * MIN]), k: 1, healthy: true, resetZone: "Europe/London" }));
  const allowances = new Map<string, Allowance>(sessions.map((s) => [s.id, { invites: Math.floor(rnd() * 4) + 1, messages: Math.floor(rnd() * 4) + 1, notes: Math.floor(rnd() * 4) }]));
  const h = new EngineHarness({
    start: START,
    accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    linkedin: { sessions },
    ...(options.rules ? { rules: options.rules } : {}),
  });
  await h.tick();
  for (const [id, a] of allowances) {
    const r = await h.request("PUT", `/api/sender-accounts/${id}/allowances`, { invitesPerDay: a.invites, messagesPerDay: a.messages, notesPerMonth: a.notes });
    if (r.status !== 200) problem(`setup: allowances refused for ${id}`);
  }

  const campaigns: Campaign[] = [];
  const leads: Lead[] = [];
  const campaignCount = rnd() < 0.5 ? 1 : 2;
  let personNo = 0;
  for (let ci = 0; ci < campaignCount; ci++) {
    const noted = rnd() < 0.7;
    const messages = 1 + Math.floor(rnd() * 3);
    const steps: StepDefinition[] = [
      { id: `c${ci}-inv`, waitDays: 0, subject: "", body: noted ? "Hello {{first_name|there}}, I help clinics like {{company}}." : "", threading: "new_subject", removed: false },
      ...Array.from({ length: messages }, (_, i): StepDefinition => ({ id: `c${ci}-m${i + 1}`, waitDays: i === 0 ? Math.floor(rnd() * 2) : Math.floor(rnd() * 3), subject: "", body: `Message ${i + 1}, {{first_name|there}}.`, threading: "new_subject", removed: false })),
    ];
    const li: TrackDefinition = { id: `c${ci}-li`, channel: "linkedin", branch: "main", window: windowOf(rnd), steps, start: { kind: "entry" }, removed: false, acceptWaitDays: 1 + Math.floor(rnd() * 4) };
    const withEmail = rnd() < 0.5;
    const email: TrackDefinition | null = withEmail
      ? { id: `c${ci}-em`, channel: "email", branch: "main", window: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 })), steps: [{ id: `c${ci}-e1`, waitDays: 0, subject: "Hello {{first_name|there}}", body: "An email.", threading: "new_subject", removed: false }], start: rnd() < 0.5 ? { kind: "entry" } : { kind: "after", trackId: li.id, delayDays: Math.floor(rnd() * 2) }, removed: false }
      : null;
    if (email) features.add(email.start.kind === "after" ? "email-after-linkedin" : "email-beside-linkedin");
    const pool = sessions.length === 1 ? [sessions[0]!.id] : pickOf(rnd, [[sessions[0]!.id], [sessions[1]!.id], [sessions[0]!.id, sessions[1]!.id]]);
    const definition: CampaignDefinition = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: ["inbox-a"], smsPool: [], linkedinPool: pool, tracks: email ? [li, email] : [li] };
    campaigns.push({ id: "", definition, li, email });
    const people = 3 + Math.floor(rnd() * 4);
    for (let p = 0; p < people; p++) {
      personNo++;
      const kind = rnd();
      const zone = pickOf(rnd, ZONES);
      const profile = kind < 0.75 ? `https://www.linkedin.com/in/fictional-lead-${seed}-${personNo}` : null;
      const cell = profile ?? (kind < 0.88 ? `https://www.linkedin.com/company/fictional-${personNo}` : "");
      const behaviour = rnd();
      const script: ProfileScript | null =
        profile === null
          ? null
          : behaviour < 0.35
            ? { acceptAfterMs: Math.floor(rnd() * 3 * DAY) + MIN, ...(rnd() < 0.3 ? { acceptReportDelayMs: Math.floor(rnd() * 6 * H) } : {}) }
            : behaviour < 0.55
              ? {}
              : behaviour < 0.68
                ? { connected: true }
                : behaviour < 0.76
                  ? { unreachable: true }
                  : behaviour < 0.84
                    ? { rateLimited: 1, acceptAfterMs: Math.floor(rnd() * 2 * DAY) + MIN }
                    : behaviour < 0.92
                      ? { loseAnswer: 1, acceptAfterMs: rnd() < 0.5 ? Math.floor(rnd() * 2 * DAY) + MIN : null }
                      : { withdrawUnknown: 1 };
      leads.push({ campaign: ci, name: `Lead${personNo} Fictional`, profile, email: `lead${personNo}@fictional.example`, zone, script, id: "" });
      if (profile && script) h.linkedin.profiles.set(profile, { ...script });
      (leads.at(-1) as Lead & { cell?: string }).cell = cell;
    }
  }
  // Two campaigns sharing people (question Q41): the second also enrols some of the first's, with the same profile.
  const rowOf = new Map<Lead, { personId: string; businessId: string }>();
  for (const [ci] of campaigns.entries()) leads.filter((l) => l.campaign === ci).forEach((l, i) => rowOf.set(l, { personId: `p${ci}-${i}`, businessId: `b${ci}` }));
  if (campaigns.length === 2 && rnd2() < 0.7) {
    const firsts = leads.filter((l) => l.campaign === 0 && l.profile !== null);
    for (const l of firsts.slice(0, 1 + Math.floor(rnd2() * 2))) {
      const shared: Lead & { cell?: string } = { ...l, campaign: 1, id: "" };
      leads.push(shared);
      rowOf.set(shared, rowOf.get(l)!);
      features.add("a-person-in-two-campaigns");
    }
  }
  for (const [ci, c] of campaigns.entries()) {
    const own = leads.filter((l) => l.campaign === ci);
    const businessIds = [...new Set(own.map((l) => rowOf.get(l)!.businessId))];
    const { campaign } = await h.createCampaign(`LinkedIn ${ci}`, {
      businesses: businessIds.map((b) => business({ business_id: b, business_name: `Fictional Clinic ${b}`, phone_e164: `+4420794601${10 + Number(b.slice(1))}` })),
      people: own.map((l) => person({ person_id: rowOf.get(l)!.personId, business_id: rowOf.get(l)!.businessId, full_name: l.name, email: l.email, timezone: l.zone, linkedin_url: (l as Lead & { cell?: string }).cell ?? "" })),
    });
    c.id = campaign.id;
    await h.defineSequence(c.id, c.definition);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) problem(`setup: launch refused ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    for (const l of own) l.id = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  }

  const bounded = () => (options.maxWrites !== undefined && h.writes > options.maxWrites) || (options.maxTicks !== undefined && h.ticks > options.maxTicks);

  // --- The record's own log of what the user did.
  const held = new Map<string, { from: number; to: number | null }[]>();
  const marked = new Map<string, number>();
  const stopped = new Map<string, number>();
  const campaignHeld = new Map<string, { from: number; to: number | null }[]>();
  const waitEdits = new Map<number, { at: number; days: number }[]>();
  const signedOut: { id: string; until: number }[] = [];
  const skipped = new Map<string, number[]>();
  /** Every hold of a lead: its own pauses and its campaign's. */
  const holdsOf = (l: Lead) => [...(held.get(l.id) ?? []), ...(campaignHeld.get(campaigns[l.campaign]!.id) ?? [])];
  const outages: { from: number; to: number }[] = [];

  // --- Events.
  const end = START + 12 * DAY;
  let requestNo = 0;
  while (h.clock < end && !bounded()) {
    const step = pickOf(rnd, [10 * MIN, 45 * MIN, 3 * H, 9 * H, DAY]);
    await h.advanceTo(Math.min(end, h.clock + step));
    const roll = rnd();
    const lead = pickOf(rnd, leads);
    if (roll < 0.07 && !stopped.has(lead.id) && !marked.has(lead.id)) {
      // The user pauses a lead, and resumes it later.
      const holds = held.get(lead.id) ?? [];
      const open = holds.find((x) => x.to === null);
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: open ? "resume" : "pause" });
      if (r.status === 200) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        held.set(lead.id, holds);
        features.add(open ? "a-lead-resumed" : "a-lead-paused");
      }
    } else if (roll < 0.13) {
      // The user marks a social reply; refused when nothing went on LinkedIn, or the lead had already replied.
      const r = await h.request("POST", `/api/enrollments/${lead.id}/replies`, { requestId: `g-${++requestNo}`, channel: "linkedin" });
      if (r.status === 200 && !marked.has(lead.id)) {
        marked.set(lead.id, h.clock);
        features.add("a-reply-marked");
      } else if (r.status !== 200) features.add("a-reply-mark-refused");
    } else if (roll < 0.17) {
      // The laptop is off for a while: nothing ticks; the platform carries on (acceptances happen).
      const ms = pickOf(rnd, [2 * H, 14 * H, 2 * DAY]);
      outages.push({ from: h.clock, to: h.clock + ms });
      await h.stopFor(ms);
      features.add("the-laptop-was-off");
    }
    await extraEvent(rnd2());
    await check(false);
  }
  for (const s of signedOut) h.linkedin.sessions.get(s.id)!.healthy = true;
  await markUnresolved();
  for (const c of campaigns) {
    const open = (campaignHeld.get(c.id) ?? []).find((x) => x.to === null);
    if (open && (await h.request("POST", `/api/campaigns/${c.id}/resume`, { requestId: `g-${++requestNo}` })).status === 200) open.to = h.clock;
  }
  // The drain: time passes with no new event, every hold released first.
  for (const l of leads) {
    const open = (held.get(l.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    const r = await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume" });
    if (r.status === 200) open.to = h.clock;
  }
  // A day at a time, so a broken engine that loops (a claim expired and made again every tick) stops at the same count of
  // engine writes on every machine; the drain's checks then judge what was reached.
  const drainEnd = h.clock + 25 * DAY;
  while (h.clock < drainEnd && !bounded()) {
    await h.advanceTo(Math.min(drainEnd, h.clock + DAY));
    await markUnresolved();
  }
  await check(true);
  return { problems, stats: { features, writes: h.writes, ticks: h.ticks } };

  /**
   * The user settles LinkedIn work the session could not confirm (ADR 0003 5.3, the user's mark; ADR 0004 2.2): after
   * checking LinkedIn they mark it by what the session actually did, as the other generated users do.
   */
  async function markUnresolved(): Promise<void> {
    for (const l of leads) {
      const st = await h.store.engine.subject(l.id, h.clock);
      for (const w of st?.work ?? []) {
        if (w.kind == null || w.settled !== null || w.unresolvedSince === null) continue;
        const a = st?.attempts.filter((x) => x.idempotencyKey === w.key).at(-1);
        if (!a) continue;
        const went = h.linkedin.deliveryLog.some((d) => d.key === w.key);
        if (await h.engine.markAttempt(a.id, went ? "sent" : "not_sent")) features.add(went ? "unresolved-marked-sent" : "unresolved-marked-not-sent");
      }
    }
  }

  async function extraEvent(roll: number): Promise<void> {
    if (roll > 0.9) await markUnresolved();
    for (const s of signedOut) if (s.until <= h.clock) h.linkedin.sessions.get(s.id)!.healthy = true;
    const lead = pickOf(rnd2, leads);
    const c = campaigns[lead.campaign]!;
    if (roll < 0.04 && !stopped.has(lead.id)) {
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "stop" });
      if (r.status === 200) {
        stopped.set(lead.id, h.clock);
        features.add("a-lead-stopped");
      }
    } else if (roll < 0.07) {
      const holds = campaignHeld.get(c.id) ?? [];
      const open = holds.find((x) => x.to === null);
      const r = await h.request("POST", `/api/campaigns/${c.id}/${open ? "resume" : "pause"}`, { requestId: `g-${++requestNo}` });
      if (r.status === 200) {
        if (open) open.to = h.clock;
        else holds.push({ from: h.clock, to: null });
        campaignHeld.set(c.id, holds);
        features.add(open ? "a-campaign-resumed" : "a-campaign-paused");
      }
    } else if (roll < 0.11) {
      // Skips at every state, aimed at a lead waiting for acceptance more than half the time (the review bot's item 9).
      const waiting: Lead[] = [];
      for (const l of leads) {
        const t = (await h.store.engine.subject(l.id, h.clock))?.tracks.find((x) => x.trackId === campaigns[l.campaign]!.li.id);
        if (t?.acceptBy != null && t.connection == null && t.finishedAt === null) waiting.push(l);
      }
      if (waiting.length > 0 && rnd2() < 0.6) {
        const target = pickOf(rnd2, waiting);
        const r = await h.request("POST", `/api/enrollments/${target.id}/controls`, { requestId: `g-${++requestNo}`, action: "skip" });
        if (r.status === 200) features.add("a-skip-while-waiting-for-acceptance");
        return;
      }
      const st = await h.store.engine.subject(lead.id, h.clock);
      const tp = st?.tracks.find((t) => t.trackId === c.li.id);
      const r = await h.request("POST", `/api/enrollments/${lead.id}/controls`, { requestId: `g-${++requestNo}`, action: "skip" });
      if (r.status === 200) {
        skipped.set(lead.id, [...(skipped.get(lead.id) ?? []), h.clock]);
        features.add(tp?.acceptBy != null && tp.connection == null && tp.finishedAt === null ? "a-skip-while-waiting-for-acceptance" : tp?.nextStepId === c.li.steps[0]?.id ? "a-skip-of-the-invite" : "a-skip");
      }
    } else if (roll < 0.13) {
      const s = pickOf(rnd2, sessions);
      h.linkedin.sessions.get(s.id)!.healthy = false;
      signedOut.push({ id: s.id, until: h.clock + pickOf(rnd2, [H, 8 * H]) });
      features.add("a-session-signed-out");
    } else if (roll < 0.15) {
      let armed = true;
      h.hooks.crashPoint = (point) => {
        if (armed && point === "after_handover_commit") {
          armed = false;
          features.add("a-crash-between-the-handover-and-its-answer");
          throw new Crash(point);
        }
      };
    } else if (roll < 0.2) {
      // A running edit of the LinkedIn track (ticket 19's rules): the wait for acceptance, or the messages.
      const stored = (await h.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${c.id}/sequence`)).body.definition;
      const kind = pickOf(rnd2, ["wait", "insert", "remove", "reorder"] as const);
      const tracks = stored.tracks.map((t) => {
        if (t.id !== c.li.id) return t;
        const live = t.steps.filter((x) => !x.removed);
        if (kind === "wait") return { ...t, acceptWaitDays: 1 + Math.floor(rnd2() * 4) };
        if (kind === "insert") return { ...t, steps: [...t.steps, { id: `${t.id}-x${requestNo}`, waitDays: Math.floor(rnd2() * 2), subject: "", body: "An added message.", threading: "new_subject" as const, removed: false }] };
        if (kind === "remove" && live.length > 2) {
          const gone = live[1 + Math.floor(rnd2() * (live.length - 1))]!.id;
          return { ...t, steps: t.steps.map((x) => (x.id === gone ? { ...x, removed: true } : x)) };
        }
        if (kind === "reorder" && live.length > 2) {
          const [inv, a, b, ...rest] = t.steps;
          return a && b && inv ? { ...t, steps: [inv, b, a, ...rest] } : t;
        }
        return t;
      });
      const r = await h.request("PUT", `/api/campaigns/${c.id}/sequence`, { ...stored, tracks });
      if (r.status === 200) {
        features.add(`a-running-edit:${kind}`);
        const days = tracks.find((t) => t.id === c.li.id)?.acceptWaitDays;
        if (kind === "wait" && days !== undefined) waitEdits.set(lead.campaign, [...(waitEdits.get(lead.campaign) ?? []), { at: h.clock, days }]);
      }
    }
  }

  // --- The checks, from the record and the providers' logs.
  async function check(drained: boolean): Promise<void> {
    const li = h.linkedin;
    const now = h.clock;
    const allowanceOf = (session: string) => allowances.get(session) ?? { invites: 0, messages: 0, notes: 0 };
    const leadOfSubject = (id: string) => leads.find((l) => l.id === id);

    // L1: one invite per (session, profile) across every campaign and test run, unless every earlier one was withdrawn
    // before it (a withdrawn, never-accepted invite leaves no conversation, Q41); and each step delivered at most once.
    const seen = new Set<string>();
    for (const d of li.deliveryLog) {
      if (d.action === "invite") {
        const earlier = li.deliveryLog.filter((x) => x.action === "invite" && x.sender === d.sender && x.destination === d.destination && x.at < d.at);
        const outstanding = earlier.filter((x) => !li.withdrawalLog.some((w) => w.key === x.key && w.answer === "withdrawn" && w.at <= d.at) || li.acceptanceLog.some((a) => a.key === x.key));
        if (outstanding.length > 0) problem(`L1: ${d.sender} invited ${d.destination} again at ${new Date(d.at).toISOString()} (for ${d.subjectId}) with an earlier invite outstanding`);
        if (earlier.length > 0) features.add("a-second-invite-after-a-withdrawal");
      }
      const key = `${d.subjectId}|${d.stepId}`;
      if (seen.has(key)) problem(`L1: ${d.subjectId} was sent step ${d.stepId} twice`);
      seen.add(key);
    }
    // L11: no pair ever moves: every action to a (session, profile) is its first subject's, until that subject's invite there
    // was withdrawn unaccepted with no message; and L12: a reply is marked only on the subject that reached the person.
    const ownerOf = new Map<string, { subject: string; releasedAt: number | null }>();
    for (const x of [...li.handoverLog].sort((a, b) => a.at - b.at)) {
      const pair = `${x.sender}|${x.destination}`;
      const own = ownerOf.get(pair);
      if (own && own.subject !== x.subjectId && (own.releasedAt === null || own.releasedAt > x.at)) problem(`L11: ${x.subjectId}'s ${x.action} to ${x.destination} from ${x.sender} at ${new Date(x.at).toISOString()}, a pair ${own.subject} owns`);
      if (!own || own.subject !== x.subjectId) {
        const invites = li.deliveryLog.filter((d) => d.subjectId === x.subjectId && d.sender === x.sender && d.destination === x.destination && d.action === "invite");
        const messaged = li.deliveryLog.some((d) => d.subjectId === x.subjectId && d.sender === x.sender && d.destination === x.destination && d.action === "message");
        const withdrawn = invites.map((d) => li.withdrawalLog.find((w) => w.key === d.key && w.answer === "withdrawn")?.at ?? null);
        const released = !messaged && invites.length > 0 && withdrawn.every((w) => w !== null) && !invites.some((d) => li.acceptanceLog.some((a) => a.key === d.key)) ? Math.max(...withdrawn.map(Number)) : null;
        if (!own || (own.releasedAt !== null && own.releasedAt <= x.at)) ownerOf.set(pair, { subject: x.subjectId, releasedAt: released });
      }
    }
    for (const [id] of marked) {
      if (!li.deliveryLog.some((d) => d.subjectId === id) && !li.presendLog.some((p) => p.answer === "connected" && leadOfSubject(id)?.profile === p.destination)) problem(`L12: ${id} was marked replied on LinkedIn though nothing reached them there`);
    }

    // L2, on the handover log: the engine never even asks the session for a message before the track's connection (an
    // acceptance of its invite, or the check found it connected). The platform would refuse it; the engine must not try.
    for (const d of li.handoverLog.filter((x) => x.action === "message")) {
      const invite = li.deliveryLog.find((x) => x.subjectId === d.subjectId && x.trackId === d.trackId && x.action === "invite");
      const accepted = invite ? li.acceptanceLog.find((a) => a.key === invite.key && a.at <= d.at) : undefined;
      const connected = li.presendLog.some((p) => p.destination === d.destination && p.sender === d.sender && p.answer === "connected" && p.at <= d.at) && !invite;
      if (!accepted && !connected) problem(`L2: ${d.subjectId}'s ${d.stepId} was handed over at ${new Date(d.at).toISOString()} before any connection`);
    }
    for (const d of li.deliveryLog.filter((x) => x.action === "message")) {
      const invite = li.deliveryLog.find((x) => x.subjectId === d.subjectId && x.trackId === d.trackId && x.action === "invite");
      const accepted = invite ? li.acceptanceLog.find((a) => a.key === invite.key && a.at <= d.at) : undefined;
      const connected = !invite;
      if (accepted) features.add("a-message-after-acceptance");
      if (connected) features.add("a-message-to-an-existing-connection");
      // L3: nothing after a marked reply.
      const mark = marked.get(d.subjectId);
      if (mark !== undefined && d.at > mark) problem(`L3: ${d.subjectId} was sent ${d.stepId} at ${new Date(d.at).toISOString()}, after the reply marked at ${new Date(mark).toISOString()}`);
    }
    for (const x of li.handoverLog) {
      const mark = marked.get(x.subjectId);
      if (mark !== undefined && x.at > mark) problem(`L3: ${x.subjectId}'s ${x.stepId} was handed over after the reply marked at ${new Date(mark).toISOString()}`);
      const stop = stopped.get(x.subjectId);
      if (stop !== undefined && x.at > stop) problem(`L3: ${x.subjectId}'s ${x.stepId} was handed over after the lead was stopped at ${new Date(stop).toISOString()}`);
    }
    for (const x of h.fake.handoverLog) {
      const mark = marked.get(x.subjectId);
      if (mark !== undefined && x.at > mark) problem(`L3: ${x.subjectId}'s email ${x.stepId} was handed over after the reply marked at ${new Date(mark).toISOString()}`);
    }

    // L5: allowances, per session and reset day (the user's zone, London), and the notes per calendar month.
    const perDay = new Map<string, number>();
    const notesPerMonth = new Map<string, number>();
    for (const d of li.deliveryLog) {
      const day = local(d.at, "Europe/London").day;
      const k = `${d.sender}|${d.action}|${day}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      const cap = d.action === "invite" ? allowanceOf(d.sender).invites : allowanceOf(d.sender).messages;
      if ((perDay.get(k) ?? 0) > cap) problem(`L5: ${d.sender} sent more than ${cap} ${d.action}s on day ${day}`);
      if (d.action === "invite" && d.rendered.body !== "") {
        const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).format(new Date(d.at));
        const mk = `${d.sender}|${month}`;
        notesPerMonth.set(mk, (notesPerMonth.get(mk) ?? 0) + 1);
        if ((notesPerMonth.get(mk) ?? 0) > allowanceOf(d.sender).notes) problem(`L5: ${d.sender} sent more than ${allowanceOf(d.sender).notes} notes in ${month}`);
      }
    }

    // L7: the note goes exactly while the allowance lasts, from the record's own count of notes before each invite.
    const notesBefore = new Map<string, number>();
    for (const d of [...li.deliveryLog].filter((x) => x.action === "invite").sort((a, b) => a.at - b.at)) {
      const lead = leadOfSubject(d.subjectId);
      const c = lead ? campaigns[lead.campaign] : undefined;
      const noted = (c?.li.steps[0]?.body ?? "") !== "";
      const used = notesBefore.get(d.sender) ?? 0;
      const want = noted && used < allowanceOf(d.sender).notes;
      if (want !== (d.rendered.body !== "")) problem(`L7: ${d.subjectId}'s invite went ${d.rendered.body !== "" ? "with" : "without"} its note, with ${used} of ${allowanceOf(d.sender).notes} notes used`);
      if (d.rendered.body !== "") notesBefore.set(d.sender, used + 1);
      else if (noted) features.add("an-invite-without-its-note");
    }

    for (const lead of leads) {
      const st = await h.store.engine.subject(lead.id, now);
      if (!st) continue;
      const c = campaigns[lead.campaign]!;
      const tp = st.tracks.find((t) => t.trackId === c.li.id);
      const invite = li.deliveryLog.find((x) => x.subjectId === lead.id && x.action === "invite");
      // L13 (every channel): after the drain, no pending step of a running lead is left with nothing that can make it due: a
      // due time, a hold with its reason, or a LinkedIn acceptance wait; and none is due long ago with nothing holding it,
      // which is a lead left waiting on a taken pair (council items 1 and 9).
      if (drained && st.subject.ended === null && !st.subject.leadPaused) {
        const read = (await h.request<{ tracks: { trackId: string; hold: string | null }[] }>("GET", `/api/enrollments/${lead.id}`)).body;
        for (const p of st.tracks) {
          if (p.startedAt === null || p.finishedAt !== null || p.nextStepId === null) continue;
          const hold = read.tracks.find((t) => t.trackId === p.trackId)?.hold ?? null;
          if (p.dueAt === null && (p.acceptBy ?? null) === null && hold === null) problem(`L13: ${lead.id}'s ${p.nextStepId} is pending with nothing that can make it due`);
          if (p.dueWall !== null && p.dueWall < now - 3 * DAY && hold === null && !st.attempts.some((a) => a.stepId === p.nextStepId && a.state !== "withdrawn" && a.state !== "rejected" && a.state !== "sent")) problem(`L13: ${lead.id}'s ${p.nextStepId} has been due since ${new Date(p.dueWall).toISOString()} with nothing holding it`);
        }
      }
      // L6: acceptance is never a reply: only the record's marks end a lead replied.
      if (st.subject.ended === "replied" && !marked.has(lead.id)) problem(`L6: ${lead.id} ended replied with no reply marked`);
      // L9: an existing connection gets no invite, and its first message goes by the drain unless held or ended.
      if (lead.script?.connected) {
        if (li.handoverLog.some((x) => x.subjectId === lead.id && x.action === "invite")) problem(`L9: ${lead.id} is already connected but was sent an invite`);
        features.add("already-connected");
        // A track skipped (by the user, or because another campaign owns the pair, Q41) or ended otherwise sends nothing: L9 asks
        // the first message of a track that is still running, or completed, to have gone.
        const shouldSend = tp?.startedAt != null && (tp.finishedAt === null || tp.finishReason === "completed");
        if (drained && shouldSend && st.subject.ended === null && !stopped.has(lead.id) && !li.deliveryLog.some((x) => x.subjectId === lead.id && x.action === "message")) {
          problem(`L9: ${lead.id} is already connected and its first message never went`);
        }
      }
      if (!tp || !invite) continue;
      // L8: the expiry is at the record's deadline: the invite's send plus the wait in calendar days in the prospect's
      // zone, moved by every interval the lead was held after the send.
      // The deadline on the lead's clock: the calendar-day span from the send, then every held interval before it reaches it.
      // The wait in force: the track's, as last edited before the track finished (or now); an edit after the send re-resolves
      // the deadline from the send, and one that puts it in the past makes it the edit's instant (council item 3).
      const until = tp.finishedWall ?? now;
      const edits = (waitEdits.get(lead.campaign) ?? []).filter((e) => e.at <= until);
      const lastEdit = edits.filter((e) => e.at > invite.at).at(-1);
      const days = edits.at(-1)?.days ?? c.li.acceptWaitDays ?? 1;
      const reckoned = afterHolds(invite.at, dueAfter(invite.at, days, lead.zone) - invite.at, holdsOf(lead));
      const heldAtEdit = lastEdit !== undefined && holdsOf(lead).some((x) => x.from <= lastEdit.at && (x.to ?? Infinity) > lastEdit.at);
      const deadline = lastEdit && reckoned < lastEdit.at ? lastEdit.at : reckoned;
      if (lastEdit) features.add("an-edit-of-the-wait-while-waiting");
      const acceptance = li.acceptanceLog.find((a) => a.key === invite.key);
      const reportedBy = acceptance ? acceptance.at + (lead.script?.acceptReportDelayMs ?? 0) : Infinity;
      if (tp.finishReason === "invite_not_accepted") {
        features.add("an-invite-expired");
        if (outages.some((o) => o.from < deadline && deadline < o.to)) features.add("an-expiry-while-the-laptop-was-off");
        if (tp.finishedWall !== deadline && !heldAtEdit) problem(`L8: ${lead.id}'s invite expired at ${new Date(tp.finishedWall ?? 0).toISOString()}, not at the deadline ${new Date(deadline).toISOString()}`);
        if (acceptance && acceptance.at < deadline && reportedBy <= deadline && !outages.some((o) => o.from <= deadline && reportedBy <= o.to)) problem(`L8: ${lead.id}'s invite expired though it was accepted at ${new Date(acceptance.at).toISOString()}, before the deadline`);
        // L4: no message after a withdrawn invite, and the withdrawal asked within a settling period of the expiry.
        if (li.deliveryLog.some((x) => x.subjectId === lead.id && x.trackId === c.li.id && x.action === "message")) problem(`L4: ${lead.id} was sent a message after its invite expired`);
        if (now > deadline + SETTLING + 2 * H && !outages.some((o) => o.to > deadline && o.from < now) && !li.withdrawalLog.some((w) => w.key === invite.key)) problem(`L4: ${lead.id}'s expired invite was never withdrawn`);
        if (li.withdrawalLog.some((w) => w.key === invite.key && w.answer === "already_accepted")) features.add("a-withdrawal-found-it-accepted");
        if (li.withdrawalLog.some((w) => w.key === invite.key && w.answer === "unknown")) features.add("a-withdrawal-answered-unknown");
        // L10: the lead's other tracks carry on: an email track after the LinkedIn track starts from the expiry.
        if (c.email && c.email.start.kind === "after" && drained && st.subject.ended !== "replied" && !stopped.has(lead.id)) {
          const due = firstOpen(c.email.window, lead.zone, dueAfter(deadline, c.email.start.delayDays, lead.zone));
          const sent = h.fake.deliveryLog.find((x) => x.subjectId === lead.id);
          if (!sent) problem(`L10: ${lead.id}'s email track after LinkedIn never went after the expiry`);
          else if (sent.at < due) problem(`L10: ${lead.id}'s email went at ${new Date(sent.at).toISOString()}, before its start after the expiry ${new Date(due).toISOString()}`);
          features.add("released-after-an-expiry");
        }
      }
      if (st.subject.ended === "finished_no_usable_channel" && tp.finishReason === "invite_not_accepted" && c.email) problem(`L10: ${lead.id} ended with no usable channel at the expiry, though email reaches it`);
      if (tp.connection === "accepted") features.add("connected-by-acceptance");
      if (drained && tp.finishedAt === null && (tp.connection ?? null) === null && (tp.acceptByWall ?? Infinity) + 30 * MIN < now && st.subject.ended === null) problem(`L8: ${lead.id}'s invite still waits past its deadline ${new Date(tp.acceptByWall ?? 0).toISOString()}`);
    }
    if (li.refusals.some((r) => r.reason === "rate_limited")) features.add("a-rate-limit");
    if (li.lookupLog.some((l) => l.answer === "sent")) features.add("a-lost-answer-found-by-lookup");
  }
}
