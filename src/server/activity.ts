/**
 * The person and company-lead timeline's campaign activity (ticket 12c): built from each
 * enrollment's stored progress, the same facts GET /api/enrollments/:id reports. It shows only
 * what happened: emails the provider reported sent, failures and skips, a hard bounce, the reply
 * (channel and date only, never its content), and the lead's ending. Email has no delivered
 * state, because Instantly reports none (ADR 0002, "Delivered").
 */
import type { ActivityEntry, EnrollmentView } from "../shared/api.ts";
import { goodEmail } from "../domain/sequence/progress.ts";
import { progressView } from "./engine/views.ts";
import type { OutreachStore } from "./persistence/store.ts";

const SKIP_REASON: Readonly<Record<string, string>> = { "address on the provider's block list": "block_list" };

export async function activityOf(store: OutreachStore, enrollments: readonly EnrollmentView[], now: number): Promise<ActivityEntry[]> {
  const labels = await store.engine.accountLabels();
  const entries: ActivityEntry[] = [];
  for (const enrollment of enrollments) {
    const state = await store.engine.subject(enrollment.id, now);
    if (!state) continue;
    const progress = progressView(state, now);
    const campaign = enrollment.campaign;
    for (const track of progress.tracks) {
      if (track.channel !== "email") continue;
      let lastTo: string | null = null;
      for (const step of track.steps) {
        for (const send of step.sends) {
          if (send.state !== "sent" || send.sentAt === null) continue;
          lastTo = send.destination;
          entries.push({ campaign, at: send.sentAt, kind: "sent", stepNumber: step.number, from: labels[send.sender] ?? send.sender, to: send.destination, copy: send.copy });
        }
        if (step.at === null) continue;
        if (step.result === "failed") {
          const to = step.sends.at(-1)?.destination ?? "";
          entries.push({ campaign, at: step.at, kind: "failed", stepNumber: step.number, to, reason: step.reason ?? "failed" });
        } else if (step.result === "skipped") {
          entries.push({ campaign, at: step.at, kind: "skipped", stepNumber: step.number, reason: SKIP_REASON[step.reason ?? ""] ?? step.reason ?? "skipped" });
        }
      }
      if (!track.started && progress.endedAt !== null && goodEmail(state.lead.details) === null) {
        // A lead with no usable channel ends at entry: its email track never starts, for want of an email.
        entries.push({ campaign, at: progress.endedAt, kind: "skipped", stepNumber: null, reason: "no_email" });
        continue;
      }
      if (track.finishedAt === null) continue;
      if (track.finishReason === "skipped_missing_channel" && track.steps.every((s) => s.result === null)) {
        entries.push({ campaign, at: track.finishedAt, kind: "skipped", stepNumber: null, reason: "no_email" });
      } else if (track.finishReason === "failed_bad_destination" && !track.steps.some((s) => s.result === "failed")) {
        // A hard bounce after a send: the address is marked bad and the track ends.
        entries.push({ campaign, at: track.finishedAt, kind: "bounced", to: lastTo ?? "" });
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
