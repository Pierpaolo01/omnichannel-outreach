import type { Directory, ImportPlan, KnownCompany, KnownDetail, KnownPerson } from "../../src/domain/import-plan.ts";

/**
 * Folds a plan into a directory the way the store applies it, so planning tests can import
 * twice without a database. Enrollments are those of the one campaign under test.
 */
export function directoryAfter(directory: Directory, plan: ImportPlan): Directory {
  const companies = new Map<string, KnownCompany>(directory.companies.map((c) => [c.id, c]));
  const people = new Map<string, KnownPerson>(directory.people.map((p) => [p.id, p]));
  for (const c of plan.companies) {
    const known = companies.get(c.id);
    companies.set(c.id, {
      id: c.id,
      placeId: c.placeId,
      sourceBusinessIds: [...(known?.sourceBusinessIds ?? []), ...c.newSourceBusinessIds],
      fields: c.fields,
      details: known?.details ?? [],
    });
  }
  for (const p of plan.people) {
    const known = people.get(p.id);
    people.set(p.id, {
      id: p.id,
      companyId: p.companyId,
      sourcePersonIds: [...(known?.sourcePersonIds ?? []), ...p.newSourcePersonIds],
      fields: p.fields,
      details: known?.details ?? [],
    });
  }
  const all = new Map<string, { owner: string; detail: KnownDetail }>();
  for (const c of companies.values()) for (const d of c.details) all.set(d.id, { owner: `company:${c.id}`, detail: d });
  for (const p of people.values()) for (const d of p.details) all.set(d.id, { owner: `person:${p.id}`, detail: d });
  for (const d of plan.details) {
    const owner = d.owner.kind === "person" ? `person:${d.owner.personId}` : `company:${d.owner.companyId}`;
    all.set(d.id, { owner, detail: { id: d.id, channel: d.channel, phoneKind: d.phoneKind, value: d.value, key: d.key, bad: false } });
  }
  // `?? []` lets these tests run against plans from before detail changes existed.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (const change of plan.detailChanges ?? []) {
    const entry = all.get(change.id);
    if (!entry) throw new Error(`change to unknown detail ${change.id}`);
    const owner = change.owner.kind === "person" ? `person:${change.owner.personId}` : `company:${change.owner.companyId}`;
    all.set(change.id, { owner, detail: { ...entry.detail, phoneKind: change.phoneKind } });
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (const { fromId, intoId } of plan.consolidations ?? []) {
    const from = all.get(fromId);
    const into = all.get(intoId);
    if (!from || !into) throw new Error(`consolidation of unknown detail ${fromId} into ${intoId}`);
    all.set(intoId, { ...into, detail: { ...into.detail, bad: into.detail.bad || from.detail.bad } });
    all.delete(fromId);
  }
  const owned = (owner: string) => [...all.values()].filter((e) => e.owner === owner).map((e) => e.detail);

  return {
    companies: [...companies.values()].map((c) => ({ ...c, details: owned(`company:${c.id}`) })),
    people: [...people.values()].map((p) => ({ ...p, details: owned(`person:${p.id}`) })),
    enrollments: [...directory.enrollments, ...plan.enrollments.map((e) => ({ id: e.id, lead: e.lead }))],
  };
}

/** Marks one detail bad by its id, as the store's markContactDetailBad does. */
export function markBad(directory: Directory, detailId: string): Directory {
  const mark = (d: KnownDetail) => (d.id === detailId ? { ...d, bad: true } : d);
  return {
    ...directory,
    companies: directory.companies.map((c) => ({ ...c, details: c.details.map(mark) })),
    people: directory.people.map((p) => ({ ...p, details: p.details.map(mark) })),
  };
}
