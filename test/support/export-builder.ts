import { parseScraperExport, type ScraperExport } from "../../src/domain/scraper-export.ts";

/** Builds a paired export with the verified real headers from a few fields per row. */
const BUSINESS_HEADER =
  "business_id,place_id,business_name,category,phone_e164,phone_original,general_emails,website,domain,street,neighborhood,city,state_province,postal_code,country,search_area,search_place,timezone,tz_check,rating,review_count,maps_url,facebook,instagram,linkedin_company,chain_flag,status,people_count,run_ids,first_seen,last_seen,phone_extension".split(",");
const PEOPLE_HEADER =
  "person_id,business_id,business_name,city,neighborhood,timezone,full_name,first_name,last_name,title,role_tier,email,email_status,email_source,direct_phone,direct_phone_source,dial_phone,dial_phone_type,linkedin_url,sources,source_urls,evidence,confidence,run_id,found_at".split(",");

type Row = Readonly<Record<string, string>>;

const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const csv = (header: readonly string[], rows: readonly Row[]) =>
  [header.join(","), ...rows.map((row) => header.map((column) => cell(row[column] ?? "")).join(","))].join("\n") + "\n";

export function business(fields: Row): Row {
  return { country: "GB", city: "London", timezone: "Europe/London", category: "Physiotherapist", ...fields };
}

export function person(fields: Row): Row {
  const full = fields["full_name"] ?? "";
  const [first = "", ...rest] = full.split(" ");
  return { first_name: first, last_name: rest.join(" "), title: "Owner", role_tier: "decision_maker", ...fields };
}

export function exportOf(rows: { businesses: readonly Row[]; people?: readonly Row[] }): ScraperExport {
  const result = parseScraperExport({ businessesCsv: csv(BUSINESS_HEADER, rows.businesses), peopleCsv: csv(PEOPLE_HEADER, rows.people ?? []) });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.value;
}
