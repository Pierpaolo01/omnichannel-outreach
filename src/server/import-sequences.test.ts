import { expect, test } from "vitest";
import { business, csvOf, person, type ExportRows } from "../../test/support/export-builder.ts";
import { testApi, type TestApi } from "../../test/support/http.ts";
import type { CompanyRecord, ImportSummary, LeadSearchResult, PersonRecord } from "../shared/api.ts";

/**
 * Generated import sequences through the real HTTP app and SQLite store, with a fixed seed, so a
 * failure reproduces exactly. The invariants are the ownership rules in docs/adr/0001:
 * 1. a contact value has exactly one owner within a company;
 * 2. a value known as the company's main line or shared inbox is never also a personal detail,
 *    and a decision maker's email, mobile and direct reach use only their own details;
 * 3. a bad mark survives every import;
 * 4. nobody holds two enrollments in one campaign;
 * 5. importing the same files twice changes nothing;
 * 6. no import returns a server error.
 * Small pools of names, numbers and addresses make collisions likely.
 */

const SEQUENCES = Number(process.env["SEQ_COUNT"] ?? 120);
const SEED = Number(process.env["SEQ_SEED"] ?? 20261112);

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINES = ["0101", "0202", "0303", "0404"].map((n) => [`+44207946${n}`, `020 7946 ${n}`, `0044 20 7946 ${n}`, `+44 20 7946 ${n}`]);
const MOBILES = ["900101", "900202"].map((n) => [`+447700${n}`, `07700 ${n}`]);
const COMPANIES = [
  { names: ["Harbour Lane Physio", "Harbour Lane Physio Ltd"], inbox: "info@harbour.example" },
  { names: ["Northgate Dental", "Northgate Dental Studio"], inbox: "hello@northgate.example" },
  { names: ["Elm Street Chiro"], inbox: "contact@elm.example" },
];
const PEOPLE = [
  { company: 0, names: ["Pat O'Neil", "Pat ONeil", "Dr Pat O’Neil"], emails: ["pat@harbour.example", "Pat@Harbour.example", "p.oneil@mail.example"] },
  { company: 0, names: ["Sam Lee"], emails: ["sam@harbour.example"] },
  { company: 0, names: ["Sam Lee"], emails: ["s.lee@harbour.example"] },
  { company: 1, names: ["Grace Okafor", "Grace OKAFOR"], emails: ["grace@northgate.example"] },
  { company: 1, names: ["Ravi Patel"], emails: ["ravi@northgate.example", "info@harbour.example"] },
  { company: 2, names: ["Daniel Price", "Daniel Price PhD"], emails: ["daniel@elm.example", "contact@elm.example"] },
];

function generateRun(rand: () => number): ExportRows {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const chance = (p: number) => rand() < p;
  const included = COMPANIES.map((_, i) => i).filter(() => chance(0.85));
  const businesses = included.map((i) => {
    const c = COMPANIES[i] ?? COMPANIES[0];
    const line = chance(0.6) ? pick(pick(LINES)) : "";
    return business({
      business_id: chance(0.8) ? `bz-${i}` : `bz-${i}-run${Math.floor(rand() * 3)}`,
      place_id: chance(0.7) ? `PL-${i}` : "",
      business_name: pick(c?.names ?? ["Clinic"]),
      country: pick(["GB", "GB", "United Kingdom", ""]),
      phone_e164: line.startsWith("+") && !line.includes(" ") ? line : "",
      phone_original: line,
      general_emails: [chance(0.5) ? (c?.inbox ?? "") : "", chance(0.15) ? pick(PEOPLE.flatMap((p) => p.emails)) : ""].filter(Boolean).join(";"),
    });
  });
  const people: Record<string, string>[] = [];
  PEOPLE.forEach((p, i) => {
    if (!included.includes(p.company) || !chance(0.75)) return;
    const businessId = businesses[included.indexOf(p.company)]?.["business_id"] ?? "";
    const row = person({
      person_id: chance(0.8) ? `pp-${i}` : `pp-${i}-r${Math.floor(rand() * 3)}`,
      business_id: businessId,
      full_name: pick(p.names),
      email: chance(0.6) ? pick(p.emails) : "",
      direct_phone: chance(0.4) ? pick(pick(LINES)) : "",
      dial_phone: chance(0.3) ? pick(pick([...MOBILES, ...LINES])) : "",
      dial_phone_type: chance(0.7) ? "mobile" : "",
    });
    people.push(row);
    if (chance(0.1)) people.push(row);
  });
  return { businesses, people };
}

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, "");

interface World {
  readonly companies: CompanyRecord[];
  readonly people: PersonRecord[];
}

async function world(api: TestApi): Promise<World> {
  const rows = (await api.get<LeadSearchResult>("/api/leads?limit=500")).body.rows;
  const companyIds = new Set(rows.map((r) => (r.kind === "company" ? r.id : r.company.id)));
  const people = await Promise.all(
    rows.filter((r) => r.kind === "person").map(async (r) => (await api.get<PersonRecord>(`/api/people/${r.id}`)).body),
  );
  const companies = await Promise.all([...companyIds].map(async (id) => (await api.get<CompanyRecord>(`/api/companies/${id}`)).body));
  return { companies, people };
}

function violations(w: World, summary: ImportSummary | null, badMarks: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const company of w.companies) {
    const owners = new Map<string, string>();
    const claim = (value: string, owner: string) => {
      const key = norm(value);
      const other = owners.get(key);
      if (other && other !== owner) problems.push(`${value} at ${company.name} is held by ${other} and ${owner}`);
      owners.set(key, owner);
    };
    for (const d of company.contactDetails) claim(d.value, "the company");
    for (const p of w.people.filter((x) => x.company.id === company.id)) {
      for (const d of p.contactDetails.filter((x) => x.owner === "person")) claim(d.value, p.name);
    }
  }
  for (const p of w.people) {
    const campaigns = p.enrollments.map((e) => e.campaign.id);
    if (new Set(campaigns).size !== campaigns.length) problems.push(`${p.name} holds two enrollments in one campaign`);
  }
  for (const c of w.companies) {
    const campaigns = c.enrollments.map((e) => e.campaign.id);
    if (new Set(campaigns).size !== campaigns.length) problems.push(`${c.name} holds two company-lead enrollments in one campaign`);
  }
  for (const entry of summary?.entries ?? []) {
    if (entry.outcome === "not_enrolled" || entry.lead.kind !== "person") continue;
    const { personId } = entry.lead;
    const p = w.people.find((x) => x.id === personId);
    const own = p?.contactDetails.filter((d) => d.owner === "person" && !d.bad) ?? [];
    if (entry.via.includes("email") && !own.some((d) => d.channel === "email")) problems.push(`${entry.name} has email reach without an email of their own`);
    if (entry.via.includes("mobile") && !own.some((d) => d.phoneKind === "mobile")) problems.push(`${entry.name} has SMS reach without a mobile of their own`);
    if (entry.via.includes("direct") && !own.some((d) => d.phoneKind === "direct")) problems.push(`${entry.name} has direct reach without a number of their own`);
  }
  for (const [value, companyId] of badMarks) {
    const company = w.companies.find((c) => c.id === companyId);
    const all = [
      ...(company?.contactDetails ?? []),
      ...w.people.filter((p) => p.company.id === companyId).flatMap((p) => p.contactDetails.filter((d) => d.owner === "person")),
    ].filter((d) => norm(d.value) === value);
    if (all.length === 0) problems.push(`bad ${value} disappeared`);
    if (all.some((d) => !d.bad)) problems.push(`bad ${value} lost its mark`);
  }
  return problems;
}

async function runSequence(seed: number): Promise<string[]> {
  const rand = random(seed);
  const api = testApi();
  const campaign = await api.createCampaign("Generated");
  const badMarks = new Map<string, string>();
  const steps = 3 + Math.floor(rand() * 3);
  for (let step = 1; step <= steps; step++) {
    const before = await world(api);
    for (let k = Math.floor(rand() * 3); k > 0; k--) {
      const details = [
        ...before.companies.flatMap((c) => c.contactDetails.map((d) => ({ d, companyId: c.id }))),
        ...before.people.flatMap((p) => p.contactDetails.filter((d) => d.owner === "person").map((d) => ({ d, companyId: p.company.id }))),
      ];
      const chosen = details[Math.floor(rand() * details.length)];
      if (!chosen) break;
      await api.store.markContactDetailBad(chosen.d.id);
      badMarks.set(norm(chosen.d.value), chosen.companyId);
    }
    const run = generateRun(rand);
    if (process.env["SEQ_DEBUG"]) {
      const w = await world(api);
      console.info(`--- step ${step}`, JSON.stringify(run.businesses.map((b) => [b["business_id"], b["place_id"], b["business_name"], b["phone_original"], b["general_emails"]])));
      console.info("people", JSON.stringify((run.people ?? []).map((p) => [p["person_id"], p["business_id"], p["full_name"], p["email"], p["direct_phone"], p["dial_phone"]])));
      console.info("crm companies", JSON.stringify(w.companies.map((c) => [c.id, c.name, c.contactDetails.map((d) => d.value), c.people.map((p) => p.name)])));
    }
    const send = () => api.post<{ import?: { summary: ImportSummary }; error?: unknown }>(`/api/campaigns/${campaign.id}/imports`, csvOf(run));
    const first = await send();
    if (first.status >= 500) return [`step ${step}: the import answered ${first.status}`];
    if (first.status !== 201) continue;
    const after = await world(api);
    const found = violations(after, first.body.import?.summary ?? null, badMarks);
    if (found.length > 0) return found.map((f) => `step ${step}: ${f}`);

    const again = await send();
    if (again.status !== 201) return [`step ${step}: the same files answered ${again.status} the second time`];
    const counts = again.body.import?.summary.counts;
    if (counts?.new !== 0 || counts.updated !== 0) {
      const changed = again.body.import?.summary.entries.filter((e) => e.outcome === "new" || e.outcome === "updated") ?? [];
      return [`step ${step}: the same files again gave ${changed.map((e) => `${e.outcome} ${e.name}`).join(", ")}`];
    }
    if (JSON.stringify(await world(api)) !== JSON.stringify(after)) return [`step ${step}: the same files again changed the records`];
  }
  return [];
}

test(`${SEQUENCES} generated import sequences keep every ownership invariant (seed ${SEED})`, async () => {
  const failures: string[] = [];
  for (let i = process.env["SEQ_DEBUG"] ? Number(process.env["SEQ_DEBUG"]) - SEED : 0; i < (process.env["SEQ_DEBUG"] ? Number(process.env["SEQ_DEBUG"]) - SEED + 1 : SEQUENCES); i++) {
    const problems = await runSequence(SEED + i);
    if (problems.length > 0) failures.push(`seed ${SEED + i}: ${problems.join("; ")}`);
  }
  expect(failures).toEqual([]);
}, 1_200_000);
