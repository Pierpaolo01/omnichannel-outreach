import { describe, expect, test } from "vitest";
import { business, csvOf, person, type ExportRows } from "../../test/support/export-builder.ts";
import { testApi } from "../../test/support/http.ts";
import type { CompanyRecord, LeadSearchResult, PersonRecord } from "../shared/api.ts";
import type { ImportSummary } from "./import-plan.ts";

/**
 * A company with no country whose main line moves between countries, with people holding its
 * numbers in international and national form (the independent verifier's matrix, review round 3:
 * 36 of its imports returned a server error). One rule reads a national number for a company
 * (docs/adr/0001, "Phone identity"), so every import succeeds, the people's row order never
 * changes the outcome, and importing the same files again changes nothing.
 */

const NUMBERS = {
  US: { full: "+12025550155", national: "2025550155", old: "+12025550199" },
  GB: { full: "+442079460155", national: "02079460155", old: "+442079460199" },
  FR: { full: "+33199009876", national: "0199009876", old: "+33199009899" },
} as const;
type Country = keyof typeof NUMBERS;

const permutations = <T,>(xs: readonly T[]): T[][] => (xs.length ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => j !== i)).map((p) => [x, ...p])) : [[]]);

interface Case {
  readonly name: string;
  readonly first: Country;
  readonly lines: readonly Country[];
  readonly paired: boolean;
  /** The verifier's minimal case: two colleagues, one number in two forms. */
  readonly colleagues?: boolean;
}

const cases: Case[] = [
  { name: "a US line, then a GB line, two colleagues holding the GB number in two forms", first: "US", lines: ["GB"], paired: true, colleagues: true },
  { name: "a US line, then a GB line, two colleagues holding the GB number in two forms, businesses only", first: "US", lines: ["GB"], paired: false, colleagues: true },
];
for (const countries of [["US", "GB"], ["US", "FR"], ["GB", "FR"], ["US", "GB", "FR"]] as const) {
  for (const [first, ...rest] of permutations<Country>(countries)) {
    if (!first) continue;
    for (const paired of [false, true]) {
      const lines = [...rest, first];
      cases.push({ name: `a ${first} line, then ${lines.join(", then ")}${paired ? ", with the People rows" : ", businesses only"}`, first, lines, paired });
    }
  }
}

/** The CRM as the API shows it, without generated identifiers. */
async function crm(api: ReturnType<typeof testApi>): Promise<string> {
  const rows = (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const details = (list: readonly { owner: string; value: string; phoneKind: string | null; bad: boolean; newer: boolean }[]) =>
    list.map((d) => `${d.owner} ${d.value} ${d.phoneKind ?? ""} ${d.bad} ${d.newer}`).sort();
  const people = await Promise.all(rows.filter((r) => r.kind === "person").map(async (r) => (await api.get<PersonRecord>(`/api/people/${r.id}`)).body));
  const companies = await Promise.all([...new Set(rows.map((r) => (r.kind === "company" ? r.id : r.company.id)))].map(async (id) => (await api.get<CompanyRecord>(`/api/companies/${id}`)).body));
  return JSON.stringify({
    people: people.map((p) => JSON.stringify([p.name, details(p.contactDetails), p.enrollments.length, p.unenrolledReason])).sort(),
    companies: companies.map((c) => JSON.stringify([c.name, details(c.contactDetails), c.enrollments.length])).sort(),
  });
}

/** Runs the case with the People rows in the given order; returns the CRM after each import, and every problem. */
async function run(c: Case, reversed: boolean): Promise<{ states: string[]; problems: string[] }> {
  const api = testApi();
  const campaign = (await api.createCampaign("Mixed regions")).id;
  const clinic = business({ business_id: "b", place_id: "MIXED", business_name: "Mixed Clinic", country: "", phone_original: "", phone_e164: NUMBERS[c.first].old });
  const people = c.colleagues
    ? [
        person({ business_id: "b", person_id: "y", full_name: "Yara Glen", direct_phone: NUMBERS.GB.full }),
        person({ business_id: "b", person_id: "z", full_name: "Zara Glen", direct_phone: NUMBERS.GB.national }),
      ]
    : c.lines.flatMap((country, i) =>
        (["full", "national"] as const).map((form, j) =>
          person({ business_id: "b", person_id: `p${i}${j}`, full_name: `Pat ${country}${form}`, email: `${country.toLowerCase()}${form}@mixed.example`, direct_phone: NUMBERS[country][form] }),
        ),
      );
  if (reversed) people.reverse();
  const states: string[] = [];
  const problems: string[] = [];
  const send = async (rows: ExportRows, label: string, repeat: boolean) => {
    const before = await crm(api);
    const res = await api.post<{ import?: { summary: ImportSummary } }>(`/api/campaigns/${campaign}/imports`, csvOf(rows));
    if (res.status !== 201 || !res.body.import) {
      problems.push(`${label}: answered ${res.status}`);
      return;
    }
    const after = await crm(api);
    if (repeat && (res.body.import.summary.counts.new !== 0 || res.body.import.summary.counts.updated !== 0 || after !== before)) problems.push(`${label}: the same files again changed something`);
    states.push(after);
  };
  const initial = { businesses: [clinic], people };
  await send(initial, "first import", false);
  await send(initial, "first import again", true);
  for (const country of c.lines) {
    const stage = { businesses: [{ ...clinic, phone_e164: NUMBERS[country].full }], people: c.paired ? people : [] };
    await send(stage, `${country} line`, false);
    await send(stage, `${country} line again`, true);
  }
  return { states, problems };
}

describe("a company with no country whose main line moves between countries", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const inOrder = await run(c, false);
      const reversed = await run(c, true);
      expect([...inOrder.problems, ...reversed.problems.map((p) => `People rows reversed, ${p}`)]).toEqual([]);
      expect(reversed.states).toEqual(inOrder.states);
    });
  }
});
