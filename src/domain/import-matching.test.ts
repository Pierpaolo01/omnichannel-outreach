import { describe, expect, test } from "vitest";
import { business, person } from "../../test/support/export-builder.ts";
import { HARNESSES, type CompanyState, type ImportHarness } from "../../test/support/import-harness.ts";
import type { ImportSummary, SummaryEntry } from "./import-plan.ts";

/**
 * Joining, person matching, phone identity, ownership and company matching (review rounds 1
 * and 2 on PR 31). Every case runs through the planner with the directory helper and through
 * the real SQLite store, so the two cannot drift apart.
 */

function entry(summary: ImportSummary, name: string): SummaryEntry {
  const found = summary.entries.filter((e) => e.name === name);
  if (found.length !== 1) throw new Error(`expected one entry for ${name}, got ${found.length}`);
  return found[0] as SummaryEntry;
}

async function onlyCompany(h: ImportHarness, name: string): Promise<CompanyState> {
  const found = await h.companies(name);
  if (found.length !== 1 || !found[0]) throw new Error(`expected one company named ${name}, found ${found.length}`);
  return found[0];
}

const harbour = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", phone_original: "020 7946 0101" });
const noLine = { ...harbour, phone_e164: "", phone_original: "" };

describe.each(HARNESSES)("import rules, $name", ({ make }) => {
  describe("a People row joins only to a business in the same export", () => {
    test("a row whose business is only in the CRM is not enrolled, even when the CRM holds that business_id", async () => {
      const h = make();
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
      const h = make();
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

  describe("person matching", () => {
    test("same-name rows with different identifiers in one export stay two people", async () => {
      const h = make();
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
      const h = make();
      const row = person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" });
      const first = await h.import({ businesses: [harbour], people: [row, row] });
      expect(first.counts.new).toBe(1);
      const again = await h.import({ businesses: [harbour], people: [row, row] });
      expect(again.counts).toMatchObject({ new: 0, already_enrolled: 1 });
      expect((await h.peopleNamed("Amira Hassan")).map((p) => p.enrollments)).toEqual([1]);
    });

    test("rows with the same personal email at one company are one person", async () => {
      const h = make();
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

    const amira = (fields: Record<string, string>) => ({
      businesses: [harbour],
      people: [person({ business_id: "b1", full_name: "Amira Hassan", ...fields })],
    });

    test("a scraper ID that reappears with a different name is a different person", async () => {
      const h = make();
      await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
      const second = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Bob Carter", email: "bob@harbour.example" })] });
      expect(entry(second, "Bob Carter")).toMatchObject({ outcome: "new" });
      expect(await h.peopleNamed("Amira Hassan")).toHaveLength(1);
    });

    test("a changed ID with the same name and no email is the same person", async () => {
      const h = make();
      await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
      const second = await h.import(amira({ person_id: "p77" }));
      expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "already_enrolled" });
    });

    test("a changed ID with a newly found email is the same person, and the email is added as newer", async () => {
      const h = make();
      await h.import(amira({ person_id: "p1", email: "amira@harbour.example" }));
      const second = await h.import(amira({ person_id: "p77", email: "a.hassan@elsewhere.example" }));
      expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "updated", added: [{ value: "a.hassan@elsewhere.example" }] });
      expect((await h.peopleNamed("Amira Hassan")).map((p) => p.enrollments)).toEqual([1]);
    });

    test("names compare without titles, punctuation or case", async () => {
      const h = make();
      const grace = (name: string, id: string) => ({ businesses: [harbour], people: [person({ person_id: id, business_id: "b1", full_name: name })] });
      await h.import(grace("Grace Okafor", "p1"));
      expect(entry(await h.import(grace("Dr. Grace OKAFOR", "p2")), "Dr. Grace OKAFOR")).toMatchObject({ outcome: "already_enrolled" });
    });

    test("punctuation is removed, not read as a word break", async () => {
      const h = make();
      const xena = (name: string) => ({ businesses: [harbour], people: [person({ person_id: "ap", business_id: "b1", full_name: name })] });
      await h.import(xena("Xena O’Neil"));
      expect(entry(await h.import(xena("Xena ONeil")), "Xena ONeil")).toMatchObject({ outcome: "already_enrolled" });
      expect(entry(await h.import(xena("Xena O'Neil")), "Xena O'Neil")).toMatchObject({ outcome: "already_enrolled" });
    });

    test("same-name colleagues already on record stay separate when a row could be either", async () => {
      const h = make();
      const run1 = {
        businesses: [harbour],
        people: [
          person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam.lee@harbour.example" }),
          person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
        ],
      };
      await h.import(run1);
      const again = await h.import(run1);
      expect(again.entries.filter((e) => e.name === "Sam Lee").map((e) => e.outcome)).toEqual(["already_enrolled", "already_enrolled"]);
      const ambiguous = await h.import({ businesses: [harbour], people: [person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee" })] });
      expect(entry(ambiguous, "Sam Lee")).toMatchObject({ outcome: "new" });
    });
  });

  describe("phone identity and ownership", () => {
    test("a personal field holding the company main line in national form is the main line", async () => {
      const h = make();
      const summary = await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "020 7946 0101" })] });
      const company = await onlyCompany(h, "Harbour Lane Physio");
      expect(company.details).toEqual([expect.objectContaining({ value: "+44 20 7946 0101", phoneKind: "main_line" })]);
      expect(company.people[0]?.details).toEqual([]);
      expect(entry(summary, "Grace Okafor")).toMatchObject({ via: ["main_line"] });
    });

    test("one number in two written forms has one bad mark", async () => {
      const h = make();
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
      const h = make();
      await h.import({ businesses: [noLine], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "+44 20 7946 0101" })] });
      await h.markBad("+44 20 7946 0101");
      await h.import({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor" })] });
      const company = await onlyCompany(h, "Harbour Lane Physio");
      expect(company.details).toEqual([expect.objectContaining({ phoneKind: "main_line", bad: true })]);
      expect(company.people[0]?.details).toEqual([]);
    });

    test("a number two colleagues list, later the main line, ends with the company alone, and repeat imports succeed", async () => {
      const h = make();
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
      const h = make();
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
      const h = make();
      const summary = await h.import({
        businesses: [harbour],
        people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", direct_phone: "07700 900101", dial_phone: "+447700900101", dial_phone_type: "mobile" })],
      });
      expect((await h.peopleNamed("Amira Hassan"))[0]?.details).toEqual([expect.objectContaining({ phoneKind: "mobile", value: "+44 7700 900101" })]);
      expect(entry(summary, "Amira Hassan")).toMatchObject({ channels: { sms: true } });
    });

    test("a direct number a later import shows to be a mobile becomes a mobile, and the lead counts as updated", async () => {
      const h = make();
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
      const h = make();
      const named = { ...harbour, country: "United Kingdom" };
      await h.import({ businesses: [named], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "020 7946 0101", dial_phone: "07700 900188", dial_phone_type: "mobile" })] });
      const company = await onlyCompany(h, "Harbour Lane Physio");
      expect(company.details.map((d) => d.value)).toEqual(["+44 20 7946 0101"]);
      expect(company.people[0]?.details.map((d) => d.value)).toEqual(["+44 7700 900188"]);
    });

    test("a number a colleague already holds stays theirs", async () => {
      const h = make();
      await h.import({
        businesses: [noLine],
        people: [
          person({ person_id: "y", business_id: "b1", full_name: "Yara Glen", direct_phone: "+442079460166" }),
          person({ person_id: "z", business_id: "b1", full_name: "Zara Glen", direct_phone: "020 7946 0166" }),
        ],
      });
      const company = await onlyCompany(h, "Harbour Lane Physio");
      expect(company.people.flatMap((p) => p.details.map((d) => d.value))).toEqual(["+44 20 7946 0166"]);
    });
  });

  describe("company matching", () => {
    test("a changed main line followed by a changed ID still finds the same company", async () => {
      const h = make();
      const clinic = (id: string, phone: string) => business({ business_id: id, place_id: "", business_name: "Elm Street Chiropractic", phone_e164: phone });
      const people = (id: string) => [person({ person_id: "p1", business_id: id, full_name: "Daniel Price", email: "daniel@elm.example" })];
      await h.import({ businesses: [clinic("b1", "+442079460401")], people: people("b1") });
      await h.import({ businesses: [clinic("b1", "+442079460402")], people: people("b1") });
      const third = await h.import({ businesses: [clinic("b9", "+442079460402")], people: people("b9") });
      expect(await h.companies("Elm Street Chiropractic")).toHaveLength(1);
      expect(entry(third, "Daniel Price")).toMatchObject({ outcome: "already_enrolled" });
    });

    test("a main line two companies share matches neither", async () => {
      const h = make();
      const branch = (id: string, place: string) => business({ business_id: id, place_id: place, business_name: "City Physio", phone_e164: "+442079460500" });
      await h.import({ businesses: [branch("b1", "P1"), branch("b2", "P2")] });
      await h.import({ businesses: [branch("b3", "")] });
      expect(await h.companies("City Physio")).toHaveLength(3);
    });

    test("a reused business ID alone does not merge two different businesses", async () => {
      const h = make();
      await h.import({ businesses: [business({ business_id: "b7", place_id: "", business_name: "Harbour Clinic", phone_e164: "+442079460701" })] });
      await h.import({ businesses: [business({ business_id: "b7", place_id: "P9", business_name: "Unrelated Dental", phone_e164: "+442079460799" })] });
      expect(await h.companies("Harbour Clinic")).toHaveLength(1);
      expect(await h.companies("Unrelated Dental")).toHaveLength(1);
    });
  });

  // Shrunk from failures of the generated sequences (src/server/import-sequences.test.ts).
  describe("importing the same files again changes nothing", () => {
    test("when a business ID is on two companies after a rename, the repeat settles on the one whose name agrees", async () => {
      const h = make();
      const studio = business({ business_id: "bz-1", place_id: "", business_name: "Northgate Dental Studio" });
      await h.import({ businesses: [studio] });
      await h.import({ businesses: [business({ business_id: "bz-1", place_id: "PL-1", business_name: "Northgate Dental" })] });
      const rows = { businesses: [studio], people: [person({ person_id: "pp-3", business_id: "bz-1", full_name: "Grace Okafor", email: "grace@northgate.example" })] };
      await h.import(rows);
      const again = await h.import(rows);
      expect(again.counts).toMatchObject({ new: 0, updated: 0 });
      expect(await h.companies("Northgate Dental Studio")).toHaveLength(1);
    });

    test("a row whose ID was taken through another row's email settles on one person when imported again", async () => {
      const h = make();
      await h.import({ businesses: [harbour], people: [person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" })] });
      const rows = {
        businesses: [harbour],
        people: [
          person({ person_id: "pp-2", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
          person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee" }),
        ],
      };
      await h.import(rows);
      const again = await h.import(rows);
      expect(again.counts).toMatchObject({ new: 0, updated: 0 });
      expect(await h.peopleNamed("Sam Lee")).toHaveLength(2);
    });

    test("a row with no person ID and an ambiguous name is new once, then the same person", async () => {
      const h = make();
      await h.import({
        businesses: [harbour],
        people: [
          person({ person_id: "pp-1", business_id: "b1", full_name: "Sam Lee", email: "sam@harbour.example" }),
          person({ person_id: "pp-2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
        ],
      });
      const rows = { businesses: [harbour], people: [person({ person_id: "", business_id: "b1", full_name: "Sam Lee" })] };
      expect(entry(await h.import(rows), "Sam Lee")).toMatchObject({ outcome: "new" });
      expect(entry(await h.import(rows), "Sam Lee")).toMatchObject({ outcome: "already_enrolled" });
      expect(await h.peopleNamed("Sam Lee")).toHaveLength(3);
    });
  });
});
