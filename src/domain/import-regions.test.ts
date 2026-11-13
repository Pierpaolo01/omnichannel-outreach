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
async function crm(api: ReturnType<typeof testApi>, options: { newer: boolean } = { newer: true }): Promise<string> {
  const rows = (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const details = (list: readonly { owner: string; value: string; phoneKind: string | null; bad: boolean; newer: boolean }[]) =>
    list.map((d) => `${d.owner} ${d.value} ${d.phoneKind ?? ""} ${d.bad}${options.newer ? ` ${d.newer}` : ""}`).sort();
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

/**
 * The review sequences of round 4 (GPT findings 1 to 5, Opus finding 1), each through the real
 * app and store, with the rows of every file in file order and reversed. Without a two-letter
 * country no number is read in a region guessed from the company's lines (docs/adr/0001, "Phone
 * identity"), so none returns a server error, both orders give the same CRM after every import,
 * importing the same files again changes nothing, and no bad mark is lost or duplicated unmarked.
 */
type Step = { readonly rows: ExportRows } | { readonly markBad: string };

async function shownDetails(api: ReturnType<typeof testApi>): Promise<{ id: string; value: string; bad: boolean; holder: string }[]> {
  const rows = (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const found: { id: string; value: string; bad: boolean; holder: string }[] = [];
  for (const id of [...new Set(rows.map((r) => (r.kind === "company" ? r.id : r.company.id)))]) {
    const company = (await api.get<CompanyRecord>(`/api/companies/${id}`)).body;
    found.push(...company.contactDetails.map((d) => ({ id: d.id, value: d.value, bad: d.bad, holder: company.name })));
  }
  for (const r of rows.filter((r) => r.kind === "person")) {
    const p = (await api.get<PersonRecord>(`/api/people/${r.id}`)).body;
    found.push(...p.contactDetails.filter((d) => d.owner === "person").map((d) => ({ id: d.id, value: d.value, bad: d.bad, holder: p.name })));
  }
  return found;
}

async function play(steps: readonly Step[], reversed: boolean): Promise<{ api: ReturnType<typeof testApi>; states: string[]; problems: string[] }> {
  const api = testApi();
  const campaign = (await api.createCampaign("Review sequences")).id;
  const states: string[] = [];
  const problems: string[] = [];
  const flip = (rows: ExportRows): ExportRows => (reversed ? { businesses: [...rows.businesses].reverse(), people: [...(rows.people ?? [])].reverse() } : rows);
  for (const [n, step] of steps.entries()) {
    if ("markBad" in step) {
      const ids = (await shownDetails(api)).filter((d) => d.value === step.markBad).map((d) => d.id);
      if (ids.length !== 1 || !ids[0]) problems.push(`step ${n + 1}: expected one detail showing ${step.markBad}, found ${ids.length}`);
      else await api.store.markContactDetailBad(ids[0]);
      continue;
    }
    for (const repeat of [false, true]) {
      const before = await crm(api);
      const res = await api.post<{ import?: { summary: ImportSummary } }>(`/api/campaigns/${campaign}/imports`, csvOf(flip(step.rows)));
      if (res.status !== 201 || !res.body.import) {
        problems.push(`step ${n + 1}${repeat ? " again" : ""}: answered ${res.status}`);
        continue;
      }
      const after = await crm(api);
      const { counts } = res.body.import.summary;
      if (repeat && (counts.new !== 0 || counts.updated !== 0 || after !== before)) problems.push(`step ${n + 1}: the same files again changed something`);
      if (!repeat) states.push(after);
    }
  }
  return { api, states, problems };
}

/** Every bad mark kept: no live detail shows a marked value unmarked. */
async function unmarkedCopies(api: ReturnType<typeof testApi>, marked: readonly string[]): Promise<string[]> {
  return (await shownDetails(api)).filter((d) => marked.includes(d.value) && !d.bad).map((d) => `${d.holder} holds ${d.value} unmarked`);
}

const clinic = (fields: Record<string, string>) => business({ business_id: "b1", place_id: "P1", business_name: "Mixed Clinic", country: "", phone_e164: "", phone_original: "", ...fields });
const staffer = (id: string, name: string, fields: Record<string, string>) => person({ business_id: "b1", person_id: id, full_name: name, ...fields });

describe("the review sequences of round 4, in both row orders", () => {
  const cy = staffer("cy", "Cy Moss", { direct_phone: "+44 20 7946 0177" });
  const sequences: Record<string, { steps: Step[]; marked?: string[]; check?: (api: ReturnType<typeof testApi>) => Promise<void> }> = {
    // Opus finding 1: a national mobile read as American, then as digits once a UK line arrived.
    "a national mobile marked bad at a company with a US line, then a UK line": {
      steps: [
        { rows: { businesses: [clinic({ phone_e164: "+12025550199" })], people: [staffer("bo", "Bo Lind", { dial_phone: "202 555 0100", dial_phone_type: "mobile" }), cy] } },
        { markBad: "2025550100" },
        { rows: { businesses: [clinic({ phone_e164: "+12025550199" }), clinic({ business_id: "b2", phone_e164: "+442079460199" })], people: [staffer("bo", "Bo Lind", { dial_phone: "202 555 0100", dial_phone_type: "mobile" }), cy] } },
      ],
      marked: ["2025550100"],
      check: async (api) => {
        const bo = (await shownDetails(api)).filter((d) => d.holder === "Bo Lind");
        expect(bo).toEqual([expect.objectContaining({ value: "2025550100", bad: true })]);
      },
    },
    // Opus finding 1, second form: a person writes the company's digits line in international form.
    "a line kept by its digits and marked bad, then written by a person as +44": {
      steps: [
        { rows: { businesses: [clinic({ phone_original: "020 7946 0199" })], people: [cy] } },
        { markBad: "02079460199" },
        { rows: { businesses: [clinic({ phone_original: "020 7946 0199" })], people: [staffer("bo", "Bo Lind", { direct_phone: "+44 20 7946 0199" }), cy] } },
      ],
      marked: ["02079460199"],
    },
    // GPT finding 1: Pat's digits copy, then two international lines, combined in one import.
    "a person's digits number, then a US and a UK line in one import": {
      steps: [
        { rows: { businesses: [clinic({})], people: [staffer("pat", "Pat Lee", { direct_phone: "2025550155" }), cy] } },
        { rows: { businesses: [clinic({ phone_e164: "+12025550155" }), clinic({ business_id: "b2", phone_e164: "+442025550155" })], people: [staffer("pat", "Pat Lee", { direct_phone: "2025550155" }), cy] } },
      ],
    },
    // GPT finding 2: a bad mobile must not come back unmarked when a UK line arrives.
    "a mobile marked bad at a company with a US line, then a UK line, Ada's row repeated": {
      steps: [
        { rows: { businesses: [clinic({ phone_e164: "+12025550199" })], people: [staffer("ada", "Ada Moss", { dial_phone: "2025550155", dial_phone_type: "mobile" }), cy] } },
        { markBad: "2025550155" },
        { rows: { businesses: [clinic({ phone_e164: "+12025550199" }), clinic({ business_id: "b2", phone_e164: "+442079460199" })], people: [staffer("ada", "Ada Moss", { dial_phone: "2025550155", dial_phone_type: "mobile" }), cy] } },
      ],
      marked: ["2025550155"],
    },
    // GPT finding 3: no place on record, then UK and US lines with a new place: never the first row's region.
    "a digits line with no place, then same-name rows with a new place and UK and US lines": {
      steps: [
        { rows: { businesses: [clinic({ place_id: "", phone_original: "02079460155" })], people: [cy] } },
        { rows: { businesses: [clinic({ business_id: "b7", place_id: "P9", phone_e164: "+442079460155" }), clinic({ business_id: "b8", place_id: "P9", phone_e164: "+12025550199" })] } },
      ],
    },
    // GPT finding 4: an international original with a blank E.164 cell is international on the first import.
    "two lines with blank E.164 cells, one national and one international": {
      steps: [{ rows: { businesses: [clinic({ phone_original: "2025550155" }), clinic({ business_id: "b2", phone_original: "+12025550199" })], people: [cy] } }],
      check: async (api) => {
        expect((await shownDetails(api)).filter((d) => d.holder === "Mixed Clinic").map((d) => d.value).sort()).toEqual(["+1 202 555 0199", "2025550155"]);
      },
    },
    // GPT finding 5: two spellings of one number become one when the company has a country.
    "two digits lines of one number, one marked bad, then country GB": {
      steps: [
        { rows: { businesses: [clinic({ phone_original: "02079460155" }), clinic({ business_id: "b2", phone_original: "2079460155" })], people: [cy] } },
        { markBad: "2079460155" },
        { rows: { businesses: [clinic({ country: "GB", phone_e164: "+442079460155" })], people: [cy] } },
      ],
      check: async (api) => {
        const lines = (await shownDetails(api)).filter((d) => d.holder === "Mixed Clinic");
        expect(lines).toEqual([expect.objectContaining({ value: "+44 20 7946 0155", bad: true })]);
      },
    },
  };

  for (const [name, { steps, marked = [], check }] of Object.entries(sequences)) {
    test(name, async () => {
      const inOrder = await play(steps, false);
      const reversed = await play(steps, true);
      expect([...inOrder.problems, ...reversed.problems.map((p) => `rows reversed, ${p}`)]).toEqual([]);
      expect(reversed.states).toEqual(inOrder.states);
      expect([...(await unmarkedCopies(inOrder.api, marked)), ...(await unmarkedCopies(reversed.api, marked))]).toEqual([]);
      await check?.(inOrder.api);
      await check?.(reversed.api);
    });
  }

  // GPT finding 1: arriving separately, in either order, ends as arriving together.
  test("a person's digits number, then a US and a UK line in separate imports, in either order", async () => {
    const start: Step = { rows: { businesses: [clinic({})], people: [staffer("pat", "Pat Lee", { direct_phone: "2025550155" }), cy] } };
    const line = (e164: string): Step => ({ rows: { businesses: [clinic({ phone_e164: e164 })], people: [staffer("pat", "Pat Lee", { direct_phone: "2025550155" }), cy] } });
    const together = await play([start, { rows: { businesses: [clinic({ phone_e164: "+12025550155" }), clinic({ business_id: "b2", phone_e164: "+442025550155" })], people: [staffer("pat", "Pat Lee", { direct_phone: "2025550155" }), cy] } }], false);
    const usFirst = await play([start, line("+12025550155"), line("+442025550155")], false);
    const ukFirst = await play([start, line("+442025550155"), line("+12025550155")], false);
    expect([...usFirst.problems, ...ukFirst.problems]).toEqual([]);
    // A line from a later import is newer by definition; everything else is the same.
    const end = async (run: { api: ReturnType<typeof testApi> }) => crm(run.api, { newer: false });
    expect(await end(usFirst)).toEqual(await end(together));
    expect(await end(ukFirst)).toEqual(await end(together));
  });

  // GPT finding 5: the earlier ids of both spellings resolve to the one bad line.
  test("both spellings' ids resolve to the one line once the company has a country", async () => {
    const steps: Step[] = [{ rows: { businesses: [clinic({ phone_original: "02079460155" }), clinic({ business_id: "b2", phone_original: "2079460155" })], people: [cy] } }];
    const { api } = await play(steps, false);
    const ids = (await shownDetails(api)).filter((d) => d.holder === "Mixed Clinic").map((d) => d.id);
    expect(ids).toHaveLength(2);
    await api.store.markContactDetailBad(ids[1] ?? "");
    const campaign = (await api.get<{ campaigns: { id: string }[] }>("/api/campaigns")).body.campaigns[0]?.id ?? "";
    expect((await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [clinic({ country: "GB", phone_e164: "+442079460155" })], people: [cy] }))).status).toBe(201);
    const resolved = await Promise.all(ids.map((id) => api.store.contactDetail(id)));
    expect(resolved.map((d) => d?.id)).toEqual([resolved[0]?.id, resolved[0]?.id]);
    expect(resolved[0]).toMatchObject({ key: "+442079460155", bad: true, owner: { kind: "company" } });
  });
});
