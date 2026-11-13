/**
 * Read models for the campaign editor's Before launch tab (ticket 12c): the leads the copy can be
 * rendered for, channel coverage, missing merge fields, copy rendered for one lead, and the
 * projected daily load per sender inbox. Built from the engine's stored facts, the same lead data
 * the handover renders with; nothing here writes.
 */
import { missingFields, renderSegments, type Segment } from "../domain/copy-preview.ts";
import { projectLoad, type OtherLead, type Projection } from "../domain/load-projection.ts";
import { isLive } from "../domain/sequence/attempt.ts";
import { leadNow, span } from "../domain/sequence/clock.ts";
import { heldReason } from "../domain/sequence/dispatch.ts";
import { mergeUses } from "../domain/sequence/copy.ts";
import { liveSteps, liveTracks, ownSubject, type CampaignDefinition, type TrackDefinition } from "../domain/sequence/definition.ts";
import { goodEmail, runs } from "../domain/sequence/progress.ts";
import type { AccountState, SubjectState } from "../domain/sequence/state.ts";
import type { BeforeLaunchView, ContactDetailView, CopyPreview, LeadRow, LoadProjectionView, PreviewLead } from "../shared/api.ts";
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
 * Why an inbox cannot be projected: it cannot send and nothing says when it will again. The
 * provider reports it unable (stale, sending off, not active), or the lead quota is held until the
 * provider confirms it again. A rate limit's wait has an end, so it is projected.
 */
function cannotProject(a: AccountState, now: number): "cannot_send" | "quota" | null {
  if (!a.healthy) return "cannot_send";
  if (a.waitReason === "quota" && (a.waitUntil === null || a.waitUntil > now)) return "quota";
  return null;
}

/** The projection's input, from the store: the same lead zones, inboxes, slots and counts sending reads. */
async function projectionOf(store: OutreachStore, campaignId: string, definition: CampaignDefinition, leads: readonly CampaignLead[], now: number): Promise<Projection | null> {
  const track: TrackDefinition | undefined = liveTracks(definition, "main").find((t) => t.channel === "email");
  if (!track) return null;
  const all = await store.engine.accounts(now);
  const pool = all.filter((a) => definition.emailPool.includes(a.id));
  if (pool.some((a) => cannotProject(a, now) !== null)) return null;
  const others = await otherWaitingWork(store, campaignId, definition, now);
  const used = new Set([...definition.emailPool, ...others.flatMap((o) => [...o.pool, ...(o.sender ? [o.sender] : [])])]);
  return projectLoad({
    start: now,
    window: track.window,
    waits: liveSteps(track).map((s) => s.waitDays),
    leads: leads.filter((l) => l.lead.email !== null).map((l) => ({ id: l.state.subject.id, zone: l.state.lead.zone, sender: l.state.subject.emailSender })),
    pool: definition.emailPool,
    // The engine's own account records, unchanged, for every inbox any simulated campaign may use.
    accounts: all.filter((a) => used.has(a.id)),
    others,
    zone: definition.timezone,
    horizonDays: PROJECTION_HORIZON_DAYS,
  });
}

/**
 * The waiting work of other running campaigns that shares an inbox with this one (PR 41 re-check,
 * B10): each running lead's pending email step, with its due instant, window, remaining waits and
 * any claim it holds. A step already handed to the provider holds its reservation in the inbox's
 * count; its later steps are taken as due from now. Leads that do not run (paused, ended, held)
 * are left out, as the engine leaves them.
 */
async function otherWaitingWork(store: OutreachStore, campaignId: string, definition: CampaignDefinition, now: number): Promise<OtherLead[]> {
  const ours = new Set(definition.emailPool);
  const out: OtherLead[] = [];
  for (const id of await store.engine.runningSubjectIds()) {
    const s = await store.engine.subject(id, now);
    if (!s || s.campaign.id === campaignId || !runs(s)) continue;
    const pool = s.campaign.definition.emailPool;
    if (s.subject.emailSender ? !ours.has(s.subject.emailSender) : !pool.some((a) => ours.has(a))) continue;
    for (const p of s.tracks) {
      const other = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
      if (!other || other.channel !== "email" || p.finishedAt !== null || p.nextStepId === null || p.dueAt === null || heldReason(s, p.trackId, now)) continue;
      const steps = liveSteps(other);
      const next = steps.findIndex((st) => st.id === p.nextStepId);
      if (next < 0) continue;
      const live = s.attempts.find((a) => a.stepId === p.nextStepId && isLive(a));
      // In the provider's hands: its reservation is counted; what follows is due from now.
      if (live && live.state !== "claimed") {
        if (next + 1 >= steps.length) continue;
        out.push({ id, zone: s.lead.zone, sender: live.accountId, window: other.window, waits: steps.map((st) => st.waitDays), next: next + 1, dueWall: now + span(now, steps[next + 1]?.waitDays ?? 0, s.lead.zone), touched: true, pool, claim: null });
        continue;
      }
      out.push({
        id,
        zone: s.lead.zone,
        sender: s.subject.emailSender,
        window: other.window,
        waits: steps.map((st) => st.waitDays),
        next,
        // The stored due instant, which the engine's priority compares (4.3).
        dueWall: p.dueWall ?? now + (p.dueAt - leadNow(s.subject.clock, now)),
        touched: s.subject.touched,
        pool,
        claim: live ? { accountId: live.accountId, at: live.claimedWall } : null,
      });
    }
  }
  return out;
}

/** The projected sends for a campaign's leads, for tests that compare them with the engine's. */
export async function projectedSends(store: OutreachStore, campaignId: string, now: number): Promise<Projection | null> {
  const row = await store.engine.campaign(campaignId);
  if (!row?.definition) return null;
  return projectionOf(store, campaignId, row.definition, await campaignLeads(store, campaignId, row.definition, now), now);
}

async function loadProjection(store: OutreachStore, campaignId: string, definition: CampaignDefinition, leads: readonly CampaignLead[], now: number): Promise<LoadProjectionView> {
  const labels = await store.engine.accountLabels();
  const pool = (await store.engine.accounts(now)).filter((a) => definition.emailPool.includes(a.id));
  const projection = await projectionOf(store, campaignId, definition, leads, now);
  return {
    leadsWithEmail: leads.filter((l) => l.lead.email !== null).length,
    accounts: pool.map((a) => ({
      id: a.id,
      label: labels[a.id] ?? a.id,
      capacity: a.capacity,
      usedToday: a.used,
      busiestDay: projection?.busiestDay.get(a.id) ?? 0,
      gapSeconds: Math.round(a.gapMs / 1000),
    })),
    daysUntilAllStart: projection?.daysUntilAllStart ?? null,
    notStartedWithinHorizon: projection?.notStarted ?? 0,
    horizonDays: PROJECTION_HORIZON_DAYS,
    cannotProject: pool.flatMap((a) => {
      const reason = cannotProject(a, now);
      return reason ? [{ accountId: a.id, label: labels[a.id] ?? a.id, reason }] : [];
    }),
  };
}

/** Copy for one lead of the campaign, or null when the enrollment is not one of its leads. */
export async function copyPreview(store: OutreachStore, campaignId: string, enrollmentId: string, definition: CampaignDefinition, now: number): Promise<CopyPreview | null> {
  const state = await store.engine.subject(enrollmentId, now);
  if (!state || state.subject.campaignId !== campaignId) return null;
  const lead = (await campaignLeads(store, campaignId, definition, now)).find((l) => l.lead.id === enrollmentId)?.lead;
  if (!lead) return null;
  const data = state.lead.mergeData;
  const steps: CopyPreview["steps"][number][] = [];
  for (const track of [...liveTracks(definition, "main"), ...liveTracks(definition, "win_back")]) {
    if (track.channel !== "email") continue;
    let day = 1;
    let threadSubject: Segment[] = [];
    liveSteps(track).forEach((step, i) => {
      day += step.waitDays;
      const own = renderSegments(ownSubject(step), data);
      const subject = step.threading === "continue_thread" ? [{ text: "Re: ", kind: "literal" as const }, ...threadSubject] : own;
      if (step.threading === "new_subject") threadSubject = own;
      const body = renderSegments(step.body, data);
      steps.push({ trackId: track.id, stepId: step.id, number: i + 1, day, threading: step.threading, subject, body, missing: missingFields([...own, ...body]) });
    });
  }
  return { lead, steps };
}
