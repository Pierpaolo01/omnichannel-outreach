/**
 * Read models for the campaign editor's Before launch tab (ticket 12c): the leads the copy can be
 * rendered for, channel coverage, missing merge fields, copy rendered for one lead, and the
 * projected daily load per sender inbox. Built from the engine's stored facts, the same lead data
 * the handover renders with; nothing here writes.
 */
import { missingFields, renderSegments, type Segment } from "../domain/copy-preview.ts";
import { isLive, isUncertain } from "../domain/sequence/attempt.ts";
import { mergeUses } from "../domain/sequence/copy.ts";
import { liveSteps, liveTracks, ownSubject, poolOf, type CampaignDefinition, type TrackDefinition } from "../domain/sequence/definition.ts";
import { callbackHold, goodEmail, progressOf, runs } from "../domain/sequence/progress.ts";
import type { AccountState, SubjectState } from "../domain/sequence/state.ts";
import type { BeforeLaunchView, ContactDetailView, CopyPreview, LeadRow, LoadProjectionView, PreviewLead, WithheldBy, WithheldTrack } from "../shared/api.ts";
import { trackLabel, trackPhrase } from "../shared/track-label.ts";
import { projectLoad, type Projection } from "./load-projection.ts";
import type { OutreachStore } from "./persistence/store.ts";

/** How far ahead the load projection looks. */
export const PROJECTION_HORIZON_DAYS = 120;

interface CampaignLead {
  readonly lead: PreviewLead;
  readonly state: SubjectState;
  readonly details: readonly ContactDetailView[];
}

/** Every enrollment of the campaign that has not ended, in lead-search order (by name). */
async function campaignLeads(store: OutreachStore, campaignId: string, definition: CampaignDefinition, now: number): Promise<CampaignLead[]> {
  const fields = usedFields(definition);
  const { rows } = await store.searchLeads({ text: "", campaignId, companyId: null, status: null, limit: Number.MAX_SAFE_INTEGER });
  const out: CampaignLead[] = [];
  for (const row of rows) {
    const enrollment = row.enrollments.find((e) => e.campaign.id === campaignId);
    if (!enrollment) continue;
    const state = await store.engine.subject(enrollment.id, now);
    if (!state || state.subject.ended !== null) continue;
    const record = row.kind === "person" ? await store.person(row.id) : await store.company(row.id);
    const details = record?.contactDetails ?? [];
    const channels = {
      email: goodEmail(state.lead.details)?.value ?? null,
      // A decision maker's own mobile; company leads are never texted on a company line.
      mobile: row.kind === "person" && good(details, (d) => d.owner === "person" && d.phoneKind === "mobile"),
      // Calls may use the company's main line for any lead.
      phone: good(details, (d) => d.channel === "phone"),
      lacks: [...fields.keys()].filter((f) => !state.lead.mergeData[f]?.trim()),
    };
    out.push({ lead: previewLead(row, enrollment.id, channels), state, details });
  }
  return out;
}

function previewLead(row: LeadRow, enrollmentId: string, channels: Pick<PreviewLead, "email" | "mobile" | "phone" | "lacks">): PreviewLead {
  return row.kind === "person"
    ? { id: enrollmentId, kind: "person", recordId: row.id, name: row.name, title: row.title, company: row.company.name, ...channels }
    : { id: enrollmentId, kind: "company", recordId: row.id, name: row.name, title: "", company: row.name, ...channels };
}

/** Each merge field the live copy uses, sorted, with its fallbacks and whether some use has none. */
function usedFields(definition: CampaignDefinition): Map<string, { fallbacks: Set<string>; without: boolean }> {
  const uses = new Map<string, { fallbacks: Set<string>; without: boolean }>();
  for (const { step } of copySteps(definition)) {
    for (const use of [...mergeUses(ownSubject(step)), ...mergeUses(step.body)]) {
      const entry = uses.get(use.field) ?? { fallbacks: new Set<string>(), without: false };
      if (use.fallback === null) entry.without = true;
      else entry.fallbacks.add(use.fallback);
      uses.set(use.field, entry);
    }
  }
  return new Map([...uses.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const good = (details: readonly ContactDetailView[], test: (d: ContactDetailView) => boolean) => details.some((d) => !d.bad && test(d));

/** The live email and SMS steps of the main sequence and the win-back branch, in track order. */
const copySteps = (def: CampaignDefinition) =>
  [...liveTracks(def, "main"), ...liveTracks(def, "win_back")].filter((t) => t.channel !== "call").flatMap((track) => liveSteps(track).map((step) => ({ track, step })));

export async function beforeLaunchView(store: OutreachStore, campaignId: string, definition: CampaignDefinition, launched: boolean, now: number): Promise<BeforeLaunchView> {
  const leads = await campaignLeads(store, campaignId, definition, now);
  const mergeFields = [...usedFields(definition).entries()].map(([field, use]) => {
      const missing = leads.filter((l) => l.lead.lacks.includes(field));
      return {
        field,
        leadsMissing: missing.length,
        companyLeadsMissing: missing.filter((l) => l.lead.kind === "company").length,
        fallbacks: [...use.fallbacks],
        someUseWithoutFallback: use.without,
      };
    });

  return {
    campaignId,
    leads: leads.map((l) => l.lead),
    coverage: {
      leads: leads.length,
      email: leads.filter((l) => l.lead.email !== null).length,
      mobile: leads.filter((l) => l.lead.mobile).length,
      phone: leads.filter((l) => l.lead.phone).length,
    },
    mergeFields,
    load: launched ? null : await loadProjection(store, campaignId, definition, leads, now),
  };
}

/**
 * Why an account cannot be projected: it cannot send and nothing says when it will again. The
 * provider reports it unable (stale, sending off, not active, disconnected), or the lead quota is
 * held until the provider confirms it again. A rate limit's wait has an end, so it is projected.
 */
function cannotProject(a: AccountState, now: number): "cannot_send" | "quota" | null {
  if (!a.healthy) return "cannot_send";
  if (a.waitReason === "quota" && (a.waitUntil === null || a.waitUntil > now)) return "quota";
  return null;
}

/** The accounts a live track of the campaign may send from, on its own channel. */
function poolAccounts(definition: CampaignDefinition, all: readonly AccountState[]): AccountState[] {
  const channels = new Set(liveTracks(definition, "main").map((t) => t.channel));
  // Email inboxes first, then SMS numbers, each in id order.
  return all.filter((a) => channels.has(a.channel) && poolOf(definition, a.channel).includes(a.id)).sort((a, b) => (a.channel === b.channel ? (a.id < b.id ? -1 : 1) : a.channel === "email" ? -1 : 1));
}

/**
 * The tracks that withhold the figure (ADR 0003, ticket 13b), in track order: a live email or SMS
 * track with no sender in its pool at all (launch blocker 3), whose leads and every track after it
 * would wait for ever; and an email or SMS track that waits, through its chain, on a phone track,
 * which finishes only when the user logs its call. An account that is connected but cannot send is
 * `cannotProject`'s, said with its reason.
 */
function withheldTracks(definition: CampaignDefinition, all: readonly AccountState[]): WithheldTrack[] {
  const live = liveTracks(definition, "main");
  const named = (t: TrackDefinition) => trackPhrase(definition, t);
  return live.flatMap((t): WithheldTrack[] => {
    if (t.channel === "call") return [];
    const connected = all.some((a) => a.channel === t.channel && poolOf(definition, t.channel).includes(a.id));
    if (!connected) return [{ trackId: t.id, channel: t.channel, label: named(t), why: "no_sender" }];
    const phone = phoneBefore(definition, t);
    return phone ? [{ trackId: t.id, channel: t.channel, label: named(t), why: "after_a_phone_track", phoneTrack: named(phone) }] : [];
  });
}

/** The phone track an email or SMS track waits on through its chain of `after` starts, if any. */
function phoneBefore(definition: CampaignDefinition, t: TrackDefinition): TrackDefinition | null {
  const live = liveTracks(definition, "main");
  const seen = new Set<string>();
  for (let x: TrackDefinition | undefined = t; x && x.start.kind === "after" && !seen.has(x.id); ) {
    seen.add(x.id);
    const before: string = x.start.trackId;
    x = live.find((y) => y.id === before);
    if (x?.channel === "call") return x;
  }
  return null;
}

/**
 * The same rule over a competing campaign's running leads (council on 10121d3, item 1): an email or
 * SMS track there that still waits, for some lead, on a phone track whose call is not yet logged. Each
 * logged call releases it, and no estimate can know when, so this campaign's figure is withheld too,
 * naming that campaign. A lead held by a callback counts: its outcome, when the user logs it, releases
 * the hold and what waits on the call (ticket 15). A lead whose phone track has finished (logged,
 * skipped for want of a number, or skipped at the skip limit) waits on nothing, and is simulated like any other.
 */
function competingWithheld(others: readonly SubjectState[]): { campaignId: string; tracks: WithheldTrack[] } | null {
  const byCampaign = new Map<string, SubjectState[]>();
  for (const s of others) byCampaign.set(s.campaign.id, [...(byCampaign.get(s.campaign.id) ?? []), s]);
  for (const [campaignId, subjects] of byCampaign) {
    const definition = subjects[0]?.campaign.definition;
    if (!definition) continue;
    const tracks = liveTracks(definition, "main").flatMap((t): WithheldTrack[] => {
      if (t.channel === "call") return [];
      const phone = phoneBefore(definition, t);
      if (!phone) return [];
      const waiting = subjects.some((s) => awaitsACall(s) && progressOf(s, phone.id)?.finishedAt == null && progressOf(s, t.id)?.finishedAt == null);
      return waiting ? [{ trackId: t.id, channel: t.channel, label: trackPhrase(definition, t), why: "after_a_phone_track", phoneTrack: trackPhrase(definition, phone) }] : [];
    });
    if (tracks.length > 0) return { campaignId, tracks };
  }
  return null;
}

/** A lead on which the user may still log a call: running, or held by a callback, whose outcome releases it. */
const awaitsACall = (s: SubjectState) => runs(s) || (s.subject.ended === null && callbackHold(s));

/** Competing campaigns where a call can still be logged: the estimate assumes none is (the screen says so). */
function callingCampaigns(others: readonly SubjectState[]): string[] {
  const ids = new Set<string>();
  for (const s of others) {
    const calls = liveTracks(s.campaign.definition, "main").filter((t) => t.channel === "call");
    if (awaitsACall(s) && calls.some((t) => progressOf(s, t.id)?.finishedAt == null)) ids.add(s.campaign.id);
  }
  return [...ids];
}

interface ProjectionResult {
  readonly projection: Projection | null;
  readonly withheldBy: WithheldBy | null;
  readonly callsNotCounted: readonly { readonly id: string; readonly name: string }[];
  readonly held: readonly { accountId: string; reason: "unsettled_work" | "reply_being_matched" }[];
}

/**
 * The projection's input, from the store (ADR 0003, ticket 13b): this campaign's leads as the
 * engine holds them, the running subjects of every other campaign that competes for an account
 * with this one (closed over shared accounts), and the engine's own account records.
 */
async function projectionOf(store: OutreachStore, campaignId: string, definition: CampaignDefinition, leads: readonly CampaignLead[], now: number): Promise<ProjectionResult> {
  if (liveTracks(definition, "main").length === 0) return { projection: null, withheldBy: null, callsNotCounted: [], held: [] };
  const all = await store.engine.accounts(now);
  const withheld = withheldTracks(definition, all);
  if (withheld.length > 0) return { projection: null, withheldBy: { campaign: null, tracks: withheld }, callsNotCounted: [], held: [] };
  if (poolAccounts(definition, all).some((a) => cannotProject(a, now) !== null)) return { projection: null, withheldBy: null, callsNotCounted: [], held: [] };
  const competing = await competingSubjects(store, campaignId, definition, now);
  // Every subject holding work on these accounts is simulated, whatever its status (replied, stopped,
  // finished, paused): its claims, calls in flight and retries move by the engine's own rules.
  const known = new Set([...leads.map((l) => l.state.subject.id), ...competing.subjects.map((o) => o.subject.id)]);
  const holders: SubjectState[] = [];
  for (const held of await store.engine.heldOnAccounts()) {
    if (known.has(held.subjectId) || !competing.reach.has(held.accountId)) continue;
    known.add(held.subjectId);
    const s = await store.engine.subject(held.subjectId, now);
    if (s) holders.push(s);
  }
  const others = [...competing.subjects, ...holders];
  const held = await unsettled(store, [...others, ...leads.map((l) => l.state)], competing.reach);
  if (held.length > 0) return { projection: null, withheldBy: null, callsNotCounted: [], held };
  const nameOf = async (id: string) => ({ id, name: (await store.campaign(id))?.name ?? "" });
  const callsNotCounted = await Promise.all(callingCampaigns(competing.subjects).map(nameOf));
  const elsewhere = competingWithheld(competing.subjects);
  if (elsewhere) return { projection: null, withheldBy: { campaign: await nameOf(elsewhere.campaignId), tracks: elsewhere.tracks }, callsNotCounted, held: [] };
  const projection = projectLoad({
    now,
    ours: leads.map((l) => l.state),
    definition,
    others,
    accounts: all,
    zone: definition.timezone,
    horizonDays: PROJECTION_HORIZON_DAYS,
  });
  return { projection, withheldBy: null, callsNotCounted, held: [] };
}

/** The accounts a running subject may use: its campaign's pools, its fixed senders and its live attempts'. */
const accountsOf = (s: SubjectState): string[] => [
  ...s.campaign.definition.emailPool,
  ...poolOf(s.campaign.definition, "sms"),
  ...[s.subject.emailSender, s.subject.smsSender].filter((x): x is string => x !== null),
  ...s.attempts.filter(isLive).map((a) => a.accountId),
];

/**
 * Running subjects of other campaigns that compete for this campaign's accounts: capacity is per
 * account across every campaign, so a campaign sharing an account with one already included is
 * included too.
 */
async function competingSubjects(store: OutreachStore, campaignId: string, definition: CampaignDefinition, now: number): Promise<{ subjects: SubjectState[]; reach: Set<string> }> {
  const byCampaign = new Map<string, SubjectState[]>();
  for (const id of await store.engine.runningSubjectIds()) {
    const s = await store.engine.subject(id, now);
    if (!s || s.campaign.id === campaignId) continue;
    byCampaign.set(s.campaign.id, [...(byCampaign.get(s.campaign.id) ?? []), s]);
  }
  const reach = new Set([...definition.emailPool, ...poolOf(definition, "sms")]);
  const included = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, subjects] of byCampaign) {
      if (included.has(id)) continue;
      const uses = new Set(subjects.flatMap(accountsOf));
      if (![...uses].some((a) => reach.has(a))) continue;
      included.add(id);
      for (const a of uses) reach.add(a);
      grew = true;
    }
  }
  return { subjects: [...included].flatMap((id) => byCampaign.get(id) ?? []), reach };
}

/**
 * What the projection cannot advance by the engine's own rules (ADR 0003, ticket 13b, "Stored state
 * the projection starts from"), on the accounts it simulates: work whose outcome only the provider or
 * the user can settle, which no claim of its running lead will carry on; and a reply being matched to
 * its lead (`reply_events` pending), which may stop a lead. Either withholds the figure, naming the account.
 */
async function unsettled(store: OutreachStore, subjects: readonly SubjectState[], reach: ReadonlySet<string>): Promise<{ accountId: string; reason: "unsettled_work" | "reply_being_matched" }[]> {
  const out = new Map<string, "unsettled_work" | "reply_being_matched">();
  for (const s of subjects) {
    for (const w of s.work) {
      if (!reach.has(w.accountId) || !isUncertain(w) || w.sentWall !== null) continue;
      const carrier = s.attempts.find((a) => a.idempotencyKey === w.key && isLive(a));
      // Settled by the projection's provider: an accepted call, or one still waiting for its answer, is sent at once.
      if (carrier && (carrier.state === "accepted" || carrier.awaitingAnswer)) continue;
      // A same-key retry the engine will make (its lead runs): made by the engine's retry rules.
      if (carrier && (carrier.retry === "wanted" || carrier.retry === "wanted_after_not_sent") && runs(s)) continue;
      // Uncertain work no attempt carries, on its running lead's pending step: carried on by the next claim.
      const p = progressOf(s, w.trackId);
      if (!carrier && runs(s) && p?.finishedAt == null && p?.nextStepId === w.stepId) continue;
      out.set(w.accountId, "unsettled_work");
    }
  }
  for (const r of await store.engine.pendingReplies()) if (reach.has(r.inbox)) out.set(r.inbox, "reply_being_matched");
  return [...out].map(([accountId, reason]) => ({ accountId, reason }));
}

/** The projected sends for a campaign's leads, for tests that compare them with the engine's. */
export async function projectedSends(store: OutreachStore, campaignId: string, now: number): Promise<Projection | null> {
  const row = await store.engine.campaign(campaignId);
  if (!row?.definition) return null;
  return (await projectionOf(store, campaignId, row.definition, await campaignLeads(store, campaignId, row.definition, now), now)).projection;
}

async function loadProjection(store: OutreachStore, campaignId: string, definition: CampaignDefinition, leads: readonly CampaignLead[], now: number): Promise<LoadProjectionView> {
  const labels = await store.engine.accountLabels();
  const all = await store.engine.accounts(now);
  const pool = poolAccounts(definition, all);
  const { projection, withheldBy, callsNotCounted, held } = await projectionOf(store, campaignId, definition, leads, now);
  return {
    leadsToStart: projection?.leadsToStart ?? null,
    onlyCalled: projection?.onlyCalled ?? 0,
    accounts: pool.map((a) => ({
      id: a.id,
      label: labels[a.id] ?? a.id,
      channel: a.channel,
      capacity: a.capacity,
      usedToday: a.used,
      busiestDay: projection?.busiestDay.get(a.id) ?? 0,
      gapSeconds: Math.round(a.gapMs / 1000),
    })),
    daysUntilAllStart: projection?.daysUntilAllStart ?? null,
    notStartedWithinHorizon: projection?.notStarted ?? 0,
    horizonDays: PROJECTION_HORIZON_DAYS,
    cannotProject: [
      ...pool.flatMap((a) => {
        const reason = cannotProject(a, now);
        return reason ? [{ accountId: a.id, label: labels[a.id] ?? a.id, channel: a.channel, reason }] : [];
      }),
      ...held.map((h) => ({ accountId: h.accountId, label: labels[h.accountId] ?? h.accountId, channel: all.find((a) => a.id === h.accountId)?.channel ?? ("email" as const), reason: h.reason })),
    ],
    withheldBy,
    callsNotCounted,
  };
}

/** Copy for one lead of the campaign, or null when the enrollment is not one of its leads. */
export async function copyPreview(store: OutreachStore, campaignId: string, enrollmentId: string, definition: CampaignDefinition, now: number): Promise<CopyPreview | null> {
  const state = await store.engine.subject(enrollmentId, now);
  if (!state || state.subject.campaignId !== campaignId) return null;
  const lead = (await campaignLeads(store, campaignId, definition, now)).find((l) => l.lead.id === enrollmentId)?.lead;
  if (!lead) return null;
  const data = state.lead.mergeData;
  const all = liveTracks(definition, "main");
  const tracks = all.filter((t) => t.channel !== "call");
  // The lead skips a track whose channel it lacks; a skipped track finishes as it starts, so the
  // tracks after it start then (spec "a skipped or failed track counts as finished").
  const skipped = (t: TrackDefinition) => (t.channel === "email" ? lead.email === null : t.channel === "sms" ? !lead.mobile : !lead.phone);
  /**
   * The day offset a track starts on, or the phone track it waits on: a phone track finishes when
   * the user logs its call, so no day can be given for what follows it (unless the lead has no
   * number and it is skipped).
   */
  const startDay = new Map<string, { day: number } | { phone: TrackDefinition }>();
  const startOf = (t: TrackDefinition, depth = 0): { day: number } | { phone: TrackDefinition } => {
    const known = startDay.get(t.id);
    if (known !== undefined) return known;
    let out: { day: number } | { phone: TrackDefinition } = { day: 0 };
    if (t.start.kind === "after" && depth <= all.length) {
      const delay = t.start.delayDays;
      const before = all.find((x) => x.id === (t.start as { trackId: string }).trackId);
      const at = before ? startOf(before, depth + 1) : { day: 0 };
      if (before && "day" in at) {
        if (before.channel === "call" && !skipped(before)) out = { phone: before };
        else out = { day: at.day + (skipped(before) ? 0 : liveSteps(before).reduce((sum, st) => sum + st.waitDays, 0)) + delay };
      } else if ("phone" in at) out = at;
    }
    startDay.set(t.id, out);
    return out;
  };
  const steps: { step: CopyPreview["steps"][number]; order: number }[] = [];
  tracks.forEach((track, trackIndex) => {
    const skip = skipped(track);
    const start = startOf(track);
    let day = "day" in start ? 1 + start.day : null;
    const waitsOn = "phone" in start ? trackLabel(definition, start.phone).label : null;
    let threadSubject: Segment[] = [];
    liveSteps(track).forEach((step, i) => {
      if (!skip && day !== null) day += step.waitDays;
      const email = track.channel === "email";
      const own = email ? renderSegments(ownSubject(step), data) : [];
      const subject = email && step.threading === "continue_thread" ? [{ text: "Re: ", kind: "literal" as const }, ...threadSubject] : own;
      if (email && step.threading === "new_subject") threadSubject = own;
      const body = renderSegments(step.body, data);
      steps.push({
        step: { trackId: track.id, stepId: step.id, channel: track.channel === "sms" ? "sms" : "email", number: i + 1, day, waitsOnCall: waitsOn, skipped: skip, threading: step.threading, subject, body, missing: missingFields([...own, ...body]) },
        order: trackIndex * 10_000 + i,
      });
    });
  });
  steps.sort((x, y) => (x.step.day ?? Infinity) - (y.step.day ?? Infinity) || x.order - y.order);
  return { lead, steps: steps.map((x) => x.step) };
}
