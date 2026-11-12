import { describe, expect, test } from "vitest";
import { directoryAfter, markBad } from "../../test/support/directory.ts";
import { sequentialIds } from "../../test/support/domain.ts";
import { business, exportOf, person } from "../../test/support/export-builder.ts";
import { emptyDirectory, planImport, type Directory, type ImportPlan, type SummaryEntry } from "./import-plan.ts";

/** Review round 1 on PR 31: joining, person matching, phone identity and company matching. */

const ids = sequentialIds("t");
const plan = (directory: Directory, scraped: ReturnType<typeof exportOf>, now = "2026-11-12T10:00:00.000Z") =>
  planImport({ directory, scraped, now, newId: ids });

function entry(p: ImportPlan, name: string): SummaryEntry {
  const found = p.summary.entries.filter((e) => e.name === name);
  if (found.length !== 1) throw new Error(`expected one entry for ${name}, got ${found.length}`);
  return found[0] as SummaryEntry;
}

const harbour = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", phone_original: "020 7946 0101" });

describe("a People row joins only to a business in the same export", () => {
  test("a row whose business is only in the CRM is not enrolled, even when the CRM holds that business_id", () => {
    const first = plan(emptyDirectory(), exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan" })] }));
    const crm = directoryAfter(emptyDirectory(), first);
    const other = business({ business_id: "b2", place_id: "P2", business_name: "Northgate Dental", phone_e164: "+442079460202" });
    const second = plan(
      crm,
      exportOf({
        businesses: [other],
        people: [
          person({ person_id: "p2", business_id: "b2", full_name: "Grace Okafor" }),
          person({ person_id: "p9", business_id: "b1", full_name: "Jordan Lee", email: "jordan@example.test" }),
        ],
      }),
    );
    expect(entry(second, "Jordan Lee")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
    expect(second.people.some((p) => p.fields.fullName === "Jordan Lee")).toBe(false);
  });

  test("a blank business_id never matches, not even another blank one", () => {
    const p = plan(
      emptyDirectory(),
      exportOf({
        businesses: [harbour, business({ business_id: "", place_id: "P3", business_name: "Nameless Clinic", phone_e164: "+442079460303" })],
        people: [
          person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan" }),
          person({ person_id: "p2", business_id: "", full_name: "Blank Row", email: "blank@example.test" }),
        ],
      }),
    );
    expect(entry(p, "Blank Row")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
  });
});

describe("person matching", () => {
  test("two rows in one export are never merged, even with the same name at the same company", () => {
    const p = plan(
      emptyDirectory(),
      exportOf({
        businesses: [harbour],
        people: [
          person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam.lee@harbour.example" }),
          person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
        ],
      }),
    );
    expect(p.people).toHaveLength(2);
    expect(p.summary.entries.filter((e) => e.name === "Sam Lee" && e.outcome === "new")).toHaveLength(2);
  });

  const amiraRun1 = exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" })] });

  test("a scraper ID that reappears with a different name is a different person", () => {
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), amiraRun1));
    const second = plan(crm, exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Bob Carter", email: "bob@harbour.example" })] }));
    expect(entry(second, "Bob Carter")).toMatchObject({ outcome: "new" });
    expect(second.people.find((p) => p.fields.fullName === "Bob Carter")?.isNew).toBe(true);
    expect(second.people.some((p) => p.fields.fullName === "Amira Hassan")).toBe(false);
  });

  test("a re-import whose ID changed matches on name and company when no email conflicts", () => {
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), amiraRun1));
    const second = plan(crm, exportOf({ businesses: [harbour], people: [person({ person_id: "p77", business_id: "b1", full_name: "Amira Hassan" })] }));
    expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "already_enrolled" });
    expect(second.enrollments).toEqual([]);
  });

  test("the same name with a conflicting email is a different person", () => {
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), amiraRun1));
    const second = plan(crm, exportOf({ businesses: [harbour], people: [person({ person_id: "p77", business_id: "b1", full_name: "Amira Hassan", email: "a.hassan@elsewhere.example" })] }));
    expect(entry(second, "Amira Hassan")).toMatchObject({ outcome: "new" });
  });

  test("names compare without titles, punctuation or case", () => {
    const grace = (name: string, id: string) =>
      exportOf({ businesses: [harbour], people: [person({ person_id: id, business_id: "b1", full_name: name })] });
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), grace("Grace Okafor", "p1")));
    const second = plan(crm, grace("Dr. Grace OKAFOR", "p2"));
    expect(entry(second, "Dr. Grace OKAFOR")).toMatchObject({ outcome: "already_enrolled" });
    expect(second.enrollments).toEqual([]);
  });

  test("same-name colleagues already on record stay separate when a row could be either", () => {
    const run1 = exportOf({
      businesses: [harbour],
      people: [
        person({ person_id: "p1", business_id: "b1", full_name: "Sam Lee", email: "sam.lee@harbour.example" }),
        person({ person_id: "p2", business_id: "b1", full_name: "Sam Lee", email: "s.lee@harbour.example" }),
      ],
    });
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), run1));
    const again = plan(crm, run1);
    expect(again.summary.entries.filter((e) => e.name === "Sam Lee").map((e) => e.outcome)).toEqual(["already_enrolled", "already_enrolled"]);
    const ambiguous = plan(crm, exportOf({ businesses: [harbour], people: [person({ person_id: "p3", business_id: "b1", full_name: "Sam Lee" })] }));
    expect(entry(ambiguous, "Sam Lee")).toMatchObject({ outcome: "new" });
  });
});

describe("phone identity", () => {
  test("a personal phone field holding the company main line in national form is the main line", () => {
    const p = plan(
      emptyDirectory(),
      exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "020 7946 0101" })] }),
    );
    expect(p.details.filter((d) => d.channel === "phone")).toEqual([
      expect.objectContaining({ owner: expect.objectContaining({ kind: "company" }), phoneKind: "main_line", key: "+442079460101" }),
    ]);
    expect(entry(p, "Grace Okafor")).toMatchObject({ via: ["main_line"] });
  });

  test("one number in two written forms has one bad mark", () => {
    const first = plan(emptyDirectory(), exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor" })] }));
    const crm = markBad(directoryAfter(emptyDirectory(), first), "+442079460101");
    const second = plan(
      crm,
      exportOf({
        businesses: [{ ...harbour, phone_e164: "" }],
        people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "0044 20 7946 0101" })],
      }),
    );
    expect(second.details).toEqual([]);
    expect(entry(second, "Grace Okafor")).toMatchObject({ outcome: "already_enrolled", channels: { call: false } });
  });

  test("a person's number that a later import lists as the main line moves to the company, keeping its mark", () => {
    const noPhone = { ...harbour, phone_e164: "", phone_original: "" };
    const first = plan(emptyDirectory(), exportOf({ businesses: [noPhone], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor", direct_phone: "+44 20 7946 0101" })] }));
    const held = first.details.find((d) => d.channel === "phone");
    const crm = markBad(directoryAfter(emptyDirectory(), first), "+442079460101");
    const second = plan(crm, exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Grace Okafor" })] }));
    expect(second.details).toEqual([]);
    expect(second.detailChanges).toEqual([{ id: held?.id, owner: expect.objectContaining({ kind: "company" }), phoneKind: "main_line" }]);
    const after = directoryAfter(crm, second);
    expect(after.companies[0]?.details).toEqual([expect.objectContaining({ id: held?.id, bad: true, phoneKind: "main_line" })]);
  });

  test("a number listed both as direct and as mobile keeps its mobile capability", () => {
    const p = plan(
      emptyDirectory(),
      exportOf({
        businesses: [harbour],
        people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", direct_phone: "07700 900101", dial_phone: "+447700900101", dial_phone_type: "mobile" })],
      }),
    );
    expect(p.details.filter((d) => d.owner.kind === "person")).toEqual([expect.objectContaining({ phoneKind: "mobile", key: "+447700900101" })]);
    expect(entry(p, "Amira Hassan")).toMatchObject({ channels: { sms: true } });
  });

  test("a direct number a later import shows to be a mobile becomes a mobile, and the lead counts as updated", () => {
    const run = (fields: Record<string, string>) =>
      exportOf({ businesses: [harbour], people: [person({ person_id: "p1", business_id: "b1", full_name: "Amira Hassan", ...fields })] });
    const first = plan(emptyDirectory(), run({ direct_phone: "07700 900101" }));
    const crm = directoryAfter(emptyDirectory(), first);
    const second = plan(crm, run({ dial_phone: "+44 7700 900101", dial_phone_type: "mobile" }));
    expect(second.detailChanges).toEqual([expect.objectContaining({ phoneKind: "mobile" })]);
    expect(entry(second, "Amira Hassan")).toMatchObject({
      outcome: "updated",
      channels: { sms: true },
      becameMobile: [{ channel: "phone", phoneKind: "mobile", value: "+44 7700 900101" }],
    });
  });
});

describe("company matching", () => {
  test("a changed main line followed by a changed ID still finds the same company", () => {
    const clinic = (id: string, phone: string) => business({ business_id: id, place_id: "", business_name: "Elm Street Chiropractic", phone_e164: phone });
    const people = (id: string) => [person({ person_id: "p1", business_id: id, full_name: "Daniel Price", email: "daniel@elm.example" })];
    let crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), exportOf({ businesses: [clinic("b1", "+442079460401")], people: people("b1") })));
    crm = directoryAfter(crm, plan(crm, exportOf({ businesses: [clinic("b1", "+442079460402")], people: people("b1") })));
    const third = plan(crm, exportOf({ businesses: [clinic("b9", "+442079460402")], people: people("b9") }));
    expect(third.companies.every((c) => !c.isNew)).toBe(true);
    expect(entry(third, "Daniel Price")).toMatchObject({ outcome: "already_enrolled" });
  });

  test("a main line two companies share matches neither", () => {
    const branch = (id: string, place: string) => business({ business_id: id, place_id: place, business_name: "City Physio", phone_e164: "+442079460500" });
    const crm = directoryAfter(emptyDirectory(), plan(emptyDirectory(), exportOf({ businesses: [branch("b1", "P1"), branch("b2", "P2")] })));
    const third = plan(crm, exportOf({ businesses: [branch("b3", "")] }));
    expect(third.companies.filter((c) => c.isNew)).toHaveLength(1);
  });
});
