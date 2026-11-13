import { CsvError, parse } from "csv-parse/sync";

/**
 * The scraper's paired export: a businesses file and a people file joined on business_id.
 * Column names follow the verified schema (issue #11). Extra columns are ignored, so a scraper
 * that adds fields keeps importing; a missing required column rejects the file.
 */

const BUSINESS_COLUMNS = [
  "business_id",
  "place_id",
  "business_name",
  "category",
  "phone_e164",
  "phone_original",
  "general_emails",
  "website",
  "domain",
  "street",
  "neighborhood",
  "city",
  "state_province",
  "postal_code",
  "country",
  "timezone",
] as const;

const PEOPLE_COLUMNS = [
  "person_id",
  "business_id",
  "timezone",
  "full_name",
  "first_name",
  "last_name",
  "title",
  "role_tier",
  "email",
  "direct_phone",
  "dial_phone",
  "dial_phone_type",
  "linkedin_url",
  "source_urls",
] as const;

export type ExportFile = "businesses" | "people";

/** "pair" problems concern how the two files fit together rather than either file alone. */
export type ProblemSource = ExportFile | "pair";

export interface ExportProblem {
  readonly file: ProblemSource;
  readonly message: string;
}

export interface ScrapedBusiness {
  readonly sourceBusinessId: string;
  readonly placeId: string | null;
  readonly name: string;
  readonly category: string;
  readonly mainPhone: { readonly e164: string; readonly original: string } | null;
  readonly generalEmails: readonly string[];
  readonly website: string;
  readonly domain: string;
  readonly street: string;
  readonly neighborhood: string;
  readonly city: string;
  readonly stateProvince: string;
  readonly postalCode: string;
  readonly country: string;
  readonly timezone: string | null;
  /** Every column of the source row, kept so no company context is lost. */
  readonly source: Readonly<Record<string, string>>;
}

export interface ScrapedPerson {
  readonly sourcePersonId: string;
  readonly sourceBusinessId: string;
  readonly fullName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly title: string;
  readonly roleTier: string;
  readonly timezone: string | null;
  readonly email: string;
  readonly directPhone: string;
  readonly dialPhone: string;
  readonly dialPhoneType: string;
  readonly linkedinUrl: string;
  readonly sourceUrls: readonly string[];
  /** Every column of the source row, with source_urls still as its raw cell text. */
  readonly source: Readonly<Record<string, string>>;
}

export interface ScraperExport {
  readonly businesses: readonly ScrapedBusiness[];
  readonly people: readonly ScrapedPerson[];
}

export type ParseResult =
  | { readonly ok: true; readonly value: ScraperExport }
  | { readonly ok: false; readonly problems: readonly ExportProblem[] };

export function parseScraperExport(files: { businessesCsv: string; peopleCsv: string }): ParseResult {
  const businesses = readTable("businesses", files.businessesCsv, BUSINESS_COLUMNS);
  const people = readTable("people", files.peopleCsv, PEOPLE_COLUMNS);
  const problems = [...(businesses.ok ? [] : [businesses.problem]), ...(people.ok ? [] : [people.problem])];
  if (!businesses.ok || !people.ok) return { ok: false, problems };

  const value = { businesses: businesses.rows.map(toBusiness), people: people.rows.map(toPerson) };
  const businessIds = new Set(value.businesses.map((b) => b.sourceBusinessId).filter(Boolean));
  if (value.people.length > 0 && !value.people.some((p) => businessIds.has(p.sourceBusinessId))) {
    const count = value.people.length;
    return {
      ok: false,
      problems: [
        {
          file: "pair",
          message: `These two files don’t belong together: none of the ${count} ${count === 1 ? "person" : "people"} belong to a business in the Businesses file. Export both from the same scraper run.`,
        },
      ],
    };
  }
  return { ok: true, value };
}

export type FileCheck =
  | { readonly ok: true; readonly rows: number }
  | { readonly ok: false; readonly message: string };

/** Checks one file on its own, as soon as it is chosen. The import repeats every check. */
export function checkScraperFile(file: ExportFile, text: string): FileCheck {
  const table = file === "businesses" ? readTable(file, text, BUSINESS_COLUMNS) : readTable(file, text, PEOPLE_COLUMNS);
  return table.ok ? { ok: true, rows: table.rows.length } : { ok: false, message: table.problem.message };
}

type Row<C extends string> = Readonly<Record<C, string>> & { readonly all: Readonly<Record<string, string>> };

type TableResult<C extends string> =
  | { readonly ok: true; readonly rows: readonly Row<C>[] }
  | { readonly ok: false; readonly problem: ExportProblem };

function readTable<C extends string>(file: ExportFile, text: string, required: readonly C[]): TableResult<C> {
  let records: string[][];
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: false, trim: false });
  } catch (error) {
    if (error instanceof CsvError) {
      return { ok: false, problem: { file, message: `The ${file} file is not valid CSV at line ${String(error.lines)}: ${error.message}` } };
    }
    throw error;
  }

  const [header, ...body] = records;
  if (!header) return { ok: false, problem: { file, message: `The ${file} file is empty.` } };

  const names = header.map((name) => name.trim());
  const missing = required.filter((column) => !names.includes(column));
  const otherFile = file === "businesses" ? PEOPLE_COLUMNS : BUSINESS_COLUMNS;
  if (missing.length > 0 && otherFile.every((column) => names.includes(column))) {
    const other = file === "businesses" ? "People" : "Businesses";
    const self = file === "businesses" ? "Businesses" : "People";
    return { ok: false, problem: { file, message: `This is the ${other} file. Choose the ${self} file here.` } };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      problem: { file, message: `The ${file} file is missing these columns: ${missing.join(", ")}.` },
    };
  }

  const rows = body.map((cells) => {
    const all: Record<string, string> = {};
    names.forEach((name, index) => {
      all[name] = (cells[index] ?? "").trim();
    });
    const picked = Object.fromEntries(required.map((column) => [column, all[column] ?? ""]));
    // Every required column was checked above, so `picked` holds a string for each key.
    return { ...(picked as Record<C, string>), all };
  });
  return { ok: true, rows };
}

function toBusiness(row: Row<(typeof BUSINESS_COLUMNS)[number]>): ScrapedBusiness {
  const e164 = row.phone_e164;
  const original = row.phone_original;
  return {
    sourceBusinessId: row.business_id,
    placeId: row.place_id || null,
    name: row.business_name,
    category: row.category,
    mainPhone: e164 || original ? { e164, original } : null,
    generalEmails: splitEmails(row.general_emails),
    website: row.website,
    domain: row.domain,
    street: row.street,
    neighborhood: row.neighborhood,
    city: row.city,
    stateProvince: row.state_province,
    postalCode: row.postal_code,
    country: row.country,
    timezone: knownTimezone(row.timezone),
    source: row.all,
  };
}

function toPerson(row: Row<(typeof PEOPLE_COLUMNS)[number]>): ScrapedPerson {
  return {
    sourcePersonId: row.person_id,
    sourceBusinessId: row.business_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    title: row.title,
    roleTier: row.role_tier,
    timezone: knownTimezone(row.timezone),
    email: row.email,
    directPhone: row.direct_phone,
    dialPhone: row.dial_phone,
    dialPhoneType: row.dial_phone_type,
    linkedinUrl: row.linkedin_url,
    sourceUrls: parseUrlList(row.source_urls),
    source: row.all,
  };
}

/**
 * The sample holds at most one address per cell; no multi-address separator is established.
 * Split on the separators a list could plausibly use and keep only email-shaped parts.
 */
function splitEmails(cell: string): string[] {
  return cell
    .split(/[\s,;|]+/)
    .map((part) => part.trim())
    .filter((part) => part.includes("@"));
}

function parseUrlList(cell: string): string[] {
  if (!cell) return [];
  try {
    const parsed: unknown = JSON.parse(cell);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    return typeof parsed === "string" ? [parsed] : [];
  } catch {
    return [cell];
  }
}

function knownTimezone(value: string): string | null {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
