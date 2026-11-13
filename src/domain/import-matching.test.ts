import { describe, expect, test } from "vitest";
import { business, person } from "../../test/support/export-builder.ts";
import { importHarness, type CompanyState, type ImportHarness } from "../../test/support/import-harness.ts";
import type { ImportSummary, SummaryEntry } from "./import-plan.ts";

/**
 * Joining, matching, phone identity and ownership, through the real HTTP app and SQLite store.
 * The matching rule (docs/adr/0001): a row matches an existing person or company only on
 * evidence that singles out one record. When several records fit, or one record fits two rows,
 * the row changes nothing and the result says why. Importing the same files again changes nothing.
 */

function entry(summary: ImportSummary, name: string): SummaryEntry {
  const found = summary.entries.filter((e) => e.name === name);
  if (found.length !== 1) throw new Error(`expected one entry for ${name}, got ${found.length}`);
  return found[0] as SummaryEntry;
}

function entries(summary: ImportSummary, name: string): SummaryEntry[] {
  return summary.entries.filter((e) => e.name === name);
}

async function onlyCompany(h: ImportHarness, name: string): Promise<CompanyState> {
  const found = await h.companies(name);
  if (found.length !== 1 || !found[0]) throw new Error(`expected one company named ${name}, found ${found.length}`);
  return found[0];
}

/** Importing the same files again reports no new or updated leads and keeps every record as it was. */
async function expectRepeatChangesNothing(h: ImportHarness, rows: Parameters<ImportHarness["import"]>[0], names: readonly string[]): Promise<ImportSummary> {
  const before = await Promise.all(names.map((n) => h.peopleNamed(n)));
  const again = await h.import(rows);
  expect(again.counts).toMatchObject({ new: 0, updated: 0 });
  expect(await Promise.all(names.map((n) => h.peopleNamed(n)))).toEqual(before);
  return again;
}

const harbour = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", phone_original: "020 7946 0101" });
const noLine = { ...harbour, phone_e164: "", phone_original: "" };
const ambiguousPerson = { outcome: "not_enrolled", reason: "ambiguous_match", record: "person", lead: null };
const ambiguousCompany = { outcome: "not_enrolled", reason: "ambiguous_match", record: "company", lead: null };

describe("a People row joins only to a business in the same export", () => {
  test("a row whose business is only in the CRM is not enrolled, even when the CRM holds that business_id", async () => {
    const h = importHarness();
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan" })] });
    const other = business({ business_id: "b2", place_id: "P2", business_name: "Northgate Dental", phone_e164: "+442079460202" });
    const second = await h.import({
      businesses: [other],
      people: [
        person({ person_id: "p2", business_id: "b2", full_name: "Grace Okafor" }),
        person({ person_id: "p9", business_id: "b1", full_name: "Jordan Lee", email: "jordan@example.test" }),
      ],
    });
    expect(entry(second, "Jordan Lee")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
    expect(await h.peopleNamed("Jordan Lee")).toEqual([]);
  });

  test("a blank business_id never matches, not even another blank one", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [harbour, business({ business_id: "", place_id: "P3", business_name: "Nameless Clinic", phone_e164: "+442079460303" })],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan" }),
        person({ person_id: "p2", business_id: "", full_name: "Blank Row", email: "blank@example.test" }),
      ],
    });
    expect(entry(summary, "Blank Row")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
  });
});

describe("rows of one export that are one person", () => {
  test("same-name rows with different identifiers stay two people", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam.lee@harbour.example" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
      ],
    });
    expect((await h.peopleNamed("Sam Lee")).map((p) => p.enrollments)).toEqual([1, 1]);
  });

  test("a duplicated row is one person, and re-importing it enrols nobody again", async () => {
    const h = importHarness();
    const row = person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" });
    const first = await h.import({ businesses: [harbour], people: [row, row] });
    expect(first.counts.new).toBe(1);
    const again = await h.import({ businesses: [harbour], people: [row, row] });
    expect(again.counts).toMatchObject({ new: 0, already_enrolled: 1 });
    expect((await h.peopleNamed("Amira Hassan")).map((p) => p.enrollments)).toEqual([1]);
  });

  // GPT round 3, item 2.
  test("identical rows without a person ID or email are one person, and importing them again enrols nobody", async () => {
    const h = importHarness();
    const row = person({ person_id: "", business_id: "b1", full_name: "Sam Lee", direct_phone: "+44 20 7946 0303" });
    const rows = { businesses: [harbour], people: [row, row] };
    expect((await h.import(rows)).counts.new).toBe(1);
    await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    expect((await h.peopleNamed("Sam Lee")).map((p) => p.enrollments)).toEqual([1]);
  });

  test("rows with the same personal email at one company are one person", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", email: "Amira@harbour.example" }),
        person({ person_id: "p7", business_id: "b1", full_name: "A. Hassan", email: "amira@harbour.example", direct_phone: "+44 20 7946 0177" }),
      ],
    });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.people).toHaveLength(1);
    expect(company.people[0]?.details.map((d) => d.value)).toEqual(["Amira@harbour.example", "+44 20 7946 0177"]);
  });
});

describe("person matching", () => {
  const amira = (fields: Record<string, string>) => ({
    businesses: [harbour],
    people: [person({ business_id: "b1", full_name: "Amira Hassan", ...fields })],
  });

  test("a scraper ID that reappears with a different name is a different person", async () => {
    const h = importHarness();
    await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
    const second = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Bob Carter", email: "bob@harbour.example" })] });
    expect(entry(second, "Bob Carter")).toMatchObject({ outcome: "new" });
    expect(await h.peopleNamed("Amira Hassan")).toHaveLength(1);
  });

  test("a changed ID with the same name and no email is the same person", async () => {
    const h = importHarness();
    await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
    const second = await h.import(amira({ person_id: "p77" }));
    expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "already_enrolled" });
  });

  test("a changed ID with a newly found email is the same person, and the email is added as newer", async () => {
    const h = importHarness();
    await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
    const second = await h.import(amira({ person_id: "p77", email: "a.hassan@elsewhere.example" }));
    expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "updated", added: [{ value: "a.hassan@elsewhere.example" }] });
    expect((await h.peopleNamed("Amira Hassan")).map((p) => p.enrollments)).toEqual([1]);
  });

  test("names compare without titles, punctuation or case", async () => {
    const h = importHarness();
    const grace = (name: string, id: string) => ({ businesses: [harbour], people: [person({ person_id: id, business_id: "b1", full_name: name })] });
    await h.import(grace("Grace Okafor", "p1"));
    expect(entry(await h.import(grace("Dr. Grace OKAFOR", "p2")), "Dr. Grace OKAFOR")).toMatchObject({ outcome: "already_enrolled" });
  });

  test("punctuation is removed, not read as a word break", async () => {
    const h = importHarness();
    const xena = (name: string) => ({ businesses: [harbour], people: [person({ person_id: "ap", business_id: "b1", full_name: name })] });
    await h.import(xena("Xena O’Neil"));
    expect(entry(await h.import(xena("Xena ONeil")), "Xena ONeil")).toMatchObject({ outcome: "already_enrolled" });
    expect(entry(await h.import(xena("Xena O'Neil")), "Xena O'Neil")).toMatchObject({ outcome: "already_enrolled" });
  });

  test("a row that only a shared name ties to two people on record changes nothing, and says so", async () => {
    const h = importHarness();
    const run1 = {
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam.lee@harbour.example" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
      ],
    };
    await h.import(run1);
    const again = await h.import(run1);
    expect(entries(again, "Sam Lee").map((e) => e.outcome)).toEqual(["already_enrolled", "already_enrolled"]);
    const lone = { businesses: [harbour], people: [person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee" })] };
    expect(entry(await h.import(lone), "Sam Lee")).toMatchObject({ ...ambiguousPerson, conflict: "several_records", companyName: "Harbour Lane Physio" });
    await expectRepeatChangesNothing(h, lone, ["Sam Lee"]);
    expect(await h.peopleNamed("Sam Lee")).toHaveLength(2);
  });

  // GPT round 3, item 3: a conflicting email is not added to whichever Sam was created last.
  test("a third same-name row with an unknown email changes nothing when two people share the name", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Owner", email: "sam@harbour.example" }),
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", email: "s.lee@harbour.example" }),
      ],
    });
    const third = await h.import({ businesses: [harbour], people: [person({ person_id: "", business_id: "b1", full_name: "Sam Lee", email: "lee.sam@mail.example" })] });
    expect(entry(third, "Sam Lee")).toMatchObject({ ...ambiguousPerson, conflict: "several_records" });
    const sams = await h.peopleNamed("Sam Lee");
    expect(sams.flatMap((p) => p.details.map((d) => d.value)).sort()).toEqual(["s.lee@harbour.example", "sam@harbour.example"]);
  });

  // GPT round 3, item 3: an ID two same-name people now hold is told apart by the row's number.
  test("a person ID two same-name people hold is resolved by the number the row carries", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", title: "Owner", direct_phone: "+44 20 7946 0303" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", email: "s.lee@harbour.example" }),
      ],
    });
    // The scraper reuses p1 on the practice manager's row; the email says who it is.
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", email: "s.lee@harbour.example" })] });
    const owner = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", title: "Owner and founder", direct_phone: "020 7946 0303" })] });
    expect(entry(owner, "Sam Lee")).toMatchObject({ outcome: "already_enrolled" });
    const sams = await h.peopleNamed("Sam Lee");
    expect(sams.map((p) => [p.title, p.details.map((d) => d.value)])).toEqual(
      expect.arrayContaining([
        ["Owner and founder", ["+44 20 7946 0303"]],
        ["Practice manager", ["s.lee@harbour.example"]],
      ]),
    );
  });

  // Opus round 3, item 2: with creation order as a tie-breaker, the titles swapped on every repeat.
  test("same-name colleagues without IDs or emails keep their own titles and numbers when the files are imported again", async () => {
    const h = importHarness();
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Owner", direct_phone: "+44 20 7946 0303" }),
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", direct_phone: "+44 20 7946 0404" }),
      ],
    };
    await h.import(rows);
    await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    const sams = await h.peopleNamed("Sam Lee");
    expect(sams.map((p) => [p.title, p.details.map((d) => d.value)])).toEqual(
      expect.arrayContaining([
        ["Owner", ["+44 20 7946 0303"]],
        ["Practice manager", ["+44 20 7946 0404"]],
      ]),
    );
  });

  // Opus round 3, item 3: new person IDs on every run used to add and enrol two more people each time.
  test("same-name colleagues whose person IDs change every run are matched by name and number, and nobody is enrolled again", async () => {
    const h = importHarness();
    const run = (n: number) => ({
      businesses: [harbour],
      people: [
        person({ person_id: `r${n}-a`, business_id: "b1", full_name: "Sam Lee", title: "Owner", direct_phone: "+44 20 7946 0303" }),
        person({ person_id: `r${n}-b`, business_id: "b1", full_name: "Sam Lee", title: "Practice manager", direct_phone: "+44 20 7946 0404" }),
      ],
    });
    await h.import(run(1));
    expect((await h.import(run(2))).counts).toMatchObject({ new: 0, already_enrolled: 2 });
    expect((await h.import(run(3))).counts).toMatchObject({ new: 0, already_enrolled: 2 });
    expect((await h.peopleNamed("Sam Lee")).map((p) => p.enrollments)).toEqual([1, 1]);
  });

  test("same-name colleagues with nothing to tell them apart are reported, not merged or duplicated, on every repeat", async () => {
    const h = importHarness();
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Owner" }),
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Practice manager" }),
      ],
    };
    expect((await h.import(rows)).counts.new).toBe(2);
    const again = await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    expect(entries(again, "Sam Lee")).toEqual([
      expect.objectContaining({ ...ambiguousPerson, conflict: "several_records" }),
      expect.objectContaining({ ...ambiguousPerson, conflict: "several_records" }),
    ]);
  });

  // Shrunk from generated sequence seed 20261119: the colleague matched by email is not a candidate for the other row.
  test("same-name colleagues, one known by email and one by name only, land on their own records when imported again", async () => {
    const h = importHarness();
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee", title: "Owner", email: "sam@harbour.example" }),
        person({ person_id: "", business_id: "b1", full_name: "Sam Lee", title: "Practice manager" }),
      ],
    };
    const first = await h.import(rows);
    const again = await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    expect(again.rowRecords.people).toEqual(first.rowRecords.people);
    expect(again.counts).toMatchObject({ already_enrolled: 2, not_enrolled: 0 });
  });

  test("two rows that both fit the one person on record change nothing, and each says another row fits too", async () => {
    const h = importHarness();
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" })] });
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "p8", business_id: "b1", full_name: "Sam Lee", title: "Owner" }),
        person({ person_id: "p9", business_id: "b1", full_name: "Sam Lee", title: "Practice manager" }),
      ],
    };
    const summary = await h.import(rows);
    expect(entries(summary, "Sam Lee")).toEqual([
      expect.objectContaining({ ...ambiguousPerson, conflict: "another_row" }),
      expect.objectContaining({ ...ambiguousPerson, conflict: "another_row" }),
    ]);
    await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    expect(await h.peopleNamed("Sam Lee")).toHaveLength(1);
  });

  test("a row whose ID was taken through another row's email changes nothing, while the email row matches", async () => {
    const h = importHarness();
    await h.import({ businesses: [harbour], people: [person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" })] });
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "pp-2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
        person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee", title: "Practice manager" }),
      ],
    };
    const summary = await h.import(rows);
    expect(entries(summary, "Sam Lee").map((e) => [e.outcome, "conflict" in e ? e.conflict : null])).toEqual([
      ["already_enrolled", null],
      ["not_enrolled", "another_row"],
    ]);
    await expectRepeatChangesNothing(h, rows, ["Sam Lee"]);
    expect(await h.peopleNamed("Sam Lee")).toHaveLength(1);
  });

  test("a person already enrolled in one campaign is enrolled in a second without a new record", async () => {
    const h = importHarness();
    const rows = { businesses: [harbour], people: [person({ person_id: "", business_id: "b1", full_name: "Grace Okafor" })] };
    await h.import(rows, "A");
    expect((await h.import(rows, "B")).counts).toMatchObject({ new: 1 });
    expect((await h.import(rows, "B")).counts).toMatchObject({ new: 0, already_enrolled: 1 });
    expect((await h.peopleNamed("Grace Okafor")).map((p) => p.enrollments)).toEqual([2]);
  });
});

describe("phone identity and ownership", () => {
  test("a personal field holding the company main line in national form is the main line", async () => {
    const h = importHarness();
    const summary = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "020 7946 0101" })] });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0101", phoneKind: "main_line" })]);
    expect(company.people[0]?.details).toEqual([]);
    expect(entry(summary, "Grace Okafor")).toMatchObject({ via: ["main_line"] });
  });

  test("one number in two written forms has one bad mark", async () => {
    const h = importHarness();
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor" })] });
    await h.markBad("+44 20 7946 0101");
    const second = await h.import({
      businesses: [{ ...harbour, phone_e164: "" }],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "0044 20 7946 0101" })],
    });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0101", bad: true })]);
    expect(company.people[0]?.details).toEqual([]);
    expect(entry(second, "Grace Okafor")).toMatchObject({ outcome: "already_enrolled", channels: { call: false } });
  });

  test("a person's number a later import lists as the main line moves to the company, keeping its mark", async () => {
    const h = importHarness();
    await h.import({ businesses: [noLine], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "+44 20 7946 0101" })] });
    await h.markBad("+44 20 7946 0101");
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor" })] });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ phoneKind: "main_line", bad: true })]);
    expect(company.people[0]?.details).toEqual([]);
  });

  // Opus round 3, item 4.
  test("a national number first stored without a known country is the main line once a later import names the country", async () => {
    const h = importHarness();
    const regionless = { ...noLine, country: "" };
    await h.import({ businesses: [regionless], people: [person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw", dial_phone: "020 7946 0101", dial_phone_type: "mobile" })] });
    const second = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw" })] });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0101", phoneKind: "main_line" })]);
    expect(company.people[0]?.details).toEqual([]);
    expect(entry(second, "Ann Shaw")).toMatchObject({ channels: { sms: false, call: true } });
  });

  test("a number two colleagues list, later the main line, ends with the company alone, and repeat imports succeed", async () => {
    const h = importHarness();
    const people = [
      person({ person_id: "y", business_id: "b1", full_name: "Yara Glen", direct_phone: "+442079460155" }),
      person({ person_id: "z", business_id: "b1", full_name: "Zara Glen", direct_phone: "020 7946 0155" }),
    ];
    await h.import({ businesses: [noLine], people });
    const promoted = { businesses: [{ ...noLine, phone_e164: "+442079460155" }], people };
    await h.import(promoted);
    await h.import(promoted);
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0155", phoneKind: "main_line" })]);
    expect(company.people.flatMap((p) => p.details)).toEqual([]);
  });

  test("an email a later import lists as the shared inbox stops being anyone's personal email", async () => {
    const h = importHarness();
    await h.import({ businesses: [noLine], people: [person({ person_id: "p1", business_id: "b1", full_name: "Alice Moor", email: "info@harbour.example" })] });
    await h.markBad("info@harbour.example");
    const second = await h.import({
      businesses: [{ ...noLine, general_emails: "info@harbour.example" }],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Alice Moor", email: "info@harbour.example" })],
    });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details).toEqual([expect.objectContaining({ value: "info@harbour.example", owner: "company", bad: true })]);
    expect(company.people[0]?.details).toEqual([]);
    expect(entry(second, "Alice Moor")).toMatchObject({ channels: { email: false } });
  });

  test("a number listed both as direct and as mobile keeps its mobile capability", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [harbour],
      people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", direct_phone: "07700 900101", dial_phone: "+447700900101", dial_phone_type: "mobile" })],
    });
    expect((await h.peopleNamed("Amira Hassan"))[0]?.details).toEqual([expect.objectContaining({ phoneKind: "mobile", value: "+44 7700 900101" })]);
    expect(entry(summary, "Amira Hassan")).toMatchObject({ channels: { sms: true } });
  });

  test("a direct number a later import shows to be a mobile becomes a mobile, and the lead counts as updated", async () => {
    const h = importHarness();
    const run = (fields: Record<string, string>) => ({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", ...fields })] });
    await h.import(run({ direct_phone: "07700 900101" }));
    const second = await h.import(run({ dial_phone: "+44 7700 900101", dial_phone_type: "mobile" }));
    expect(entry(second, "Amira Hassan")).toMatchObject({
      outcome: "updated",
      channels: { sms: true },
      becameMobile: [{ channel: "phone", phoneKind: "mobile", value: "+44 7700 900101" }],
    });
  });

  test("national numbers read in the main line's region when the country column is not a code", async () => {
    const h = importHarness();
    const named = { ...harbour, country: "United Kingdom" };
    await h.import({ businesses: [named], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "020 7946 0101", dial_phone: "07700 900188", dial_phone_type: "mobile" })] });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.details.map((d) => d.value)).toEqual(["+44 20 7946 0101"]);
    expect(company.people[0]?.details.map((d) => d.value)).toEqual(["+44 7700 900188"]);
  });

  // Opus round 3, item 9.
  test("a number a colleague already holds stays theirs, and the row that listed it says so", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [noLine],
      people: [
        person({ person_id: "y", business_id: "b1", full_name: "Yara Glen", direct_phone: "+442079460166" }),
        person({ person_id: "z", business_id: "b1", full_name: "Zara Glen", direct_phone: "020 7946 0166", email: "zara@harbour.example" }),
      ],
    });
    const company = await onlyCompany(h, "Harbour Lane Physio");
    expect(company.people.flatMap((p) => p.details.filter((d) => d.value.startsWith("+")).map((d) => d.value))).toEqual(["+44 20 7946 0166"]);
    expect(entry(summary, "Zara Glen")).toMatchObject({
      heldElsewhere: [{ detail: { channel: "phone", phoneKind: "direct", value: "+44 20 7946 0166" }, holder: "Yara Glen" }],
    });
    expect(entry(summary, "Yara Glen")).toMatchObject({ heldElsewhere: [] });
  });
});

describe("company matching", () => {
  test("a changed main line, then a changed ID, still finds the same company by its address and then its line", async () => {
    const h = importHarness();
    const clinic = (id: string, phone: string) =>
      business({ business_id: id, place_id: "", business_name: "Elm Street Chiropractic", phone_e164: phone, street: "4 Elm Street", postal_code: "N1 7AA" });
    const people = (id: string) => [person({ person_id: "p1", business_id: id, full_name: "Daniel Price", email: "daniel@elm.example" })];
    await h.import({ businesses: [clinic("b1", "+442079460401")], people: people("b1") });
    await h.import({ businesses: [clinic("b1", "+442079460402")], people: people("b1") });
    const third = await h.import({ businesses: [clinic("b9", "+442079460402")], people: people("b9") });
    expect(await h.companies("Elm Street Chiropractic")).toHaveLength(1);
    expect(entry(third, "Daniel Price")).toMatchObject({ outcome: "already_enrolled" });
  });

  // Opus round 3, item 5.
  test("a business ID and name shared by two branches with different main lines and addresses are two companies", async () => {
    const h = importHarness();
    const north = business({ business_id: "b1", place_id: "", business_name: "City Physio", phone_e164: "+442079460101", street: "1 North Street", postal_code: "N1 1AA" });
    const south = business({ business_id: "b1", place_id: "", business_name: "City Physio", phone_e164: "+442079460505", street: "9 South Road", postal_code: "SE1 9ZZ" });
    await h.import({ businesses: [north] });
    expect(entry(await h.import({ businesses: [south] }), "City Physio")).toMatchObject({ outcome: "new" });
    await h.import({ businesses: [north] });
    await h.import({ businesses: [south] });
    const branches = await h.companies("City Physio");
    expect(branches.map((c) => c.details.map((d) => d.value)).sort()).toEqual([["+44 20 7946 0101"], ["+44 20 7946 0505"]]);
  });

  // GPT round 3, item 1: the newest branch used to win a reused business ID.
  test("a reused business ID resolves to the branch whose main line agrees, not the newest", async () => {
    const h = importHarness();
    const branch = (place: string, line: string) => business({ business_id: "b7", place_id: place, business_name: "City Physio", phone_e164: line });
    await h.import({ businesses: [branch("P1", "+442079460101")] });
    await h.import({ businesses: [branch("P2", "+442079460202")] });
    await h.import({ businesses: [branch("", "+442079460101")] });
    const branches = await h.companies("City Physio");
    expect(branches.map((c) => c.details.map((d) => d.value)).sort()).toEqual([["+44 20 7946 0101"], ["+44 20 7946 0202"]]);
  });

  // Shrunk from generated sequence seed 20261197: the business ID said one branch, the main line the other.
  test("a row whose business ID points to one branch and main line to another changes nothing, and says so", async () => {
    const h = importHarness();
    const north = business({ business_id: "bz-3", place_id: "PL-3", business_name: "City Physio", phone_e164: "+442079460404" });
    const south = business({ business_id: "bz-5", place_id: "", business_name: "City Physio", street: "9 South Road", postal_code: "SE1 9ZZ" });
    await h.import({ businesses: [north, south] });
    const before = await h.companies("City Physio");
    const mixed = business({ business_id: "bz-5", place_id: "", business_name: "City Physio", phone_original: "020 7946 0404" });
    expect(entry(await h.import({ businesses: [mixed] }), "City Physio")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction", disagreeing: ["business_id", "main_line"] });
    expect(await h.companies("City Physio")).toEqual(before);
  });

  test("a main line two companies share matches neither, and the row says so", async () => {
    const h = importHarness();
    const branch = (id: string, place: string) => business({ business_id: id, place_id: place, business_name: "City Physio", phone_e164: "+442079460500" });
    await h.import({ businesses: [branch("b1", "P1"), branch("b2", "P2")] });
    const third = await h.import({ businesses: [branch("b3", "")] });
    expect(entry(third, "City Physio")).toMatchObject({ ...ambiguousCompany, conflict: "several_records" });
    expect(await h.companies("City Physio")).toHaveLength(2);
  });

  test("a reused business ID alone does not merge two different businesses", async () => {
    const h = importHarness();
    await h.import({ businesses: [business({ business_id: "b7", place_id: "", business_name: "Harbour Clinic", phone_e164: "+442079460701" })] });
    await h.import({ businesses: [business({ business_id: "b7", place_id: "P9", business_name: "Unrelated Dental", phone_e164: "+442079460799" })] });
    expect(await h.companies("Harbour Clinic")).toHaveLength(1);
    expect(await h.companies("Unrelated Dental")).toHaveLength(1);
  });

  // Verification round 4, D1.
  test("a company with no IDs, main line or address is the same company when the identical files are imported again", async () => {
    const h = importHarness();
    const unkeyed = business({ business_id: "", place_id: "", business_name: "Unkeyed Clinic", general_emails: "office@unkeyed.example" });
    expect((await h.import({ businesses: [unkeyed] })).counts.new).toBe(1);
    expect((await h.import({ businesses: [unkeyed] })).counts).toMatchObject({ new: 0, already_enrolled: 1 });
    expect((await onlyCompany(h, "Unkeyed Clinic")).companyLeadEnrollments).toBe(1);
  });

  test("identical company rows in one export are one company", async () => {
    const h = importHarness();
    const unkeyed = business({ business_id: "", place_id: "", business_name: "Unkeyed Clinic", general_emails: "office@unkeyed.example" });
    const summary = await h.import({ businesses: [unkeyed, unkeyed] });
    expect(summary.counts.new).toBe(1);
    expect(summary.rowRecords.businesses[0]).toBe(summary.rowRecords.businesses[1]);
  });

  test("a name two companies share, on a row with nothing else to go on, changes nothing and says so", async () => {
    const h = importHarness();
    await h.import({
      businesses: [
        business({ business_id: "b1", place_id: "P1", business_name: "City Physio", phone_e164: "+442079460101" }),
        business({ business_id: "b2", place_id: "P2", business_name: "City Physio", phone_e164: "+442079460202" }),
      ],
    });
    const bare = business({ business_id: "", place_id: "", business_name: "City Physio", general_emails: "hello@cityphysio.example" });
    const summary = await h.import({ businesses: [bare], people: [] });
    expect(entry(summary, "City Physio")).toMatchObject({ ...ambiguousCompany, conflict: "several_records" });
    expect(await h.companies("City Physio")).toHaveLength(2);
  });

  test("the people of a company row that matches several companies change nothing either", async () => {
    const h = importHarness();
    const branch = (id: string, place: string) => business({ business_id: id, place_id: place, business_name: "City Physio", phone_e164: "+442079460500" });
    await h.import({ businesses: [branch("b1", "P1"), branch("b2", "P2")] });
    const summary = await h.import({ businesses: [branch("b3", "")], people: [person({ person_id: "p1", business_id: "b3", full_name: "Nia Cole", email: "nia@cityphysio.example" })] });
    expect(entry(summary, "Nia Cole")).toMatchObject({ ...ambiguousCompany, conflict: "several_records", companyName: "City Physio" });
    expect(await h.peopleNamed("Nia Cole")).toEqual([]);
  });

  test("when a business ID is on two companies after a rename, the repeat settles on the one whose name agrees", async () => {
    const h = importHarness();
    const studio = business({ business_id: "bz-1", place_id: "", business_name: "Northgate Dental Studio" });
    await h.import({ businesses: [studio] });
    await h.import({ businesses: [business({ business_id: "bz-1", place_id: "PL-1", business_name: "Northgate Dental" })] });
    const rows = { businesses: [studio], people: [person({ person_id: "pp-3", business_id: "bz-1", full_name: "Grace Okafor", email: "grace@northgate.example" })] };
    await h.import(rows);
    await expectRepeatChangesNothing(h, rows, ["Grace Okafor"]);
    expect(await h.companies("Northgate Dental Studio")).toHaveLength(1);
  });
});

describe("the record each row landed in", () => {
  test("is reported for every row, and is null for a row that was not applied", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan" }),
        person({ person_id: "p2", business_id: "b9", full_name: "Jordan Lee" }),
      ],
    });
    const amira = entry(summary, "Amira Hassan");
    expect(summary.rowRecords).toEqual({
      businesses: [amira.lead?.kind === "person" ? (await onlyCompany(h, "Harbour Lane Physio")).id : "?"],
      people: [amira.lead?.kind === "person" ? amira.lead.personId : "?", null],
    });
  });
});

// Review round 4 (Opus, GPT) and verification round 5.
describe("contradicting evidence changes nothing", () => {
  const renamed = (name: string) =>
    business({ business_id: "b1", place_id: "", business_name: name, phone_e164: "+442079460101", street: "1 Harbour Lane", postal_code: "N1 1AA" });
  const ann = (businessId: string) => person({ person_id: "p1", business_id: businessId, full_name: "Ann Shaw", email: "ann@harbour.example" });

  // Opus round 4, P1: the rename split the company and enrolled Ann twice.
  test("a row whose business ID and main line belong to a company on record under another name changes nothing", async () => {
    const h = importHarness();
    await h.import({ businesses: [renamed("Harbour Lane Physio")], people: [ann("b1")] });
    const rows = { businesses: [renamed("Harbour Lane Physiotherapy Clinic")], people: [ann("b1")] };
    const second = await h.import(rows);
    expect(entry(second, "Harbour Lane Physiotherapy Clinic")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction", disagreeing: ["name", "main_line"] });
    expect(entry(second, "Ann Shaw")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction" });
    expect(await h.companies("Harbour Lane Physiotherapy Clinic")).toEqual([]);
    expect((await h.peopleNamed("Ann Shaw")).map((p) => p.enrollments)).toEqual([1]);
    await expectRepeatChangesNothing(h, rows, ["Ann Shaw"]);
  });

  test("a main line on record under another name, with nothing else to go on, changes nothing", async () => {
    const h = importHarness();
    await h.import({ businesses: [business({ business_id: "b1", place_id: "", business_name: "Elm Street Chiro", phone_e164: "+442079460303" })] });
    const other = await h.import({ businesses: [business({ business_id: "b2", place_id: "", business_name: "Oak Road Dental", phone_original: "020 7946 0303" })] });
    expect(entry(other, "Oak Road Dental")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction", disagreeing: ["name", "main_line"] });
  });

  // GPT round 4, item 1: weaker ID evidence chose between two email matches.
  test("rows that share an ID but carry two known emails stay two people, each matched by email", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "a", business_id: "b1", full_name: "Sam Lee", title: "Owner", email: "sam@harbour.example" }),
        person({ person_id: "b", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", email: "lee@harbour.example" }),
      ],
    });
    const before = await h.peopleNamed("Sam Lee");
    const rows = {
      businesses: [harbour],
      people: [
        person({ person_id: "a", business_id: "b1", full_name: "Sam Lee", title: "Owner", email: "sam@harbour.example" }),
        person({ person_id: "a", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", email: "lee@harbour.example" }),
      ],
    };
    const summary = await h.import(rows);
    expect(entries(summary, "Sam Lee").map((e) => e.outcome)).toEqual(["already_enrolled", "already_enrolled"]);
    expect(new Set(summary.rowRecords.people)).toEqual(new Set(before.map((p) => p.id)));
    expect((await h.peopleNamed("Sam Lee")).map((p) => p.title).sort()).toEqual(["Owner", "Practice manager"]);
  });

  // GPT round 4, item 1: rows sharing a business ID but not a place ID merged two branches.
  test("business rows that share an ID but carry different place IDs stay two companies, and their people change nothing", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [
        business({ business_id: "b7", place_id: "P1", business_name: "City Physio", phone_e164: "+442079460101" }),
        business({ business_id: "b7", place_id: "P2", business_name: "City Physio", phone_e164: "+442079460202" }),
      ],
      people: [person({ person_id: "p1", business_id: "b7", full_name: "Nia Cole", email: "nia@cityphysio.example" })],
    });
    const branches = await h.companies("City Physio");
    expect(branches.map((c) => c.details.map((d) => d.value)).sort()).toEqual([["+44 20 7946 0101"], ["+44 20 7946 0202"]]);
    expect(entry(summary, "Nia Cole")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction", disagreeing: ["business_id", "place_id"] });
    expect(await h.peopleNamed("Nia Cole")).toEqual([]);
  });

  test("a person row whose ID points to one person and number to another names both details", async () => {
    const h = importHarness();
    await h.import({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", title: "Owner", direct_phone: "+44 20 7946 0303" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", title: "Practice manager", direct_phone: "+44 20 7946 0404" }),
      ],
    });
    const mixed = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", direct_phone: "020 7946 0404" })] });
    expect(entry(mixed, "Sam Lee")).toMatchObject({ ...ambiguousPerson, conflict: "contradiction", disagreeing: ["person_id", "phone"] });
  });
});

describe("main lines compare by their key", () => {
  // GPT round 4, item 2: learning the country duplicated the company and its enrollment.
  test("a company first imported without a country is the same company once the country is known, and keeps its bad mark", async () => {
    const h = importHarness();
    const clinic = (country: string, line: string) =>
      business({ business_id: "b1", place_id: "", business_name: "Harbour Clinic", country, phone_e164: line.startsWith("+") ? line : "", phone_original: line });
    await h.import({ businesses: [clinic("", "020 7946 0101")] });
    await h.markBad("02079460101");
    const second = await h.import({ businesses: [clinic("GB", "+442079460101")] });
    expect(entry(second, "Harbour Clinic")).toMatchObject({ outcome: "already_enrolled", stillBad: [{ value: "+44 20 7946 0101" }] });
    const company = await onlyCompany(h, "Harbour Clinic");
    expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0101", phoneKind: "main_line", bad: true })]);
    expect(company.companyLeadEnrollments).toBe(1);
  });
});

describe("one personal email, mobile or shared inbox per enrolled lead in a campaign", () => {
  const clinic = (id: string, name: string, line: string, inbox = "") => business({ business_id: id, place_id: "", business_name: name, phone_e164: line, general_emails: inbox });

  for (const order of ["Harbour first", "Elm first"] as const) {
    test(`two people listing the same email with equal evidence are both left unenrolled, each naming the other (${order})`, async () => {
      const h = importHarness();
      const people = [
        person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw", email: "ann@mail.example" }),
        person({ person_id: "p2", business_id: "b2", full_name: "Ann Shaw", email: "ann@mail.example" }),
      ];
      const rows = { businesses: [clinic("b1", "Harbour Clinic", "+442079460101"), clinic("b2", "Elm Clinic", "+442079460202")], people: order === "Harbour first" ? people : [...people].reverse() };
      const summary = await h.import(rows);
      expect(entries(summary, "Ann Shaw").map((e) => [e.outcome, e.outcome === "not_enrolled" && e.reason === "shares_contact" ? e.shared.companyName : null]).sort()).toEqual([
        ["not_enrolled", "Elm Clinic"],
        ["not_enrolled", "Harbour Clinic"],
      ]);
      await expectRepeatChangesNothing(h, rows, ["Ann Shaw"]);
      expect((await h.import(rows, "B")).counts).toMatchObject({ new: 0, not_enrolled: 2 });
    });
  }

  test("an enrolled lead keeps an email a new row also lists, and the new row is not enrolled", async () => {
    const h = importHarness();
    const harbourAnn = person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw", email: "ann@mail.example" });
    await h.import({ businesses: [clinic("b1", "Harbour Clinic", "+442079460101")], people: [harbourAnn] });
    const summary = await h.import({
      businesses: [clinic("b2", "Elm Clinic", "+442079460202"), clinic("b1", "Harbour Clinic", "+442079460101")],
      people: [person({ person_id: "p2", business_id: "b2", full_name: "Ann Shaw", email: "ann@mail.example" }), harbourAnn],
    });
    expect(entries(summary, "Ann Shaw").map((e) => e.outcome).sort()).toEqual(["already_enrolled", "not_enrolled"]);
  });

  test("the same holds for a mobile", async () => {
    const h = importHarness();
    const summary = await h.import({
      businesses: [clinic("b1", "Harbour Clinic", ""), clinic("b2", "Elm Clinic", "")],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw", dial_phone: "+447700900111", dial_phone_type: "mobile" }),
        person({ person_id: "p2", business_id: "b2", full_name: "Bea Shaw", dial_phone: "07700 900111", dial_phone_type: "mobile" }),
      ],
    });
    expect(entry(summary, "Bea Shaw")).toMatchObject({ outcome: "not_enrolled", reason: "shares_contact" });
  });

  test("two company leads with the same shared inbox and equal evidence are both left unenrolled", async () => {
    const h = importHarness();
    const summary = await h.import({ businesses: [clinic("b1", "Harbour Clinic", "", "office@group.example"), clinic("b2", "Elm Clinic", "", "office@group.example")] });
    expect(entry(summary, "Harbour Clinic")).toMatchObject({ outcome: "not_enrolled", reason: "shares_contact", shared: { lead: "Elm Clinic" } });
    expect(entry(summary, "Elm Clinic")).toMatchObject({ outcome: "not_enrolled", reason: "shares_contact", shared: { lead: "Harbour Clinic" } });
  });

  test("an enrolled lead does not gain an email another lead enrolled in the same campaign has", async () => {
    const h = importHarness();
    await h.import({
      businesses: [clinic("b1", "Harbour Clinic", "+442079460101"), clinic("b2", "Elm Clinic", "+442079460202")],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Ann Shaw", email: "ann@mail.example" }),
        person({ person_id: "p2", business_id: "b2", full_name: "Bea Moss" }),
      ],
    });
    const second = await h.import({ businesses: [clinic("b2", "Elm Clinic", "+442079460202")], people: [person({ person_id: "p2", business_id: "b2", full_name: "Bea Moss", email: "ann@mail.example" })] });
    expect(entry(second, "Bea Moss")).toMatchObject({ outcome: "already_enrolled", heldElsewhere: [{ detail: { value: "ann@mail.example" }, holder: "Ann Shaw" }] });
    expect((await h.peopleNamed("Bea Moss"))[0]?.details).toEqual([]);
  });
});

describe("rows of one export that are the same person or company on weaker evidence", () => {
  // Opus round 4, P2.
  test("rows with an agreeing name and the same personal number are one person", async () => {
    const h = importHarness();
    const run = (n: number) => ({
      businesses: [harbour],
      people: [
        person({ person_id: `r${n}-a`, business_id: "b1", full_name: "Dan Price", title: "Owner", dial_phone: "+447700900222", dial_phone_type: "mobile" }),
        person({ person_id: `r${n}-b`, business_id: "b1", full_name: "Dan Price", title: "Clinic director", dial_phone: "07700 900222", dial_phone_type: "mobile" }),
      ],
    });
    expect((await h.import(run(1))).counts.new).toBe(1);
    expect((await h.import(run(2))).counts).toMatchObject({ new: 0, already_enrolled: 1, not_enrolled: 0 });
    expect((await h.peopleNamed("Dan Price")).map((p) => p.enrollments)).toEqual([1]);
  });

  // Opus round 4, P4.
  test("company rows with an agreeing name and main line are one company, and its person is enrolled once", async () => {
    const h = importHarness();
    const listing = (id: string, website: string) => business({ business_id: id, place_id: "", business_name: "City Physio", phone_e164: "+442079460500", website });
    const summary = await h.import({
      businesses: [listing("b1", "https://cityphysio.example"), listing("b2", "https://www.cityphysio.example/home")],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Nia Cole", email: "nia@cityphysio.example" }),
        person({ person_id: "p9", business_id: "b2", full_name: "Nia Cole", email: "nia@cityphysio.example" }),
      ],
    });
    expect(summary.rowRecords.businesses[0]).toBe(summary.rowRecords.businesses[1]);
    expect((await h.peopleNamed("Nia Cole")).map((p) => p.enrollments)).toEqual([1]);
  });

  test("company rows with an agreeing name and main line but different addresses stay two companies", async () => {
    const h = importHarness();
    const branch = (id: string, street: string, postal: string) => business({ business_id: id, place_id: "", business_name: "City Physio", phone_e164: "+442079460500", street, postal_code: postal });
    const summary = await h.import({ businesses: [branch("b1", "1 North Street", "N1 1AA"), branch("b2", "9 South Road", "SE1 9ZZ")] });
    expect(summary.rowRecords.businesses[0]).not.toBe(summary.rowRecords.businesses[1]);
  });
});

// Review round 5.
describe("each collapsed row is checked on its own evidence", () => {
  const sams = (manager: Record<string, string>) => [
    person({ person_id: "a", business_id: "b1", full_name: "Sam Lee", title: "Owner", direct_phone: "+44 20 7946 0303" }),
    person({ business_id: "b1", full_name: "Sam Lee", title: "Practice manager", direct_phone: "+44 20 7946 0404", ...manager }),
  ];

  // GPT round 5, finding 1: the manager's row borrowed the owner's number through the shared ID.
  for (const order of ["owner first", "manager first"] as const) {
    test(`a row sharing a reused person ID whose number belongs to someone else changes nothing (${order})`, async () => {
      const h = importHarness();
      await h.import({ businesses: [harbour], people: sams({ person_id: "b" }) });
      const before = await h.peopleNamed("Sam Lee");
      const rows = sams({ person_id: "a", email: "manager@harbour.example" });
      const summary = await h.import({ businesses: [harbour], people: order === "owner first" ? rows : [...rows].reverse() });
      const managerRow = order === "owner first" ? 1 : 0;
      expect(summary.rowRecords.people[managerRow]).toBeNull();
      expect(entries(summary, "Sam Lee").find((e) => e.outcome === "not_enrolled" && e.reason === "ambiguous_match")).toMatchObject({ ...ambiguousPerson, conflict: "contradiction", disagreeing: ["person_id", "phone"] });
      expect(await h.peopleNamed("Sam Lee")).toEqual(before);
    });
  }

  // GPT round 5, finding 1: the south branch's main line was added to the north record.
  for (const order of ["north first", "south first"] as const) {
    test(`a business row sharing a reused business ID whose main line belongs to another branch settles as if imported alone (${order})`, async () => {
      const h = importHarness();
      const branch = (id: string, line: string, street: string, postal: string) => business({ business_id: id, place_id: "", business_name: "City Physio", phone_e164: line, street, postal_code: postal });
      await h.import({ businesses: [branch("a", "+442079460101", "1 North Street", "N1 1AA"), branch("b", "+442079460505", "9 South Road", "SE1 9ZZ")] });
      const before = await h.companies("City Physio");
      const rows = [branch("a", "+442079460101", "1 North Street", "N1 1AA"), branch("a", "+442079460505", "9 South Road", "SE1 9ZZ")];
      const people = [person({ person_id: "p1", business_id: "a", full_name: "Nia Cole", email: "nia@cityphysio.example" })];
      const summary = await h.import({ businesses: order === "north first" ? rows : [...rows].reverse(), people });
      const [north, south] = order === "north first" ? [0, 1] : [1, 0];
      const recordOf = (line: string) => before.find((c) => c.details.some((d) => d.value === line))?.id;
      expect(summary.rowRecords.businesses[north]).toBe(recordOf("+44 20 7946 0101"));
      expect(summary.rowRecords.businesses[south]).toBe(recordOf("+44 20 7946 0505"));
      expect(await h.companies("City Physio")).toEqual(before);
      // Review round 6, finding 3: a person sharing that business ID could belong to either branch.
      expect(entry(summary, "Nia Cole")).toMatchObject({ ...ambiguousCompany, conflict: "contradiction", disagreeing: ["business_id"] });
      expect(await h.peopleNamed("Nia Cole")).toEqual([]);
    });
  }

  // Opus round 6, finding 2: Jo's row borrowed Sam's match through the shared ID and renamed Sam.
  for (const order of ["Sam first", "Jo first"] as const) {
    test(`a row sharing a reused person ID with no evidence of its own for the match settles as if imported alone (${order})`, async () => {
      const h = importHarness();
      const samRow = person({ person_id: "a", business_id: "b1", full_name: "Sam Lee", direct_phone: "+44 20 7946 0303" });
      await h.import({ businesses: [harbour], people: [samRow] });
      const [sam] = await h.peopleNamed("Sam Lee");
      const jo = person({ person_id: "a", business_id: "b1", full_name: "Jo Bloggs", title: "Practice manager", email: "jo@harbour.example" });
      const summary = await h.import({ businesses: [harbour], people: order === "Sam first" ? [samRow, jo] : [jo, samRow] });
      expect(entry(summary, "Sam Lee")).toMatchObject({ outcome: "already_enrolled" });
      expect(entry(summary, "Jo Bloggs")).toMatchObject({ outcome: "new" });
      expect(await h.peopleNamed("Sam Lee")).toEqual([sam]);
      expect((await h.peopleNamed("Jo Bloggs"))[0]?.details.map((d) => d.value)).toEqual(["jo@harbour.example"]);
    });
  }
});

describe("the campaign safety net counts the details a row lists", () => {
  // Opus round 5, probe Q1: the mobile stayed with Sam, so the renamed row's person was enrolled by email.
  test("a row whose mobile an enrolled colleague holds is not enrolled, and says whose it is", async () => {
    const h = importHarness();
    await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", dial_phone: "+447700900101", dial_phone_type: "mobile" })] });
    const rows = { businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Samuel Lee", email: "samuel@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" })] };
    const second = await h.import(rows);
    expect(entry(second, "Samuel Lee")).toMatchObject({
      outcome: "not_enrolled",
      reason: "shares_contact",
      shared: { detail: { channel: "phone", phoneKind: "mobile", value: "+44 7700 900101" }, lead: "Sam Lee", companyName: "Harbour Lane Physio" },
    });
    expect((await h.import(rows)).counts).toMatchObject({ new: 0, updated: 0 });
    expect((await h.peopleNamed("Samuel Lee")).map((p) => p.enrollments)).toEqual([0]);
  });
});

// Review round 6: the safety net must not depend on row order.
describe("the campaign safety net decides by evidence, not row order", () => {
  const sam = person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", dial_phone: "+447700900101", dial_phone_type: "mobile" });
  const samuel = person({ person_id: "p9", business_id: "b1", full_name: "Samuel Lee", email: "samuel@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" });

  for (const order of ["lister first", "holder first"] as const) {
    test(`the person who holds a mobile on record keeps it in a new campaign, and the row that only lists it is not enrolled (${order})`, async () => {
      const h = importHarness();
      await h.import({ businesses: [harbour], people: [sam] }, "A");
      const rows = { businesses: [harbour], people: order === "lister first" ? [samuel, sam] : [sam, samuel] };
      const summary = await h.import(rows, "B");
      expect(entry(summary, "Sam Lee")).toMatchObject({ outcome: "new" });
      expect(entry(summary, "Samuel Lee")).toMatchObject({
        outcome: "not_enrolled",
        reason: "shares_contact",
        shared: { detail: { channel: "phone", phoneKind: "mobile", value: "+44 7700 900101" }, lead: "Sam Lee" },
      });
      expect((await h.import(rows, "B")).counts).toMatchObject({ new: 0, updated: 0 });
    });
  }
});
