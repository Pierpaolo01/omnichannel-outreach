/**
 * Matching rows of one export to records already on file, on evidence alone (docs/adr/0001).
 *
 * Each row group brings its evidence as tiers, strongest first: the ids of the records each kind
 * of evidence points to. The last tier is a name alone; the others identify a record positively.
 *
 * A group's strongest positive tier that points anywhere decides. The first tier (a place_id, a
 * personal email) is decisive; after it, every tier that points anywhere must agree, narrowing
 * the records to one, or the evidence contradicts itself and the group fits several records. One
 * record proposed by several groups goes to the group with the strongest evidence for it, if only
 * one group has that; every other group proposing it is left unmatched.
 *
 * A name alone is tried last, for groups with no positive evidence, and never points to a record
 * another group of the export proposed: rows the import keeps apart are different people or
 * companies. Creation order, row order and names turned into identifiers are never evidence.
 */

/** Why a row changed nothing: several records fit it, or the one record that fits also fits another row. */
export type Conflict = "several_records" | "another_row";

export type Resolution =
  | { readonly kind: "match"; readonly id: string }
  | { readonly kind: "new" }
  | { readonly kind: "ambiguous"; readonly conflict: Conflict };

type Proposal = { readonly kind: "one"; readonly id: string; readonly tier: number } | { readonly kind: "several" } | { readonly kind: "none" };

/**
 * The record a group's positive evidence points to. The first tier decides on its own. Later
 * tiers must agree: each one that points anywhere narrows the records, and one that points only
 * elsewhere makes the evidence contradict itself, so the group fits several records.
 */
function propose(tiers: readonly (readonly string[])[]): Proposal {
  const first = tiers.findIndex((ids) => ids.length > 0);
  if (first < 0) return { kind: "none" };
  let fits = [...new Set(tiers[first])];
  for (const weaker of tiers.slice(first + 1)) {
    if (weaker.length === 0) continue;
    const narrowed = fits.filter((id) => weaker.includes(id));
    if (narrowed.length > 0) fits = narrowed;
    else if (first > 0) return { kind: "several" };
  }
  const [only] = fits;
  return fits.length === 1 && only !== undefined ? { kind: "one", id: only, tier: first } : { kind: "several" };
}

/** Settles proposals: a record goes to the one group with the strongest evidence for it. */
function settle(proposals: readonly Proposal[]): (Resolution | null)[] {
  const strongest = new Map<string, number>();
  for (const p of proposals) {
    if (p.kind === "one") strongest.set(p.id, Math.min(strongest.get(p.id) ?? p.tier, p.tier));
  }
  const atStrongest = (id: string) => proposals.filter((p) => p.kind === "one" && p.id === id && p.tier === strongest.get(id)).length;
  return proposals.map((p) => {
    if (p.kind === "none") return null;
    if (p.kind === "several") return { kind: "ambiguous", conflict: "several_records" };
    return p.tier === strongest.get(p.id) && atStrongest(p.id) === 1 ? { kind: "match", id: p.id } : { kind: "ambiguous", conflict: "another_row" };
  });
}

/** `evidence[g][t]`: the records tier `t` of group `g`'s evidence points to; the last tier is a name alone. */
export function resolveMatches(evidence: readonly (readonly (readonly string[])[])[]): Resolution[] {
  const positive = evidence.map((tiers) => propose(tiers.slice(0, -1)));
  const byEvidence = settle(positive);
  const proposed = new Set(positive.flatMap((p) => (p.kind === "one" ? [p.id] : [])));
  const byName = settle(
    evidence.map((tiers, g) => (byEvidence[g] === null ? propose([(tiers.at(-1) ?? []).filter((id) => !proposed.has(id))]) : { kind: "none" })),
  );
  return evidence.map((_, g) => byEvidence[g] ?? byName[g] ?? { kind: "new" });
}
