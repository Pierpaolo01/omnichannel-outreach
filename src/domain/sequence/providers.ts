/**
 * Provider evidence and the waits it decides (ADR 0003 "Ticket 20a", after the council on 13dad92). Each provider has
 * a last contact (a round in which every read the engine relies on answered, extended by each later successful call
 * while it stood) and how long that stands; and its last failed read. A lead's send waits only on the providers whose
 * answers decide that lead's safety: the provider of the channel sent on, and of every other channel the lead has in the
 * campaign (a reply there would stop it). The dispatch gate and the Needs attention read both decide by `waitingOn`.
 */
import { channelReaches, liveTracksFor } from "./progress.ts";
import type { SubjectState } from "./state.ts";

export type ProviderChannel = "email" | "sms" | "linkedin";
export const PROVIDER_CHANNELS: readonly ProviderChannel[] = ["email", "sms", "linkedin"];

export interface ProviderEvidence {
  /** The last contact, or null when none since the worker started. */
  readonly contactAt: number | null;
  /** How long a contact stands for "it answers". */
  readonly freshForMs: number;
  /** The last failed read, and its part. */
  readonly failedAt: number | null;
  /** `call`: a send call, pre-send check, lookup or withdrawal that failed or resolved as a failure. */
  readonly failedPart: "accounts" | "observation" | "call" | null;
}

export function providerFresh(e: ProviderEvidence, at: number): boolean {
  return e.contactAt !== null && at - e.contactAt <= e.freshForMs;
}

/** The providers a send on `trackId` waits on for this lead: its own channel's, and each other channel the lead has in the campaign. */
export function relevantChannels(state: SubjectState, trackId: string): ProviderChannel[] {
  const own = state.campaign.definition.tracks.find((t) => t.id === trackId)?.channel;
  const channels = new Set<ProviderChannel>();
  if (own === "email" || own === "sms" || own === "linkedin") channels.add(own);
  // A LinkedIn session detects no reply (ADR 0004 2.3), so it decides no other channel's safety: only its own sends wait on it.
  for (const t of liveTracksFor(state)) {
    if ((t.channel === "email" || t.channel === "sms") && channelReaches(state, t.channel)) channels.add(t.channel);
  }
  return PROVIDER_CHANNELS.filter((c) => channels.has(c));
}

/** Of `relevant`, the providers not answering at `at`: the send waits while any is. */
export function waitingOn(evidence: Readonly<Record<ProviderChannel, ProviderEvidence>>, relevant: readonly ProviderChannel[], at: number): ProviderChannel[] {
  return relevant.filter((c) => !providerFresh(evidence[c], at));
}
