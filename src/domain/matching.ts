/**
 * Matching rows of one export to records already on file, on evidence alone (docs/adr/0001).
 *
 * Each row group brings its evidence as tiers, strongest first, each naming the kind of detail
 * and the records it points to. The strongest tier that points anywhere decides:
 * - a decisive tier (a place_id, a personal email) decides alone, and when it points to several
 *   records nothing weaker may choose between them;
 * - after any other tier, every weaker tier that points anywhere must agree, narrowing the
 *   records, or the row's details contradict each other;
 * - `holders` are the records holding one of the row's identities whatever their name (a
 *   company's main line): when they point elsewhere, or when nothing else points anywhere, the
 *   row contradicts a record on file.
 * One record proposed by several groups goes to the group with the strongest evidence for it, if
 * only one group has that; every other group proposing it is left unmatched. A name alone is
 * tried last, for groups with no other evidence, and never points to a record another group
 * proposed: rows the import keeps apart are different people or companies. Creation order, row
 * order and names turned into identifiers are never evidence.
 */

export type EvidenceKind = "place_id" | "business_id" | "main_line" | "address" | "name" | "email" | "person_id" | "phone";

/**
 * Why a row changed nothing. "repeated_id" is not decided here: it is bad input, a scraper ID
 * repeated with a conflicting identity inside one file, refused before matching.
 */
export type Conflict = "several_records" | "another_row" | "contradiction" | "repeated_id";

export interface Tier {
  readonly kind: EvidenceKind;
  readonly ids: readonly string[];
  readonly decisive?: boolean;
}

export interface Evidence {
  readonly tiers: readonly Tier[];
  readonly holders?: Tier;
  /** Records whose name agrees, tried last. */
  readonly byName: readonly string[];
}

export type Resolution =
  | { readonly kind: "match"; readonly id: string }
  | { readonly kind: "new" }
  | { readonly kind: "ambiguous"; readonly conflict: Conflict; readonly disagreeing: readonly EvidenceKind[] };

type Proposal =
  | { readonly kind: "one"; readonly id: string; readonly tier: number }
  | { readonly kind: "unmatched"; readonly conflict: Conflict; readonly disagreeing: readonly EvidenceKind[] }
  | { readonly kind: "none" };

const several: Proposal = { kind: "unmatched", conflict: "several_records", disagreeing: [] };

function propose(evidence: Evidence): Proposal {
  const holders = evidence.holders?.ids.length ? evidence.holders : null;
  const first = evidence.tiers.findIndex((t) => t.ids.length > 0);
  const strongest = evidence.tiers[first];
  if (!strongest) return holders ? { kind: "unmatched", conflict: "contradiction", disagreeing: ["name", holders.kind] } : { kind: "none" };
  let fits = [...new Set(strongest.ids)];
  if (!strongest.decisive) {
    for (const weaker of [...evidence.tiers.slice(first + 1), ...(holders ? [holders] : [])]) {
      if (weaker.ids.length === 0) continue;
      const narrowed = fits.filter((id) => weaker.ids.includes(id));
      if (narrowed.length === 0) return { kind: "unmatched", conflict: "contradiction", disagreeing: [strongest.kind, weaker.kind] };
      fits = narrowed;
    }
  }
  const [only] = fits;
  return fits.length === 1 && only !== undefined ? { kind: "one", id: only, tier: first } : several;
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
    if (p.kind === "unmatched") return { kind: "ambiguous", conflict: p.conflict, disagreeing: p.disagreeing };
    return p.tier === strongest.get(p.id) && atStrongest(p.id) === 1
      ? { kind: "match", id: p.id }
      : { kind: "ambiguous", conflict: "another_row", disagreeing: [] };
  });
}

export function resolveMatches(evidence: readonly Evidence[]): Resolution[] {
  const positive = evidence.map(propose);
  const byEvidence = settle(positive);
  const proposed = new Set(positive.flatMap((p) => (p.kind === "one" ? [p.id] : [])));
  const byName = settle(
    evidence.map((e, g) => (byEvidence[g] === null ? propose({ tiers: [{ kind: "name", ids: e.byName.filter((id) => !proposed.has(id)) }], byName: [] }) : { kind: "none" })),
  );
  return evidence.map((_, g) => byEvidence[g] ?? byName[g] ?? { kind: "new" });
}
