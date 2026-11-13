/**
 * The person and company-lead timeline's campaign activity (tickets 12c and 13b): built from each
 * enrollment's stored progress, the same facts GET /api/enrollments/:id reports. It shows only
 * what happened: emails and texts the provider reported sent, failures, skips and tracks released by them, a hard bounce, the reply
 * (channel and date only, never its content), and the lead's ending. A bounce is shown from the
 * bounce event the engine stored, not inferred from how the track ended: a bounce can arrive after
 * the track completed, and an address marked bad by another campaign is not a bounce here. A bounce
 * observed before migration 10 kept no event, so it shows only as the ending on a bad address. Email
 * has no delivered
 * state, because Instantly reports none (ADR 0002, "Delivered").
 */
import type { ActivityEntry, EnrollmentView } from "../shared/api.ts";
import { displayPhone } from "../domain/phone.ts";
import { goodEmail, goodMobile, wallAtLead } from "../domain/sequence/progress.ts";
import type { SubjectState } from "../domain/sequence/state.ts";
import { trackLabel } from "../shared/track-label.ts";
import { progressView } from "./engine/views.ts";
import type { OutreachStore } from "./persistence/store.ts";

const SKIP_REASON: Readonly<Record<string, string>> = { "address on the provider's block list": "block_list" };

export async function activityOf(store: OutreachStore, enrollments: readonly EnrollmentView[], now: number, kind: "person" | "company"): Promise<ActivityEntry[]> {
  const labels = await store.engine.accountLabels();
  const entries: ActivityEntry[] = [];
  for (const enrollment of enrollments) {
    const state = await store.engine.subject(enrollment.id, now);
    if (!state) continue;
    const progress = progressView(state, now);
    const campaign = enrollment.campaign;
    const def = state.campaign.definition;
    const companyLead = kind === "company";
    const bounces = await store.engine.bouncesOf(enrollment.id);
    const channelOfTrack = (trackId: string): "email" | "sms" => (def.tracks.find((t) => t.id === trackId)?.channel === "sms" ? "sms" : "email");
    const labelOf = (trackId: string) => trackLabel(def, def.tracks.find((t) => t.id === trackId) ?? { id: trackId, channel: channelOfTrack(trackId) });
    // A text goes to a mobile's E.164 form; it is shown grouped for reading.
    const shown = (channel: "email" | "sms", destination: string) => (channel === "sms" ? displayPhone(destination) : destination);
    for (const b of bounces) {
      const track = progress.tracks.find((t) => t.trackId === b.trackId);
      const step = track?.steps.find((st) => st.stepId === b.stepId);
      const channel = channelOfTrack(b.trackId);
      entries.push({ campaign, at: new Date(b.atWall).toISOString(), kind: "bounced", channel, track: labelOf(b.trackId), stepNumber: step?.number ?? null, to: shown(channel, b.destination) });
    }
    for (const track of progress.tracks) {
      if (track.channel !== "email" && track.channel !== "sms") continue;
      const channel = track.channel;
      const label = labelOf(track.trackId);
      const missing = channel === "email" ? "no_email" : companyLead ? "company_lead" : "no_mobile";
      const hasChannel = channel === "email" ? goodEmail(state.lead.details) !== null : goodMobile(state.lead.details) !== null;
      let lastTo: string | null = null;
      for (const step of track.steps) {
        for (const send of step.sends) {
          if (send.state !== "sent" || send.sentAt === null) continue;
          lastTo = send.destination;
          entries.push({ campaign, at: send.sentAt, kind: "sent", channel, track: label, stepNumber: step.number, from: labels[send.sender] ?? send.sender, to: shown(channel, send.destination), copy: send.copy });
        }
        if (step.at === null) continue;
        if (step.result === "failed") {
          const to = step.sends.at(-1)?.destination ?? "";
          entries.push({ campaign, at: step.at, kind: "failed", channel, track: label, stepNumber: step.number, to: shown(channel, to), reason: step.reason ?? "failed" });
        } else if (step.result === "skipped") {
          entries.push({ campaign, at: step.at, kind: "skipped", channel, track: label, stepNumber: step.number, reason: SKIP_REASON[step.reason ?? ""] ?? step.reason ?? "skipped" });
        }
      }
      if (!track.started && progress.endedAt !== null && !hasChannel) {
        // A lead with no usable channel ends at entry: this track never starts, for want of its channel.
        entries.push({ campaign, at: progress.endedAt, kind: "skipped", channel, track: label, stepNumber: null, reason: missing });
        continue;
      }
      const startedAt = startedWall(state, track.trackId, now);
      const rule = def.tracks.find((t) => t.id === track.trackId)?.start;
      if (startedAt !== null && rule?.kind === "after") {
        // A track that started because the one before it was skipped or failed says so (spec "a
        // skipped or failed track counts as finished").
        const before = progress.tracks.find((t) => t.trackId === rule.trackId);
        const because = before?.finishReason === "skipped_missing_channel" || before?.finishReason === "skipped" ? "skipped" : before?.finishReason === "failed_bad_destination" ? "failed" : null;
        if (because) entries.push({ campaign, at: new Date(startedAt).toISOString(), kind: "released", channel, track: label, after: labelOf(rule.trackId), because });
      }
      if (track.finishedAt === null) continue;
      if (track.finishReason === "skipped_missing_channel" && track.steps.every((st) => st.result === null)) {
        entries.push({ campaign, at: track.finishedAt, kind: "skipped", channel, track: label, stepNumber: null, reason: missing });
      } else if (track.finishReason === "failed_bad_destination" && !track.steps.some((st) => st.result === "failed") && !bounces.some((b) => b.trackId === track.trackId)) {
        // The track ended on a bad address with no bounce event of this campaign's: another campaign's
        // bounce marked it, or this campaign's bounce was observed before migration 10, which kept no
        // event (ADR 0003, bounce events). The entry says only what the stored ending says.
        entries.push({ campaign, at: track.finishedAt, kind: "address_bad", channel, track: label, to: shown(channel, lastTo ?? "") });
      }
    }
    if (progress.reply) entries.push({ campaign, at: progress.reply.at, kind: "replied", channel: progress.reply.channel });
    else if (progress.endedAt !== null && (progress.status === "sequence_finished_no_response" || progress.status === "finished_no_usable_channel")) {
      entries.push({ campaign, at: progress.endedAt, kind: "ended", status: progress.status });
    }
  }
  // Newest first; at the same instant, the later-recorded entry first.
  return entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i).map(({ e }) => e);
}

/** The wall instant a track started, or null if it has not. */
function startedWall(state: SubjectState, trackId: string, now: number): number | null {
  const p = state.tracks.find((t) => t.trackId === trackId);
  if (!p || p.startedAt === null) return null;
  return wallAtLead(state.subject.clock, state.freezes, p.startedAt, now);
}
