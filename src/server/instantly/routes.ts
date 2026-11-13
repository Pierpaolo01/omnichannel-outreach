import type { Hono } from "hono";
import type { EmailProviderStatus } from "../../shared/api.ts";
import type { EngineStore } from "../engine/engine-store.ts";
import type { SendPort } from "../engine/ports.ts";
import type { InstantlyStatus } from "./port.ts";

/** The email port when it can describe itself: the Instantly adapter. */
export type EmailProviderSource = Pick<SendPort, "transportFor"> & { status(): InstantlyStatus };

const NONE: EmailProviderStatus = { provider: "none", sending: "off", followUps: "unavailable", quota: "available", lastPolledAt: null, inboxes: [], waitingFollowUps: [] };

/**
 * GET /api/email-provider (ticket 12c), additive and read-only: the email provider, its sender
 * inboxes with the reason any of them cannot send, and the leads whose next email is a
 * continue-thread follow-up the provider cannot send yet (ADR 0002 X2). Those leads are not
 * claimed and receive nothing; this endpoint is where their wait shows.
 */
export function registerEmailProviderRoutes(app: Hono, deps: { readonly engine: EngineStore; readonly provider: EmailProviderSource | null; readonly now: () => number }): void {
  app.get("/email-provider", async (c) => {
    const { provider } = deps;
    if (!provider) return c.json(NONE);
    const waitingFollowUps: { enrollmentId: string; trackId: string; stepId: string }[] = [];
    if (provider.transportFor({ threading: "continue_thread" }).available === false) {
      const now = deps.now();
      for (const id of await deps.engine.runningSubjectIds()) {
        const s = await deps.engine.subject(id, now);
        if (!s) continue;
        for (const p of s.tracks) {
          if (p.finishedAt !== null || p.startedAt === null || p.nextStepId === null) continue;
          const track = s.campaign.definition.tracks.find((t) => t.id === p.trackId);
          const step = track?.steps.find((st) => st.id === p.nextStepId);
          if (track?.channel === "email" && step?.threading === "continue_thread") waitingFollowUps.push({ enrollmentId: id, trackId: p.trackId, stepId: p.nextStepId });
        }
      }
    }
    return c.json<EmailProviderStatus>({ ...provider.status(), waitingFollowUps });
  });
}
