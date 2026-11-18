import type { ImportSummary } from "../../src/domain/import-plan.ts";
import type { CompanyRecord, LeadSearchResult, PersonRecord } from "../../src/shared/api.ts";
import { csvOf, type ExportRows } from "./export-builder.ts";
import { testApi } from "./http.ts";

/** What a test observes about one detail: phones grouped for reading, emails as written. */
export interface DetailState {
  readonly value: string;
  readonly owner: "person" | "company";
  readonly phoneKind: string | null;
  readonly bad: boolean;
}

export interface PersonState {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly details: readonly DetailState[];
  readonly enrollments: number;
}

export interface CompanyState {
  readonly id: string;
  readonly details: readonly DetailState[];
  readonly people: readonly PersonState[];
  readonly companyLeadEnrollments: number;
}

/**
 * Imports through the real HTTP app over SQLite and observes the records it keeps. Imports go
 * into campaign "A" unless a test names another campaign.
 */
export interface ImportHarness {
  import(rows: ExportRows, campaign?: string): Promise<ImportSummary>;
  /** Every company with this name, with its people and their details. */
  companies(name: string): Promise<CompanyState[]>;
  /** Marks the one detail showing this value bad, as a wrong-number outcome will. */
  markBad(value: string): Promise<void>;
  peopleNamed(name: string): Promise<PersonState[]>;
}

const view = (d: { value: string; phoneKind: string | null; bad: boolean }, owner: "person" | "company"): DetailState => ({
  value: d.value,
  owner,
  phoneKind: d.phoneKind,
  bad: d.bad,
});

export function importHarness(): ImportHarness {
  const api = testApi();
  const campaigns = new Map<string, string>();
  const campaign = async (name: string) => {
    const known = campaigns.get(name);
    if (known) return known;
    const created = (await api.createCampaign(`Campaign ${name}`)).id;
    campaigns.set(name, created);
    return created;
  };
  const allRows = async () => (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const person = async (id: string) => (await api.get<PersonRecord>(`/api/people/${id}`)).body;
  const personState = async (id: string): Promise<PersonState> => {
    const p = await person(id);
    return {
      id,
      name: p.name,
      title: p.title,
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
    async import(rows, name = "A") {
      const res = await api.post<{ import: { summary: ImportSummary } }>(`/api/campaigns/${await campaign(name)}/imports`, csvOf(rows));
      if (res.status !== 201) throw new Error(`import answered ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body.import.summary;
    },
    async companies(name) {
      const states: CompanyState[] = [];
      for (const id of await companyIds(name)) {
        const c = (await api.get<CompanyRecord>(`/api/companies/${id}`)).body;
        states.push({
          id,
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
