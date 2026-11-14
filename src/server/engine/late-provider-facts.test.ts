import { describe, expect, test } from "vitest";
import { inbox, launched, SETTLING, twoSteps } from "../../../test/support/regressions.ts";
import type { CampaignDefinition } from "../../domain/sequence/definition.ts";

/**
 * A provider's answer that arrives after a boundary is applied at an instant taken after it arrived
 * (ADR 0003 section 5; review bot on b8c65f9: the engine as on the integration branch): a send that happened on
 * Tuesday is recorded on Tuesday, and its one-day follow-up waits a day from then. Fictitious data.
 */

const at = (iso: string) => Date.parse(iso);
const DAY = 24 * 3_600_000;
const MONDAY_9_TO_17 = (def: CampaignDefinition): CampaignDefinition => ({ ...def, tracks: def.tracks.map((t) => ({ ...t, window: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 })) })) });

/** Each boundary: when the tick starts, when the send happened, and the instant the answer arrives. */
const BOUNDARIES = [
  { name: "the user's midnight", definition: twoSteps(), tickAt: at("2026-11-02T23:59:59Z"), sentAt: at("2026-11-03T00:00:05Z"), answeredAt: at("2026-11-03T00:00:10Z") },
  { name: "the end of the sending window", definition: MONDAY_9_TO_17(twoSteps()), tickAt: at("2026-11-02T16:59:59Z"), sentAt: at("2026-11-02T17:00:05Z"), answeredAt: at("2026-11-02T17:00:10Z") },
] as const;

describe("a provider's answer held across a boundary is applied after it arrived (review bot on b8c65f9)", () => {
  for (const b of BOUNDARIES) {
    for (const read of ["observe", "lookup"] as const) {
      test(`${read}, across ${b.name}: the send is recorded when it happened, and the follow-up waits a day from then`, async () => {
        const { h, port, campaign } = await launched([inbox("inbox-a")], undefined, b.definition);
        // Handed over so the lookup falls due at the tick; the provider sends at `sentAt`. A lookup's
        // case never shows a sent event, so only the lookup can tell.
        const handedAt = read === "lookup" ? b.tickAt - SETTLING : b.tickAt - 60_000;
        port.onCall = () => ({ answer: "accepted", sendAfter: b.sentAt - handedAt, eventDelay: read === "lookup" ? 30 * 24 * 3_600_000 : 0 });
        h.clock = handedAt;
        expect((await h.launch(campaign.id)).status).toBe(200);
        expect(port.calls).toHaveLength(1);
        // The tick starts before the boundary; the provider's answer comes back after it.
        h.clock = b.tickAt;
        const original = port[read].bind(port) as (x: never) => Promise<unknown>;
        let held = false;
        (port as unknown as Record<string, unknown>)[read] = async (x: never) => {
          if (!held) {
            held = true;
            h.clock = b.answeredAt;
            port.advance();
          }
          return original(x);
        };
        await h.engine.tick();
        (port as unknown as Record<string, unknown>)[read] = original;
        expect(held).toBe(true);

        const [id] = await h.store.engine.runningSubjectIds();
        const s = (await h.store.engine.subject(id ?? "", h.clock))!;
        expect(s.results.find((r) => r.stepId === "s1")).toMatchObject({ result: "sent", atWall: b.sentAt });
        // The follow-up's wait of one day counts from the send's day (London is on GMT in November).
        const follow = s.tracks.find((p) => p.trackId === "t1");
        expect(follow?.nextStepId).toBe("s2");
        expect(follow?.dueWall).toBe(Math.floor(b.sentAt / DAY) * DAY + DAY);
        // Seconds later nothing more goes.
        h.clock = b.answeredAt + 10_000;
        await h.tick();
        expect(port.calls).toHaveLength(1);
      });
    }
  }
});
