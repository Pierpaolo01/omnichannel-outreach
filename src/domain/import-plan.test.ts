import { describe, expect, test } from "vitest";
import { parsedFixture, sequentialIds } from "../../test/support/domain.ts";
import { emptyDirectory, planImport, type ImportSummary, type SummaryEntry } from "./import-plan.ts";

const NOW = "2026-11-12T10:00:00.000Z";

function entryFor(summary: ImportSummary, name: string): SummaryEntry {
  const entry = summary.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no summary entry for ${name}: ${summary.entries.map((e) => e.name).join(", ")}`);
  return entry;
}

describe("first import into a campaign", () => {
  const plan = planImport({ directory: emptyDirectory(), scraped: parsedFixture("run1"), now: NOW, newId: sequentialIds() });

  test("enrols every reachable decision maker separately, so one company can hold several leads", () => {
    expect(entryFor(plan.summary, "Amira Hassan")).toMatchObject({ outcome: "new", companyName: "Harbour Lane Physio" });
    expect(entryFor(plan.summary, "Tom")).toMatchObject({ outcome: "new", companyName: "Harbour Lane Physio" });
    const harbourLeads = plan.enrollments.filter((e) => e.lead.kind === "person");
    expect(harbourLeads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(plan.enrollments.map((e) => JSON.stringify(e.lead))).size).toBe(plan.enrollments.length);
  });

  test("enrols a company with no named decision maker as a company lead reachable through its company details", () => {
    expect(entryFor(plan.summary, "Riverside Sports Clinic")).toMatchObject({
      outcome: "new",
      lead: { kind: "company" },
      channels: { email: true, sms: false, call: true },
    });
  });

  test("gives a decision maker with only the company main line phone access only", () => {
    expect(entryFor(plan.summary, "Grace Okafor")).toMatchObject({
      outcome: "new",
      channels: { email: false, sms: false, call: true },
    });
  });

  test("uses a decision maker's own email and mobile, never the company's shared inbox", () => {
    expect(entryFor(plan.summary, "Amira Hassan")).toMatchObject({ channels: { email: true, sms: true, call: true } });
    expect(entryFor(plan.summary, "Daniel Price")).toMatchObject({ channels: { email: true, sms: false, call: false } });
  });

  test("keeps a decision maker with no usable channel on the company record without enrolling them", () => {
    expect(entryFor(plan.summary, "Sofia Marin")).toMatchObject({
      outcome: "not_enrolled",
      reason: "no_usable_channel",
      companyName: "Elm Street Chiropractic",
    });
    const sofia = plan.people.find((p) => p.fields.fullName === "Sofia Marin");
    const elm = plan.companies.find((c) => c.fields.name === "Elm Street Chiropractic");
    expect(sofia?.companyId).toBe(elm?.id);
    expect(plan.enrollments.some((e) => e.lead.kind === "person" && e.lead.personId === sofia?.id)).toBe(false);
  });

  test("does not enrol a company lead with no usable channel, and says why", () => {
    expect(entryFor(plan.summary, "Copper Kettle Osteopathy")).toMatchObject({
      outcome: "not_enrolled",
      reason: "no_usable_channel",
      lead: { kind: "company" },
    });
  });

  test("reports a person whose company is not in the businesses file as not enrolled", () => {
    expect(entryFor(plan.summary, "Jordan Lee")).toMatchObject({ outcome: "not_enrolled", reason: "company_not_in_export" });
    expect(plan.people.some((p) => p.fields.fullName === "Jordan Lee")).toBe(false);
  });

  test("enrols the company through its shared inbox when none of its decision makers can be reached", () => {
    expect(entryFor(plan.summary, "Juniper Pilates Studio")).toMatchObject({
      outcome: "new",
      lead: { kind: "company" },
      channels: { email: true, sms: false, call: false },
      via: ["shared_inbox"],
    });
    expect(entryFor(plan.summary, "Marco Bianchi")).toMatchObject({ outcome: "not_enrolled", reason: "no_usable_channel" });
    const juniper = plan.companies.find((c) => c.fields.name === "Juniper Pilates Studio");
    expect(plan.people.find((p) => p.fields.fullName === "Marco Bianchi")?.companyId).toBe(juniper?.id);
  });

  test("does not enrol the company itself while one of its decision makers can be reached", () => {
    expect(plan.summary.entries.some((e) => e.name === "Elm Street Chiropractic")).toBe(false);
    expect(plan.summary.entries.some((e) => e.name === "Harbour Lane Physio")).toBe(false);
  });

  test("names the routes each new lead can be reached on", () => {
    expect(entryFor(plan.summary, "Amira Hassan")).toMatchObject({ via: ["email", "mobile", "main_line"] });
    expect(entryFor(plan.summary, "Grace Okafor")).toMatchObject({ via: ["main_line"] });
    expect(entryFor(plan.summary, "Riverside Sports Clinic")).toMatchObject({ via: ["shared_inbox", "main_line"] });
  });

  test("counts each outcome", () => {
    expect(plan.summary.counts).toEqual({ new: 6, already_enrolled: 0, updated: 0, not_enrolled: 4 });
  });

  test("enrols new leads as queued, stamped with the time passed in", () => {
    expect(plan.enrollments.every((e) => e.status === "queued" && e.enrolledAt === NOW)).toBe(true);
  });
});
