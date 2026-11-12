import { emptyDirectory, planImport, type Directory, type ImportSummary } from "../../src/domain/import-plan.ts";
import { displayPhone } from "../../src/domain/phone.ts";
import type { CompanyRecord, LeadSearchResult, PersonRecord } from "../../src/shared/api.ts";
import { directoryAfter, markBad } from "./directory.ts";
import { sequentialIds } from "./domain.ts";
import { csvOf, exportOf, type ExportRows } from "./export-builder.ts";
import { steppingClock, testApi } from "./http.ts";

/** What a test observes about one detail: phones grouped for reading, emails as written. */
export interface DetailState {
  readonly value: string;
  readonly owner: "person" | "company";
  readonly phoneKind: string | null;
  readonly bad: boolean;
}

export interface PersonState {
  readonly name: string;
  readonly details: readonly DetailState[];
  readonly enrollments: number;
}

export interface CompanyState {
  readonly details: readonly DetailState[];
  readonly people: readonly PersonState[];
  readonly companyLeadEnrollments: number;
}

/**
 * Imports into one campaign and observes the result. Two adapters: the planner folded through
 * the test directory helper, and the real HTTP app over SQLite. Matching and ownership tests run
 * against both, so the helper cannot drift from the store unnoticed.
 */
export interface ImportHarness {
  import(rows: ExportRows): Promise<ImportSummary>;
  /** Every company with this name, with its people and their details. */
  companies(name: string): Promise<CompanyState[]>;
  /** Marks the one detail showing this value bad, as a wrong-number outcome will. */
  markBad(value: string): Promise<void>;
  peopleNamed(name: string): Promise<PersonState[]>;
}

const view = (d: { channel: string; key?: string; value: string; phoneKind: string | null; bad: boolean }, owner: "person" | "company"): DetailState => ({
  value: d.channel === "phone" && d.key ? displayPhone(d.key) : d.value,
  owner,
  phoneKind: d.phoneKind,
  bad: d.bad,
});

export function plannerHarness(): ImportHarness {
  let directory: Directory = emptyDirectory();
  const newId = sequentialIds("h");
  const now = steppingClock();
  const personState = (id: string): PersonState => {
    const p = directory.people.find((x) => x.id === id);
    if (!p) throw new Error(`no person ${id}`);
    return {
      name: p.fields.fullName,
      details: p.details.map((d) => view(d, "person")),
      enrollments: directory.enrollments.filter((e) => e.lead.kind === "person" && e.lead.personId === id).length,
    };
  };
  return {
    async import(rows) {
      const plan = planImport({ directory, scraped: exportOf(rows), now: now(), newId });
      directory = directoryAfter(directory, plan);
      return plan.summary;
    },
    async companies(name) {
      return directory.companies
        .filter((c) => c.fields.name === name)
        .map((c) => ({
          details: c.details.map((d) => view(d, "company")),
          people: directory.people.filter((p) => p.companyId === c.id).map((p) => personState(p.id)),
          companyLeadEnrollments: directory.enrollments.filter((e) => e.lead.kind === "company" && e.lead.companyId === c.id).length,
        }));
    },
    async markBad(value) {
      const all = [...directory.companies.flatMap((c) => c.details), ...directory.people.flatMap((p) => p.details)];
      const found = all.filter((d) => view(d, "person").value === value);
      if (found.length !== 1 || !found[0]) throw new Error(`expected one detail showing ${value}, found ${found.length}`);
      directory = markBad(directory, found[0].id);
    },
    async peopleNamed(name) {
      return directory.people.filter((p) => p.fields.fullName === name).map((p) => personState(p.id));
    },
  };
}

export function storeHarness(): ImportHarness {
  const api = testApi();
  let campaignId: string | null = null;
  const campaign = async () => (campaignId ??= (await api.createCampaign("Harness campaign")).id);
  const allRows = async () => (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const person = async (id: string) => (await api.get<PersonRecord>(`/api/people/${id}`)).body;
  const personState = async (id: string): Promise<PersonState> => {
    const p = await person(id);
    return {
      name: p.name,
      details: p.contactDetails.filter((d) => d.owner === "person").map((d) => view(d, "person")),
      enrollments: p.enrollments.length,
    };
  };
  const companyIds = async (name: string) => {
    const ids = new Set<string>();
    for (const row of await allRows()) {
      if (row.kind === "company" && row.name === name) ids.add(row.id);
      if (row.kind === "person" && row.company.name === name) ids.add(row.company.id);
    }
    return [...ids];
  };
  return {
    async import(rows) {
      const res = await api.post<{ import: { summary: ImportSummary } }>(`/api/campaigns/${await campaign()}/imports`, csvOf(rows));
      if (res.status !== 201) throw new Error(`import answered ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body.import.summary;
    },
    async companies(name) {
      const states: CompanyState[] = [];
      for (const id of await companyIds(name)) {
        const c = (await api.get<CompanyRecord>(`/api/companies/${id}`)).body;
        states.push({
          details: c.contactDetails.map((d) => view(d, "company")),
          people: await Promise.all(c.people.map((p) => personState(p.id))),
          companyLeadEnrollments: c.enrollments.length,
        });
      }
      return states;
    },
    async markBad(value) {
      const ids: string[] = [];
      for (const row of await allRows()) {
        const details =
          row.kind === "person"
            ? (await person(row.id)).contactDetails
            : (await api.get<CompanyRecord>(`/api/companies/${row.id}`)).body.contactDetails;
        for (const d of details) if (d.value === value) ids.push(d.id);
      }
      const unique = [...new Set(ids)];
      if (unique.length !== 1 || !unique[0]) throw new Error(`expected one detail showing ${value}, found ${unique.length}`);
      await api.store.markContactDetailBad(unique[0]);
    },
    async peopleNamed(name) {
      const rows = (await allRows()).filter((r) => r.kind === "person" && r.name === name);
      return Promise.all(rows.map((r) => personState(r.id)));
    },
  };
}

export const HARNESSES = [
  { name: "planner and directory helper", make: plannerHarness },
  { name: "real SQLite store over HTTP", make: storeHarness },
] as const;
