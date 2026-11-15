import { describe, expect, test } from "vitest";
import type { BulkAddAnswer, BulkAddPreview, BulkControlAnswer, BulkControlPreview, BulkPreviewItem } from "../../shared/api.ts";
import { addConfirmText, addResultText, controlConfirmText, controlResultText, scopeNote } from "./wording.ts";

/** What Leads says about a bulk action (ticket 18): every count and reason from the server's preview or answer. Fictitious names. */

const allowed = { allowed: true as const, statusAfter: "paused" as const, skips: null, next: null, withProvider: 0, digest: "d" };
const item = (name: string, campaign: string, control: BulkPreviewItem["control"] = { action: "pause", ...allowed }): BulkPreviewItem => ({
  row: { kind: "person", id: name, name },
  enrollmentId: `${name}-${campaign}`,
  campaign: { id: campaign, name: campaign },
  status: "active",
  control,
});
const preview = (items: BulkPreviewItem[], scope: string | null, outOfScope: BulkControlPreview["outOfScope"] = []): BulkControlPreview => {
  const refused = items.filter((i) => !i.control.allowed);
  const reasons = [...new Set(refused.map((i) => (i.control.allowed ? "" : i.control.reason)))].map((reason) => ({ reason, count: refused.filter((i) => !i.control.allowed && i.control.reason === reason).length }));
  return { asOf: "2026-11-02T10:00:00Z", action: "pause", scope: scope ? { id: scope, name: scope } : null, rows: 2, items, outOfScope, counts: { applies: items.length - refused.length, refused: refused.length, reasons } };
};

describe("the bulk confirmation states its scope and what the server said it would do", () => {
  test("one campaign: how many it applies to, for whom, and each refusal's reason with its count", () => {
    const p = preview([item("Pat Oneil", "Clinics"), item("Nia Cole", "Clinics", { action: "pause", allowed: false, reason: "They are already paused." })], "Clinics", [{ kind: "person", id: "x", name: "Rae Lund" }]);
    expect(controlConfirmText(p)).toEqual({ text: "Pause 1 campaign enrollment for 2 people in Clinics? 1 is left alone: They are already paused. Rae Lund is not in Clinics.", canConfirm: true });
  });

  test("every campaign each person is in", () => {
    expect(controlConfirmText(preview([item("Pat Oneil", "Clinics"), item("Pat Oneil", "Dentists")], null)).text).toBe("Pause 2 campaign enrollments for 1 person, in every campaign they are in?");
  });

  test("nothing it applies to: nothing to confirm, and why", () => {
    expect(controlConfirmText(preview([item("Pat Oneil", "Clinics", { action: "pause", allowed: false, reason: "They are already paused." })], "Clinics"))).toEqual({ text: "Nothing to pause. 1 is left alone: They are already paused.", canConfirm: false });
    expect(controlConfirmText(preview([], "Clinics", [{ kind: "person", id: "x", name: "Rae Lund" }]))).toEqual({ text: "Nothing to pause. None of the selected is in Clinics.", canConfirm: false });
  });

  test("add: who is added, who is already in it, who cannot be and why, in the import results' wording", () => {
    const p: BulkAddPreview = {
      asOf: "2026-11-02T10:00:00Z",
      action: "add",
      campaign: { id: "c", name: "Dentists" },
      rows: [
        { row: { kind: "person", id: "1", name: "Pat Oneil" }, outcome: "enroll", notEnrolled: null },
        { row: { kind: "company", id: "2", name: "Quayside Clinic" }, outcome: "already_enrolled", notEnrolled: null },
        { row: { kind: "person", id: "3", name: "Oda Finch" }, outcome: "not_enrolled", notEnrolled: { reason: "no_usable_channel" } },
      ],
      counts: { enroll: 1, alreadyEnrolled: 1, notEnrolled: 1 },
    };
    expect(addConfirmText(p)).toEqual({ text: "Add 1 person to Dentists? 1 is already in it and left alone. Not added: Oda Finch: no personal email or mobile, and no usable company main line.", canConfirm: true });
  });

  test("the foot note names the scope", () => {
    expect(scopeNote({ name: "Clinics" }, false)).toBe("Bulk actions change the selected people’s campaigns in Clinics only.");
    expect(scopeNote(null, false)).toBe("Bulk actions change the selected people’s campaigns. Pick a campaign above to limit them to one campaign.");
  });

  test("the foot note's scope is the press's, named once loaded, and names company leads when any are selected (council item 9 on 3555a3e)", () => {
    expect(scopeNote({ name: null }, false)).toBe("Bulk actions change the selected people’s campaigns in the campaign Leads is filtered to only.");
    expect(scopeNote({ name: "Clinics" }, true)).toBe("Bulk actions change the selected people’s and company leads’ campaigns in Clinics only.");
  });
});

describe("the result says what the server did, lead by lead", () => {
  test("a partial result: how many applied of how many, and each lead not changed with the server's reason", () => {
    const answer: BulkControlAnswer = {
      bulkId: "b",
      action: "pause",
      results: [
        { enrollmentId: "e1", outcome: "applied", reason: null, replayed: false },
        { enrollmentId: "e2", outcome: "refused", reason: "This lead changed since you confirmed this, so nothing was changed.", replayed: false },
      ],
      counts: { applied: 1, refused: 1 },
    };
    expect(controlResultText(answer, { e1: { name: "Pat Oneil", campaign: "Clinics" }, e2: { name: "Nia Cole", campaign: "Clinics" } })).toEqual({
      summary: "Paused 1 of 2 campaign enrollments.",
      refused: ["Nia Cole in Clinics: This lead changed since you confirmed this, so nothing was changed."],
    });
  });

  test("all applied, and none applied", () => {
    const all: BulkControlAnswer = { bulkId: "b", action: "stop", results: [{ enrollmentId: "e1", outcome: "applied", reason: null, replayed: false }], counts: { applied: 1, refused: 0 } };
    expect(controlResultText(all, {}).summary).toBe("Stopped 1 campaign enrollment.");
    const none: BulkControlAnswer = { bulkId: "b", action: "resume", results: [{ enrollmentId: "e1", outcome: "refused", reason: "They are not paused.", replayed: false }], counts: { applied: 0, refused: 1 } };
    expect(controlResultText(none, {}).summary).toBe("Nothing was resumed.");
  });

  test("add", () => {
    const answer: BulkAddAnswer = {
      bulkId: "b",
      action: "add",
      campaign: { id: "c", name: "Dentists" },
      results: [
        { row: { kind: "person", id: "1", name: "Pat Oneil" }, outcome: "enrolled", notEnrolled: null, enrollmentId: "e9" },
        { row: { kind: "person", id: "2", name: "Nia Cole" }, outcome: "already_enrolled", notEnrolled: null, enrollmentId: null },
      ],
      counts: { enrolled: 1, alreadyEnrolled: 1, notEnrolled: 0 },
      replayed: false,
    };
    expect(addResultText(answer)).toEqual({ summary: "Added 1 person to Dentists. 1 was already in it.", refused: [] });
  });
});
