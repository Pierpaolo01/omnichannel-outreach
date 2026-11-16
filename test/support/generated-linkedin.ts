import { EngineHarness } from "./engine-harness.ts";
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
}

export interface LinkedinRun {
  readonly problems: string[];
  readonly stats: { readonly features: Set<string> };
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
  for (const [ci, c] of campaigns.entries()) {
    const own = leads.filter((l) => l.campaign === ci);
    const { campaign } = await h.createCampaign(`LinkedIn ${ci}`, {
      businesses: [business({ business_id: `b${ci}`, business_name: `Fictional Clinic ${ci}`, phone_e164: `+4420794601${10 + ci}` })],
      people: own.map((l, i) => person({ person_id: `p${ci}-${i}`, business_id: `b${ci}`, full_name: l.name, email: l.email, timezone: l.zone, linkedin_url: (l as Lead & { cell?: string }).cell ?? "" })),
    });
    c.id = campaign.id;
    await h.defineSequence(c.id, c.definition);
    const launched = await h.launch(c.id);
    if (launched.status !== 200) problem(`setup: launch refused ${JSON.stringify(launched.body)}`);
    const rows = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${c.id}`)).body.rows;
    for (const l of own) l.id = rows.find((r) => r.name === l.name)?.enrollments.find((e) => e.campaign.id === c.id)?.id ?? "";
  }

  // --- The record's own log of what the user did.
  const held = new Map<string, { from: number; to: number | null }[]>();
  const marked = new Map<string, number>();
  const stopped = new Set<string>();
  const outages: { from: number; to: number }[] = [];

  // --- Events.
  const end = START + 12 * DAY;
  let requestNo = 0;
  while (h.clock < end && !(options.maxWrites !== undefined && h.writes > options.maxWrites)) {
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
    await check(false);
  }
  // The drain: time passes with no new event, every hold released first.
  for (const l of leads) {
    const open = (held.get(l.id) ?? []).find((x) => x.to === null);
    if (!open) continue;
    const r = await h.request("POST", `/api/enrollments/${l.id}/controls`, { requestId: `g-${++requestNo}`, action: "resume" });
    if (r.status === 200) open.to = h.clock;
  }
  await h.advanceTo(h.clock + 25 * DAY);
  await check(true);
  return { problems, stats: { features } };

  // --- The checks, from the record and the providers' logs.
  async function check(drained: boolean): Promise<void> {
    const li = h.linkedin;
    const now = h.clock;
    const allowanceOf = (session: string) => allowances.get(session) ?? { invites: 0, messages: 0, notes: 0 };
    const leadOfSubject = (id: string) => leads.find((l) => l.id === id);

    // L1: one invite per subject and profile; and each step delivered at most once.
    const seen = new Set<string>();
    for (const d of li.deliveryLog) {
      const key = d.action === "invite" ? `${d.subjectId}|${d.destination}` : `${d.subjectId}|${d.stepId}`;
      if (seen.has(key)) problem(`L1: ${d.subjectId} was sent ${d.action === "invite" ? "a second invite" : `step ${d.stepId} twice`} at ${new Date(d.at).toISOString()}`);
      seen.add(key);
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
      // L6: acceptance is never a reply: only the record's marks end a lead replied.
      if (st.subject.ended === "replied" && !marked.has(lead.id)) problem(`L6: ${lead.id} ended replied with no reply marked`);
      // L9: an existing connection gets no invite, and its first message goes by the drain unless held or ended.
      if (lead.script?.connected) {
        if (li.handoverLog.some((x) => x.subjectId === lead.id && x.action === "invite")) problem(`L9: ${lead.id} is already connected but was sent an invite`);
        features.add("already-connected");
        if (drained && tp?.startedAt != null && st.subject.ended !== "replied" && !stopped.has(lead.id) && !li.deliveryLog.some((x) => x.subjectId === lead.id && x.action === "message")) {
          problem(`L9: ${lead.id} is already connected and its first message never went`);
        }
      }
      if (!tp || !invite) continue;
      // L8: the expiry is at the record's deadline: the invite's send plus the wait in calendar days in the prospect's
      // zone, moved by every interval the lead was held after the send.
      // The deadline on the lead's clock: the calendar-day span from the send, then every held interval before it reaches it.
      const deadline = afterHolds(invite.at, dueAfter(invite.at, c.li.acceptWaitDays ?? 1, lead.zone) - invite.at, held.get(lead.id) ?? []);
      const acceptance = li.acceptanceLog.find((a) => a.key === invite.key);
      const reportedBy = acceptance ? acceptance.at + (lead.script?.acceptReportDelayMs ?? 0) : Infinity;
      if (tp.finishReason === "invite_not_accepted") {
        features.add("an-invite-expired");
        if (outages.some((o) => o.from < deadline && deadline < o.to)) features.add("an-expiry-while-the-laptop-was-off");
        if (tp.finishedWall !== deadline) problem(`L8: ${lead.id}'s invite expired at ${new Date(tp.finishedWall ?? 0).toISOString()}, not at the deadline ${new Date(deadline).toISOString()}`);
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
