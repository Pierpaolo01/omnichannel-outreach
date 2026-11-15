import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../src/domain/sequence/definition.ts";
import type { Rules } from "../../src/server/engine/rules.ts";
import type { EditImpactView, EnrollmentProgress, EnrollmentRead, LeadSearchResult } from "../../src/shared/api.ts";
import { EngineHarness, quickWait } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import type { FakeAccount } from "./fake-email-port.ts";
import { random } from "./generated-sequences.ts";
import { dueAfter, local } from "./sequence-model.ts";

/**
 * Generated edit runs (ticket 19; ADR 0003 "Ticket 19"): the user edits a running campaign at random instants through
 * the real HTTP app, SQLite store and engine, against the fake email provider, on a clock the test advances.
 *
 * Generated: one campaign of three to five leads (one without an email in some runs), an email track of two to four
 * emails at launch, and in half the runs a second email track after it or beside it; a provider that sends at once,
 * or up to an hour late. At random instants (during a wait, with work handed over and not yet sent, while the
 * campaign is paused, and now and then between a claim and its handover, from another process) the user saves an
 * edit: copy, a wait, a step added (before, inside or after where each lead is), a step removed, a track added (at
 * launch or after another), a track removed, a track reconnected (another start or delay); now and then an edit the
 * save must refuse (a deleted step, a removed step restored, an empty email), pauses and resumes the campaign,
 * leads reply, and a Skip confirmed on a read taken before an edit that changed it is sent. A drain resumes the
 * campaign and lets every lead finish.
 *
 * The record imports nothing from src/domain/sequence/. It keeps every definition the user saved, in the order of the
 * providers' handover log, the campaign's paused intervals, the providers' handovers, deliveries and withdrawals, and,
 * for what a lead had started or finished at an edit, the enrollment read taken at that instant (a stored fact the
 * store never rewrites, E8). From those it checks, after every event, E1 to E13 of ADR 0003 "Ticket 19".
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Europe/London";
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
/** The other zone a campaign's default is edited to, and back (council on 93bed86, item 8). */
const OTHER_ZONE = "America/New_York";
const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));
type Window = readonly { readonly day: number; readonly start: number; readonly end: number }[];
/** Whether `t` is inside `window` in `zone`, by the record's own calendar (sequence-model.ts). */
const inWindow = (t: number, window: Window, zone: string) => {
  const l = local(t, zone);
  return window.some((w) => w.day === l.weekday && l.minute >= w.start * 60 && l.minute < w.end * 60);
};
/** The first instant at or after `t` inside `window` in `zone`: `t`, or the next whole hour that is. */
const nextOpen = (t: number, window: Window, zone: string) => {
  if (!Number.isFinite(t) || inWindow(t, window, zone)) return t;
  for (let h = Math.ceil(t / 3_600_000) * 3_600_000, n = 0; n < 24 * 9; h += 3_600_000, n++) if (inWindow(h, window, zone)) return h;
  return Infinity;
};
/** How long after its due instant a step may be handed over when nothing else delays it: ticks, the one-minute gap, a few leads. */
const TOLERANCE = 2 * HOUR;

export interface EditRunOptions {
  readonly rules?: Partial<Rules>;
  readonly events?: number;
  readonly maxWrites?: number;
  /** For a mutation (verifier F7 on 7afa03d): the fake provider changes the body of work it holds, after the handover. */
  readonly changeHandedCopy?: boolean;
}
export interface EditRunResult {
  readonly problems: string[];
  readonly stats: { readonly features: readonly string[]; readonly writes: number };
}

/** The invariants a problem names: the labels before its first colon. */
export const editInvariantsOf = (problem: string): string[] => (problem.split(":")[0] ?? "").split("/").map((x) => x.trim());

const iso = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? "never" : new Date(t).toISOString());

export async function runEdits(seed: number, options: EditRunOptions = {}): Promise<EditRunResult> {
  try {
    return await runUnguarded(seed, options);
  } catch (error) {
    if (process.env["EDITS_DEBUG"]) console.error(error);
    return { problems: [`throw: ${error instanceof Error ? error.message : String(error)}`], stats: { features: [], writes: 0 } };
  }
}

interface Edit {
  /** The handover log's length when it was saved: the definition in force for every handover after. */
  readonly logIndex: number;
  readonly at: number;
  readonly def: CampaignDefinition;
  /** `lead|track` for every track each lead had started when the edit was saved (its read then). */
  readonly started?: ReadonlySet<string>;
}

async function runUnguarded(seed: number, options: EditRunOptions): Promise<EditRunResult> {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] ?? items[0]!;
  const chance = (p: number) => rand() < p;
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const problems: string[] = [];
  const problem = (what: string) => {
    if (problems.length < 20 && !problems.includes(what)) problems.push(what);
  };
  const features = new Set<string>();

  const start = Date.parse("2026-11-02T00:00:00Z") + int(0, 6) * DAY + int(0, 23) * HOUR;
  const late = chance(0.5);
  if (late) features.add("late-sends");
  const inbox: FakeAccount = { id: "inbox-a", capacity: 500, gapMs: MINUTE, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" };
  const h = new EngineHarness({ start, accounts: [inbox], modes: late ? ["honest", "late-send"] : ["honest"], random: random(seed ^ 0x19), engine: { waitFor: quickWait }, ...(options.rules ? { rules: options.rules } : {}) });
  h.maxWrites = options.maxWrites ?? null;
  const email = h.fake;
  if (options.changeHandedCopy === true) {
    const fake = email as unknown as { work: { request: { rendered: { subject: string; body: string } }; sentAt: number | null }[]; advance: () => void };
    const advance = fake.advance.bind(email);
    fake.advance = () => {
      for (const w of fake.work) if (w.sentAt === null) w.request = { ...w.request, rendered: { ...w.request.rendered, body: "Changed after the handover." } };
      advance();
    };
  }

  // --- The campaign. ---
  let version = 0;
  let nextId = 0;
  const copy = (id: string): Pick<StepDefinition, "subject" | "body"> => ({ subject: `Subject ${id} v${++version}`, body: `Body ${id} v${version}.` });
  const newStep = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, threading: "new_subject", removed: false, ...copy(id) });
  const track = (id: string, steps: StepDefinition[], start: TrackDefinition["start"] = { kind: "entry" }): TrackDefinition => ({ id, channel: "email", branch: "main", window: ALL_DAY, steps, start, removed: false });
  const stepsOf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => newStep(`${prefix}s${i + 1}`, i === 0 ? 0 : int(1, 3)));
  const tracks = [track("e1", stepsOf("e1", int(2, 4)))];
  if (chance(0.5)) tracks.push(track("e2", stepsOf("e2", int(1, 2)), chance(0.6) ? { kind: "after", trackId: "e1", delayDays: int(0, 2) } : { kind: "entry" }));
  let current: CampaignDefinition = { timezone: ZONE, callSkipLimitDays: 2, emailPool: [inbox.id], smsPool: [], callScript: "", tracks };

  // Every lead is on the campaign's default zone: neither person nor company has one, so a zone edit moves them all.
  const people = Array.from({ length: int(3, 5) }, (_, i) => person({ person_id: `p${i}`, business_id: "b1", full_name: `Lead ${i} Example`, timezone: "", email: i === 0 && chance(0.3) ? "" : `lead${i}@clinic${seed}.example` }));
  await h.tick();
  const { campaign } = await h.createCampaign("Edits", { businesses: [business({ business_id: "b1", business_name: "Clinic Example", phone_e164: "+442079460101", timezone: "" })], people });
  await h.defineSequence(campaign.id, current);
  const launchedAt = h.clock;
  const launched = await h.launch(campaign.id);
  if (launched.status !== 200) return { problems: [`setup: launch refused ${JSON.stringify(launched.body)}`], stats: { features: [], writes: 0 } };
  const leads = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows.flatMap((r) => r.enrollments.map((e) => e.id));

  // --- The record. ---
  const edits: Edit[] = [{ logIndex: 0, at: launchedAt, def: current }];
  const defAt = (logIndex: number) => [...edits].reverse().find((e) => e.logIndex <= logIndex)?.def ?? current;
  const pauses: { from: number; to: number | null }[] = [];
  /** Steps removed at an edit that a lead had not been handed: never handed to it afterwards (E5). */
  const skipped: { lead: string; stepId: string; at: number; logIndex: number }[] = [];
  /** Tracks removed at an edit that a lead had not started: never handed to it afterwards (E9). */
  const notStarted: { lead: string; trackId: string; logIndex: number }[] = [];
  /** Steps added at an edit, and the leads still before them in their track then (E4). */
  const added: { stepId: string; trackId: string; at: number; logIndex: number; reaches: Set<string> }[] = [];
  /** The first read at which each lead's track was finished (E3). */
  const finishedSeen = new Map<string, { logIndex: number; at: number }>();
  /** Each lead's results and started tracks as last read (E8). */
  const lastRead = new Map<string, { results: Set<string>; started: Set<string> }>();
  /** When each track was added or its start last changed. */
  const ruleChanged = new Map<string, number>(tracks.map((t) => [t.id, launchedAt]));
  let checkedHandovers = 0;
  /** A save of the user's own is in flight: its tick's claims must not start a second edit from another process. */
  let saving = false;

  const read = async (id: string) => (await h.request<EnrollmentProgress>("GET", `/api/enrollments/${id}`)).body;
  const trackOfStep = (def: CampaignDefinition, stepId: string) => def.tracks.find((t) => t.steps.some((s) => s.id === stepId));
  const handedBy = (lead: string, stepId: string, logIndex: number) => email.handoverLog.slice(0, logIndex).some((x) => x.subjectId === lead && x.stepId === stepId);
  /** The wall instant a lead's clock, running from `from`, reaches `from + span`, moved by every pause after `from`. */
  const shifted = (from: number, span: number): number => {
    let t = from;
    let remaining = span;
    for (const p of [...pauses].sort((a, b) => a.from - b.from)) {
      const to = p.to ?? Infinity;
      if (to <= t) continue;
      if (p.from > t) {
        if (t + remaining <= p.from) return t + remaining;
        remaining -= p.from - t;
      }
      t = to;
    }
    return t + remaining;
  };
  /** The start rule and zone in force for a lead's track when it started: those of the last edit at which it had not. */
  const startRuleOf = (lead: string, trackId: string, logIndex: number): { start: TrackDefinition["start"]; zone: string } => {
    let def = edits[0]!.def;
    for (const e of edits) {
      if (e.logIndex > logIndex || e.started?.has(`${lead}|${trackId}`)) break;
      def = e.def;
    }
    return { start: def.tracks.find((x) => x.id === trackId)?.start ?? { kind: "entry" }, zone: def.timezone };
  };
  /** `t`, or the end of the pause holding `t`. */
  const runningFrom = (t: number) => pauses.find((p) => p.from <= t && (p.to === null || t < p.to))?.to ?? (pauses.some((p) => p.from <= t && p.to === null) ? Infinity : t);
  const pausedAt = (t: number) => pauses.some((p) => p.from < t && (p.to === null || t < p.to));
  /** The point a lead's clock stood at at wall instant t: a pause's start inside it. */
  const pointOf = (t: number) => pauses.find((p) => p.from <= t && (p.to === null || t < p.to))?.from ?? t;

  async function snapshot() {
    const reads = new Map<string, EnrollmentProgress>();
    for (const id of leads) reads.set(id, await read(id));
    return reads;
  }

  /** Checks every handover since the last check, and the reads (E1 to E11 that need no drain). */
  async function check(): Promise<void> {
    const log = email.handoverLog;
    for (let i = checkedHandovers; i < log.length; i++) {
      const x = log[i]!;
      const def = defAt(i);
      const t = trackOfStep(def, x.stepId);
      const step = t?.steps.find((s) => s.id === x.stepId);
      // E10: nothing is handed over while the campaign is paused.
      // E14: no empty message is ever handed over (the three blockers hold over what leads still run).
      if (x.rendered.body.trim() === "") problem(`E14: an empty ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)}`);
      if (pausedAt(x.at)) problem(`E10: ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)}, while the campaign was paused`);
      const sameKey = log.slice(0, i).find((y) => y.key === x.key);
      // E2: a repeat call carries the first call's payload; no step is handed over after it was delivered.
      if (sameKey && JSON.stringify(sameKey.rendered) !== JSON.stringify(x.rendered)) problem(`E2: a repeat of ${x.key} carried other copy than its first call`);
      if (email.deliveryLog.some((d) => d.subjectId === x.subjectId && d.stepId === x.stepId && d.at < x.at && d.key !== x.key)) problem(`E1/E2: ${x.stepId} was handed to ${x.subjectId} again at ${iso(x.at)}, after it was sent`);
      if (sameKey) continue;
      if (!t || !step) {
        problem(`E5: ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)}, a step the definition in force does not hold`);
        continue;
      }
      // E6: a first handover carries the copy in force.
      if (x.rendered.body !== step.body || x.rendered.subject !== step.subject) problem(`E6: ${x.stepId} went to ${x.subjectId} at ${iso(x.at)} with "${x.rendered.body}", not the copy in force "${step.body}"`);
      if (step.removed) problem(`E5: ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)} after it was removed`);
      for (const s of skipped) if (s.lead === x.subjectId && s.stepId === x.stepId && s.logIndex <= i) problem(`E5: ${x.stepId}, removed at ${iso(s.at)} before ${x.subjectId} reached it, was handed to it at ${iso(x.at)}`);
      for (const n of notStarted) if (n.lead === x.subjectId && n.trackId === t.id && n.logIndex <= i) problem(`E9: a step of ${t.id}, removed before ${x.subjectId} started it, was handed to it at ${iso(x.at)}`);
      for (const a of added) if (a.stepId === x.stepId && a.logIndex <= i && !a.reaches.has(x.subjectId)) problem(`E4: ${x.stepId}, added at ${iso(a.at)} behind or after the end of ${x.subjectId}'s place, was handed to it at ${iso(x.at)}`);
      const done = finishedSeen.get(`${x.subjectId}|${t.id}`);
      if (done && done.logIndex <= i) problem(`E3: ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)}, after its track ${t.id} finished (read at ${iso(done.at)})`);
      // E11: no other step of the track is with the provider unanswered.
      const flying = log.slice(0, i).filter((y) => y.subjectId === x.subjectId && y.stepId !== x.stepId && trackOfStep(defAt(i), y.stepId)?.id === t.id);
      for (const y of flying) {
        // Sent before (the app may learn of it by a lookup before the event is visible), or confirmed withdrawn.
        const settled = email.deliveryLog.some((d) => d.key === y.key && d.at <= x.at) || email.withdrawLog.some((w) => w.key === y.key && w.answer === "withdrawn" && w.at <= x.at);
        if (!settled) problem(`E11: ${x.stepId} was handed to ${x.subjectId} at ${iso(x.at)} while ${y.stepId} of the same track was with the provider${process.env["EDITS_DEBUG"] ? ` [handovers ${JSON.stringify(log.slice(0, i + 1).filter((z) => z.subjectId === x.subjectId).map((z) => [z.stepId, z.key, iso(z.at), z.mode]))} deliveries ${JSON.stringify(email.deliveryLog.filter((d) => d.subjectId === x.subjectId).map((d) => [d.stepId, d.key, iso(d.at), iso(d.visibleAt)]))} withdrawals ${JSON.stringify(email.withdrawLog)} edits ${JSON.stringify(edits.map((e) => [iso(e.at), e.logIndex, e.def.tracks.filter((tt) => tt.id === t.id).map((tt) => tt.steps.map((ss) => `${ss.id}${ss.removed ? "x" : ""}:${ss.waitDays}`).join(" "))]))} pauses ${JSON.stringify(pauses.map((p) => [iso(p.from), iso(p.to)]))}]` : ""}`);
      }
      // E7: due from its basis (the track's latest delivery), with the wait in force, moved by every pause.
      const prior = email.deliveryLog.filter((d) => d.subjectId === x.subjectId && d.stepId !== x.stepId && d.at <= x.at && trackOfStep(def, d.stepId)?.id === t.id).sort((a, b) => a.at - b.at).at(-1);
      if (prior) {
        const basis = pointOf(prior.at);
        // In the campaign's zone in force at the handover (council on 93bed86, item 8), inside the track's window in it.
        const zone = def.timezone;
        const due = shifted(basis, dueAfter(basis, step.waitDays, zone) - basis);
        if (x.at < due - 1) problem(`E7: ${x.stepId} went to ${x.subjectId} at ${iso(x.at)}, before its due instant ${iso(due)} (${step.waitDays} days after ${iso(prior.at)}, in ${zone})`);
        if (!inWindow(x.at, t.window, zone)) problem(`E7: ${x.stepId} went to ${x.subjectId} at ${iso(x.at)}, outside its track's window in ${zone}`);
        // Not before the app knew of the send, nor before the edit that put this wait in force, nor outside the window.
        const known = nextOpen(runningFrom(Math.max(due, prior.visibleAt, [...edits].reverse().find((e) => e.logIndex <= i)?.at ?? 0)), t.window, zone);
        if (!late && x.at > known + TOLERANCE) problem(`E7: ${x.stepId} went to ${x.subjectId} at ${iso(x.at)}, long after its due instant ${iso(due)} (${step.waitDays} days after ${iso(prior.at)})${process.env["EDITS_DEBUG"] ? ` [edits ${JSON.stringify(edits.map((e) => [iso(e.at), e.logIndex, e.def.tracks.map((tt) => [tt.id, tt.removed, JSON.stringify(tt.start), tt.steps.map((ss) => `${ss.id}${ss.removed ? "x" : ""}:${ss.waitDays}`).join(" ")])]))} pauses ${JSON.stringify(pauses.map((p) => [iso(p.from), iso(p.to)]))} lead ${JSON.stringify(log.filter((y) => y.subjectId === x.subjectId).map((y) => [y.stepId, iso(y.at)]))}]` : ""}`);
        features.add("a-follow-up-timed");
      } else if (!late && startRuleOf(x.subjectId, t.id, i).start.kind === "entry") {
        // E9: a track at launch starts at once for every lead running when it was drawn or connected so.
        const from = nextOpen(runningFrom(Math.max(launchedAt, ruleChanged.get(t.id) ?? launchedAt, [...edits].reverse().find((e) => e.logIndex <= i)?.at ?? 0)), t.window, def.timezone);
        if (x.at > from + TOLERANCE) problem(`E9: ${t.id}, which starts at launch since ${iso(ruleChanged.get(t.id))}, started for ${x.subjectId} only at ${iso(x.at)}`);
        features.add("a-track-start-timed");
      } else if (!late && startRuleOf(x.subjectId, t.id, i).start.kind === "after") {
        // E9: a track after another starts by the rule in force when it started, from that track's finish: an edit after
        // the lead started it does not move it, so the rule is the one of the last edit at which the lead had not.
        const ruled = startRuleOf(x.subjectId, t.id, i);
        const startRule = ruled.start;
        if (startRule.kind !== "after") continue;
        const { trackId: after, delayDays } = startRule;
        const finish = Date.parse((await read(x.subjectId)).tracks.find((p) => p.trackId === after)?.finishedAt ?? "");
        if (Number.isFinite(finish)) {
          const due = shifted(pointOf(finish), dueAfter(pointOf(finish), delayDays, ruled.zone) - pointOf(finish));
          if (x.at < due - 1) problem(`E9: ${t.id} started for ${x.subjectId} at ${iso(x.at)}, before ${iso(due)}, its start after ${after} finished at ${iso(finish)}${process.env["EDITS_DEBUG"] ? ` [delay ${delayDays} zone ${def.timezone} edits ${JSON.stringify(edits.map((e) => [iso(e.at), e.logIndex, e.def.timezone, JSON.stringify(e.def.tracks.find((tt) => tt.id === t.id)?.start ?? null)]))} pauses ${JSON.stringify(pauses.map((q) => [iso(q.from), iso(q.to)]))} i ${i}]` : ""}`);
          if (x.at > nextOpen(runningFrom(Math.max(due, ruleChanged.get(t.id) ?? 0, [...edits].reverse().find((e) => e.logIndex <= i)?.at ?? 0)), t.window, def.timezone) + TOLERANCE) problem(`E9: ${t.id} started for ${x.subjectId} at ${iso(x.at)}, long after ${iso(due)}, its start after ${after} finished at ${iso(finish)}`);
          features.add("a-track-start-timed");
        }
      }
    }
    checkedHandovers = log.length;
    // E1: delivered at most once. E6 (verifier F7 on 7afa03d; question Q25's interim): each delivery carries exactly the
    // copy its work was first handed over with, whatever was edited meanwhile.
    const seen = new Set<string>();
    for (const d of email.deliveryLog) {
      const handedWith = email.handoverLog.find((x) => x.key === d.key);
      if (!handedWith) problem(`E6: ${d.stepId} was delivered to ${d.subjectId} with no handover of its work`);
      else if (handedWith.rendered.subject !== d.rendered.subject || handedWith.rendered.body !== d.rendered.body) problem(`E6: ${d.stepId} was delivered to ${d.subjectId} as "${d.rendered.body}", not as it was handed over ("${handedWith.rendered.body}")`);
      const k = `${d.subjectId}|${d.stepId}`;
      if (seen.has(k)) problem(`E1: ${d.stepId} was delivered to ${d.subjectId} twice`);
      seen.add(k);
    }
    // E3 and E8 from the reads.
    for (const id of leads) {
      const r = await read(id);
      const results = new Set(r.tracks.flatMap((t) => t.steps.filter((s) => s.result !== null).map((s) => s.stepId)));
      const started = new Set(r.tracks.filter((t) => t.started).map((t) => t.trackId));
      const last = lastRead.get(id);
      if (last) {
        for (const s of last.results) if (!results.has(s)) problem(`E8: ${id}'s result for ${s} disappeared`);
        for (const s of last.started) if (!started.has(s)) problem(`E8: ${id}'s track ${s} is no longer started`);
      }
      lastRead.set(id, { results, started });
      for (const t of r.tracks) {
        const key = `${id}|${t.trackId}`;
        if (t.finishedAt !== null && !finishedSeen.has(key)) finishedSeen.set(key, { logIndex: email.handoverLog.length, at: h.clock });
        if (t.finishedAt === null && finishedSeen.has(key)) problem(`E3: ${id}'s track ${t.trackId} was finished, and is not any more`);
      }
    }
  }

  /** Saves `next` and records what it does, or checks that a refusal changed nothing (E13). */
  async function save(next: CampaignDefinition, label: string, mustRefuse: boolean | "either" = false): Promise<void> {
    const before = await snapshot();
    const stored = JSON.stringify((await h.request<{ definition: unknown }>("GET", `/api/campaigns/${campaign.id}/sequence`)).body.definition);
    // An accepted save runs a tick at once, under the new definition: it is in force for every handover from here.
    const logIndex = email.handoverLog.length;
    // E15 (council on 93bed86, item 9): the read taken at this instant, for exactly this body, against what the record then
    // classifies from the providers' logs and the reads.
    const impact = mustRefuse === false ? (await h.request<EditImpactView>("POST", `/api/campaigns/${campaign.id}/sequence/impact`, { definition: next })).body : null;
    saving = true;
    const res = await h.request<{ error?: { code: string; message: string } }>("PUT", `/api/campaigns/${campaign.id}/sequence`, next).finally(() => {
      saving = false;
    });
    // An empty email in a removed track (review bot on 7afa03d): refused while a lead still runs it, else saved, and either
    // way E14 holds (no empty message is ever handed over).
    if (mustRefuse === "either") {
      if (res.status === 200) {
        record(current, next, before, h.clock, logIndex);
        features.add("an-empty-email-in-a-removed-track-nobody-runs-saved");
      } else features.add("refused-an-empty-email-in-a-removed-track-a-lead-runs");
      return;
    }
    if (mustRefuse) {
      if (res.status === 200) problem(`E13: the save refused ${label}, but it was answered 200`);
      const after = JSON.stringify((await h.request<{ definition: unknown }>("GET", `/api/campaigns/${campaign.id}/sequence`)).body.definition);
      if (after !== stored) problem(`E13: a refused edit (${label}) changed the stored definition`);
      for (const id of leads) if (JSON.stringify(await read(id)) !== JSON.stringify(before.get(id))) problem(`E13: a refused edit (${label}) changed ${id}'s progress`);
      features.add(`refused-${label}`);
      return;
    }
    if (res.status !== 200) {
      problem(`setup: the edit ${label} was refused: ${JSON.stringify(res.body)}`);
      return;
    }
    const counted = record(current, next, before, h.clock, logIndex);
    for (const c of impact?.changes ?? []) {
      const key = `${c.kind}|${c.trackId ?? ""}|${c.stepId ?? ""}`;
      const expected = counted.get(key);
      if (expected === undefined) continue;
      const said = c.kind === "step_added" ? c.reaches : c.skips;
      if (said !== expected) problem(`E15: the read said ${said} for ${key} at ${iso(h.clock)}; the run classifies ${expected}`);
      else features.add(`a-read-count-checked-${c.kind}`);
    }
    features.add(`edit-${label}${pauses.some((p) => p.to === null) ? "-while-paused" : ""}`);
  }

  /**
   * Records what an accepted edit does, and returns the record's own count per change (E15): the leads an added step
   * reaches, the running leads a removed step or track skips.
   */
  function record(previous: CampaignDefinition, next: CampaignDefinition, before: ReadonlyMap<string, EnrollmentProgress>, at: number, logIndex = email.handoverLog.length): Map<string, number> {
    const counted = new Map<string, number>();
    const running = (lead: string, trackId: string) => {
      const r = before.get(lead);
      return r !== undefined && r.endedAt === null && !r.tracks.find((p) => p.trackId === trackId)?.finishedAt;
    };
    edits.push({ logIndex, at, def: next, started: new Set(leads.flatMap((lead) => (before.get(lead)?.tracks ?? []).filter((p) => p.started).map((p) => `${lead}|${p.trackId}`))) });
    current = next;
    const old = new Map(previous.tracks.map((t) => [t.id, t]));
    for (const t of next.tracks) {
      const was = old.get(t.id);
      if (!was || JSON.stringify(was.start) !== JSON.stringify(t.start)) ruleChanged.set(t.id, at);
      if (t.removed && was && !was.removed) {
        for (const lead of leads) if (!before.get(lead)?.tracks.find((p) => p.trackId === t.id)?.started) notStarted.push({ lead, trackId: t.id, logIndex });
        counted.set(`track_removed|${t.id}|`, leads.filter((lead) => running(lead, t.id) && !before.get(lead)?.tracks.find((p) => p.trackId === t.id)?.started).length);
        features.add("a-track-removed");
      }
      if (!was) continue;
      t.steps.forEach((s, index) => {
        const o = was.steps.find((x) => x.id === s.id);
        if (s.removed && o && !o.removed) {
          for (const lead of leads) {
            if (handedBy(lead, s.id, logIndex)) features.add("a-step-removed-after-a-lead-reached-it");
            else skipped.push({ lead, stepId: s.id, at, logIndex });
          }
          // Not yet at it: neither it nor a step after it handed over (a step behind the lead, Q22, is past, not skipped).
          const later = was.steps.slice(was.steps.findIndex((y) => y.id === s.id) + 1);
          counted.set(`step_removed|${t.id}|${s.id}`, leads.filter((lead) => running(lead, t.id) && !handedBy(lead, s.id, logIndex) && !later.some((y) => handedBy(lead, y.id, logIndex))).length);
        }
        if (!o) {
          const reaches = new Set<string>();
          for (const lead of leads) {
            const r = before.get(lead);
            const p = r?.tracks.find((x) => x.trackId === t.id);
            if (!r || r.endedAt !== null || p?.finishedAt) continue;
            const later = t.steps.slice(index + 1).some((x) => handedBy(lead, x.id, logIndex));
            if (!later) reaches.add(lead);
            else features.add("a-step-added-behind-a-lead");
          }
          if (reaches.size > 0) features.add("a-step-added-ahead-of-a-lead");
          added.push({ stepId: s.id, trackId: t.id, at, logIndex, reaches });
          counted.set(`step_added|${t.id}|${s.id}`, reaches.size);
        }
      });
    }
    return counted;
  }

  // --- Edits the user makes. ---

  const live = (def: CampaignDefinition) => def.tracks.filter((t) => !t.removed);
  const liveSteps = (t: TrackDefinition) => t.steps.filter((s) => !s.removed);
  const withTrack = (def: CampaignDefinition, id: string, change: (t: TrackDefinition) => TrackDefinition): CampaignDefinition => ({ ...def, tracks: def.tracks.map((t) => (t.id === id ? change(t) : t)) });
  const waitsOn = (def: CampaignDefinition, t: TrackDefinition, on: string): boolean => {
    for (let x: TrackDefinition | undefined = t, n = 0; x && x.start.kind === "after" && n < 10; n++) {
      if (x.start.trackId === on) return true;
      const after: string = x.start.trackId;
      x = def.tracks.find((y) => y.id === after);
    }
    return false;
  };

  function anEdit(): { def: CampaignDefinition; label: string } | null {
    const def = current;
    const t = pick(live(def));
    const steps = liveSteps(t);
    switch (pick(["copy", "wait", "add-step", "remove-step", "add-track", "remove-track", "reconnect"] as const)) {
      case "copy": {
        const s = pick(steps);
        return { def: withTrack(def, t.id, (x) => ({ ...x, steps: x.steps.map((y) => (y.id === s.id ? { ...y, ...copy(y.id) } : y)) })), label: "copy" };
      }
      case "wait": {
        const s = steps[int(1, steps.length - 1)];
        if (!s || steps.length < 2) return null;
        const waitDays = (s.waitDays + int(1, 3)) % 4;
        return { def: withTrack(def, t.id, (x) => ({ ...x, steps: x.steps.map((y) => (y.id === s.id ? { ...y, waitDays } : y)) })), label: waitDays > s.waitDays ? "longer-wait" : "shorter-wait" };
      }
      case "add-step": {
        const at = int(0, t.steps.length);
        const id = `${t.id}n${++nextId}`;
        // A step added before every live one is the first email: no wait.
        const first = t.steps.slice(0, at).every((s) => s.removed);
        const s = newStep(id, first ? 0 : int(0, 2));
        const stepsNext = [...t.steps.slice(0, at), s, ...t.steps.slice(at)];
        return { def: withTrack(def, t.id, (x) => ({ ...x, steps: stepsNext })), label: "add-step" };
      }
      case "remove-step": {
        if (steps.length < 2) return null;
        const s = pick(steps);
        const wasFirst = steps[0]?.id === s.id;
        return {
          def: withTrack(def, t.id, (x) => {
            const marked = x.steps.map((y) => (y.id === s.id ? { ...y, removed: true } : y));
            const nextFirst = marked.find((y) => !y.removed);
            return { ...x, steps: wasFirst && nextFirst ? marked.map((y) => (y.id === nextFirst.id ? { ...y, waitDays: 0 } : y)) : marked };
          }),
          label: "remove-step",
        };
      }
      case "add-track": {
        const id = `t${++nextId}`;
        const startRule: TrackDefinition["start"] = chance(0.5) ? { kind: "entry" } : { kind: "after", trackId: pick(live(def)).id, delayDays: int(0, 2) };
        return { def: { ...def, tracks: [...def.tracks, track(id, stepsOf(id, int(1, 2)), startRule)] }, label: startRule.kind === "entry" ? "add-track-at-launch" : "add-track-after-another" };
      }
      case "remove-track": {
        if (live(def).length < 2 || live(def).some((x) => x.start.kind === "after" && x.start.trackId === t.id)) return null;
        return { def: withTrack(def, t.id, (x) => ({ ...x, removed: true })), label: "remove-track" };
      }
      case "reconnect": {
        const others = live(def).filter((x) => x.id !== t.id && !waitsOn(def, x, t.id));
        const startRule: TrackDefinition["start"] = others.length === 0 || chance(0.3) ? { kind: "entry" } : { kind: "after", trackId: pick(others).id, delayDays: int(0, 3) };
        if (JSON.stringify(startRule) === JSON.stringify(t.start)) return null;
        return { def: withTrack(def, t.id, (x) => ({ ...x, start: startRule })), label: "reconnect" };
      }
    }
  }

  function aRefusedEdit(): { def: CampaignDefinition; label: string } | null {
    const def = current;
    const t = pick(live(def));
    switch (pick(["delete-step", "restore", "empty-copy"] as const)) {
      case "delete-step": {
        const s = pick(t.steps);
        return { def: withTrack(def, t.id, (x) => ({ ...x, steps: x.steps.filter((y) => y.id !== s.id) })), label: "a-deleted-step" };
      }
      case "restore": {
        const gone = def.tracks.flatMap((x) => x.steps.filter((s) => s.removed).map((s) => [x.id, s.id] as const))[0];
        if (!gone) return null;
        return { def: withTrack(def, gone[0], (x) => ({ ...x, steps: x.steps.map((y) => (y.id === gone[1] ? { ...y, removed: false } : y)) })), label: "a-restored-step" };
      }
      case "empty-copy": {
        const s = pick(liveSteps(t));
        return { def: withTrack(def, t.id, (x) => ({ ...x, steps: x.steps.map((y) => (y.id === s.id ? { ...y, body: "" } : y)) })), label: "empty-copy" };
      }
    }
  }

  /**
   * From a stream of its own, edits aimed at the moments the rule is about: a step removed while a lead's copy of it is
   * with the provider and a later step follows (E11), and a track reconnected while a lead waits out its delay (E9).
   */
  const rt = random(seed ^ 0x1919);
  const rc = random(seed ^ 0xf7f7);
  async function aTargetedEdit(): Promise<{ def: CampaignDefinition; label: string } | null> {
    if (rt() > 0.45) return null;
    const def = current;
    const flying = email.handoverLog.filter((x) => !email.deliveryLog.some((d) => d.key === x.key) && !email.withdrawLog.some((w) => w.key === x.key && w.answer === "withdrawn"));
    for (const x of flying) {
      const t = def.tracks.find((tt) => !tt.removed && tt.steps.some((st) => st.id === x.stepId && !st.removed));
      if (!t) continue;
      const steps = liveSteps(t);
      const index = steps.findIndex((st) => st.id === x.stepId);
      if (index < 0 || index === steps.length - 1 || index === 0) continue;
      features.add("a-step-removed-while-with-the-provider");
      return { def: withTrack(def, t.id, (tt) => ({ ...tt, steps: tt.steps.map((st) => (st.id === x.stepId ? { ...st, removed: true } : st)) })), label: "remove-step" };
    }
    // Verifier F7 on 7afa03d: when no such step can be removed, the copy of a step whose work is with the provider is changed now and then.
    const flyingCopy = flying.find((x) => def.tracks.some((tt) => !tt.removed && tt.steps.some((st) => st.id === x.stepId && !st.removed)));
    if (flyingCopy && rc() < 0.5) {
      const t = def.tracks.find((tt) => tt.steps.some((st) => st.id === flyingCopy.stepId))!;
      features.add("a-copy-edit-while-that-step-is-with-the-provider");
      return { def: withTrack(def, t.id, (tt) => ({ ...tt, steps: tt.steps.map((st) => (st.id === flyingCopy.stepId ? { ...st, ...copy(st.id) } : st)) })), label: "copy" };
    }
    for (const id of leads) {
      const r = await read(id);
      for (const t of live(def)) {
        if (t.start.kind !== "after") continue;
        const before = t.start.trackId;
        const mine = r.tracks.find((p) => p.trackId === t.id);
        if (r.endedAt !== null || mine?.started || !r.tracks.find((p) => p.trackId === before)?.finishedAt) continue;
        const delayDays = t.start.delayDays === 0 ? int(1, 3) : t.start.delayDays - 1;
        features.add("a-track-reconnected-while-a-lead-waits-for-it");
        return { def: withTrack(def, t.id, (tt) => ({ ...tt, start: rt() < 0.3 ? { kind: "entry" } : { kind: "after", trackId: before, delayDays } })), label: "reconnect" };
      }
    }
    return null;
  }

  /** From a stream of its own (review bot on 7afa03d): a track's email emptied and the track removed in one edit. */
  const rv = random(seed ^ 0x7afa);
  function anEmptyEmailInARemovedTrack(): CampaignDefinition | null {
    const def = current;
    const removable = live(def).filter((t) => live(def).length > 1 && !live(def).some((x) => x.start.kind === "after" && x.start.trackId === t.id));
    const t = removable[Math.floor(rv() * removable.length)];
    const steps = t ? liveSteps(t) : [];
    const s = steps[Math.floor(rv() * steps.length)];
    if (!t || !s) return null;
    return withTrack(def, t.id, (x) => ({ ...x, removed: true, steps: x.steps.map((y) => (y.id === s.id ? { ...y, body: "" } : y)) }));
  }

  const rz = random(seed ^ 0x9308);
  function aTimingEdit(): { def: CampaignDefinition; label: string } | null {
    const roll = rz();
    if (roll < 0.15) return { def: { ...current, timezone: current.timezone === ZONE ? OTHER_ZONE : ZONE }, label: "campaign-zone" };
    if (roll < 0.25) {
      const tracks = live(current);
      const t = tracks[Math.floor(rz() * tracks.length)];
      if (!t) return null;
      return { def: withTrack(current, t.id, (x) => ({ ...x, window: x.window.length === 7 ? WEEKDAYS_9_TO_17 : ALL_DAY })), label: "window" };
    }
    return null;
  }

  /** E12: a Skip confirmed on a read taken before an edit that changed what it previews is refused, and changes nothing. */
  async function staleSkip(): Promise<void> {
    const id = pick(leads);
    const shown = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body;
    const offered = shown.controls.find((c) => c.action === "skip");
    if (!offered?.allowed) return;
    const edit = anEdit();
    if (!edit) return;
    await save(edit.def, edit.label);
    const now = (await h.request<EnrollmentRead>("GET", `/api/enrollments/${id}`)).body.controls.find((c) => c.action === "skip");
    if (now?.allowed && now.digest === offered.digest) return;
    const results = JSON.stringify((await read(id)).tracks);
    const res = await h.request("POST", `/api/enrollments/${id}/controls`, { requestId: `stale-${seed}-${++nextId}`, action: "skip", expect: { status: shown.status, preview: offered.digest } });
    if (res.status === 200) problem(`E12: a Skip confirmed on ${id}'s read before an edit changed it was applied`);
    else if (JSON.stringify((await read(id)).tracks) !== results) problem(`E12: a refused stale Skip changed ${id}'s progress`);
    features.add("a-stale-skip-after-an-edit-refused");
  }

  // --- The run. ---
  const events = options.events ?? 24;
  let raced = false;
  h.hooks = {
    afterClaim: async () => {
      if (raced || saving || !chance(0.08)) return;
      raced = true;
      const edit = anEdit();
      if (!edit) return;
      const before = await snapshot();
      const outcome = await h.otherProcessSave(campaign.id, edit.def);
      if (outcome === "saved") {
        record(current, edit.def, before, h.clock);
        features.add("an-edit-between-a-claim-and-its-handover");
      }
    },
  };
  for (let event = 0; event < events && !h.stopped; event++) {
    const step = pick([int(1, 90) * MINUTE, int(1, 30) * HOUR, int(1, 3) * DAY]);
    await h.advanceTo(h.clock + step);
    await check();
    const inFlight = email.handoverLog.some((x) => !email.deliveryLog.some((d) => d.key === x.key));
    const r = rand();
    const targeted = r < 0.55 ? await aTargetedEdit() : null;
    // Council on 93bed86, item 8, from a stream of its own: the campaign's zone moved, or a track's window changed.
    const timing = r < 0.55 && !targeted ? aTimingEdit() : null;
    if (targeted) {
      await save(targeted.def, targeted.label);
    } else if (timing) {
      anEdit();
      await save(timing.def, timing.label);
    } else if (r < 0.55) {
      const edit = anEdit();
      if (edit) {
        if (inFlight) features.add("an-edit-with-work-at-the-provider");
        await save(edit.def, edit.label);
      }
    } else if (r < 0.62) {
      const edit = aRefusedEdit();
      const hidden = rv() < 0.4 ? anEmptyEmailInARemovedTrack() : null;
      if (hidden) await save(hidden, "empty-email-in-a-removed-track", "either");
      else if (edit) await save(edit.def, edit.label, true);
    } else if (r < 0.77) {
      const open = pauses.find((p) => p.to === null);
      const res = await h.request("POST", `/api/campaigns/${campaign.id}/${open ? "resume" : "pause"}`, { requestId: `p-${seed}-${event}` });
      if (res.status === 200) {
        if (open) open.to = h.clock;
        else pauses.push({ from: h.clock, to: null });
        features.add(open ? "campaign-resumed" : "campaign-paused");
      }
    } else if (r < 0.85) {
      const sent = email.deliveryLog.filter((d) => d.at <= h.clock);
      const d = sent.length > 0 ? pick(sent) : null;
      if (d) email.prospectReplies(d.destination);
      if (d) features.add("a-reply");
    } else if (r < 0.92) {
      await staleSkip();
    }
    await check();
  }
  h.hooks = {};

  // --- The drain: resume, let every lead finish. ---
  const open = pauses.find((p) => p.to === null);
  if (open) {
    await h.request("POST", `/api/campaigns/${campaign.id}/resume`, { requestId: `p-${seed}-drain` });
    open.to = h.clock;
  }
  await h.advanceTo(h.clock + 30 * DAY);
  await check();
  // E4: an added step reaches every lead that was still before it, that ran to the end of the sequence.
  const final = current;
  for (const a of added) {
    const t = final.tracks.find((x) => x.id === a.trackId);
    const s = t?.steps.find((x) => x.id === a.stepId);
    if (!t || !s || s.removed) continue;
    for (const lead of a.reaches) {
      const r = await read(lead);
      if (r.status !== "sequence_finished_no_response") continue;
      if (t.removed && !r.tracks.find((p) => p.trackId === t.id)?.started) continue;
      if (skipped.some((x) => x.lead === lead && x.stepId === a.stepId)) continue;
      if (!email.deliveryLog.some((d) => d.subjectId === lead && d.stepId === a.stepId)) problem(`E4: ${a.stepId}, added at ${iso(a.at)} ahead of ${lead}, was never sent to it, though it finished its sequence`);
    }
  }
  for (const lead of leads) {
    const r = await read(lead);
    if (r.endedAt === null) problem(`drain: ${lead} has not ended after the drain (${r.status})`);
  }
  return { problems, stats: { features: [...features].sort(), writes: h.writes } };
}
