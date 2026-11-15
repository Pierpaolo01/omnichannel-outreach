/**
 * The editor's read of a running edit (ticket 19; ADR 0003 "Ticket 19", "What the editor shows"): for every lead of the
 * campaign, as of the read's instant, the engine's own catch-up and `reconcileEdit` applied to a copy, exactly as the
 * save would apply them, and where the lead stands relative to each change. Stores nothing.
 */
import { launchCheck } from "../../domain/sequence/blockers.ts";
import { definitionProblems, type CampaignDefinition } from "../../domain/sequence/definition.ts";
import { sealReckoning } from "../../domain/sequence/progress.ts";
import { changesBetween, editImpact } from "../../domain/sequence/reconcile.ts";
import type { SubjectState } from "../../domain/sequence/state.ts";
import type { EditImpactView } from "../../shared/api.ts";
import type { EngineStore } from "./engine-store.ts";
import type { Rules } from "./rules.ts";

export async function editImpactView(store: EngineStore, rules: Rules, campaignId: string, draft: CampaignDefinition, now: number): Promise<EditImpactView | null> {
  const row = await store.campaign(campaignId);
  if (!row) return null;
  const previous = row.definition;
  const problems = definitionProblems(draft, previous, { launched: row.launchedAt !== null });
  const { leads, accounts } = await store.launchInputs(campaignId);
  const changes = previous ? changesBetween(previous, draft) : [];
  const counts = changes.map((change) => ({ ...change, reaches: 0, skips: 0, inFlight: 0, untouched: 0 }));
  const subjects = previous && row.launchedAt !== null ? await store.campaignLeadsUnder(campaignId, now, draft) : [];
  const leadsAfter: SubjectState[] = [];
  for (const { state, zoneUnderDraft } of subjects) {
    const caught = sealReckoning(rules.asOfAction(state, now), now);
    const under = { ...caught, campaign: { ...caught.campaign, definition: draft }, lead: { ...caught.lead, zone: zoneUnderDraft } };
    const after = rules.reconcileEdit(under, previous ?? draft, caught.lead.zone, now);
    leadsAfter.push(after);
    editImpact(caught, after, changes).forEach((impact, i) => {
      const c = counts[i];
      if (!c) return;
      if (impact === "reaches") c.reaches++;
      else if (impact === "skips") c.skips++;
      else if (impact === "in_flight") c.inFlight++;
      else c.untouched++;
    });
  }
  // The save's own check: over what the leads, as the edit leaves them, can still run (before launch, the launch check).
  const blockers = (row.launchedAt !== null ? rules.runningCheck(draft, leadsAfter, leads, accounts) : launchCheck(draft, leads, accounts)).blockers;
  return { asOf: new Date(now).toISOString(), definitionVersion: row.definitionVersion, leads: subjects.length, changes: counts, problems, blockers };
}
