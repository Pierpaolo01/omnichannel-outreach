import { describe, expect, test } from "vitest";
import { linkedinStepKind, stepNumber, type CampaignDefinition, type TrackDefinition } from "../domain/sequence/definition.ts";
import { LINKEDIN_STEP_KIND_AT, stepTitle, trackPhrase } from "./track-label.ts";

const step = (id: string, removed = false) => ({ id, waitDays: 0, subject: "", body: "x", threading: "new_subject" as const, removed });
const track = (id: string, channel: TrackDefinition["channel"], branch: TrackDefinition["branch"] = "main", steps = [step(`${id}-1`)]): TrackDefinition => ({ id, channel, branch, window: [], steps, start: { kind: "entry" }, removed: false });
const def = (tracks: TrackDefinition[]): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], tracks });

describe("a LinkedIn step is named by its role (ticket 24b; ADR 0004 3.1)", () => {
  test("the role by number is the engine's role by position, for every place among live steps, a removed step not counted", () => {
    const li = track("li", "linkedin", "main", [step("a"), step("gone", true), step("b"), step("c"), step("d")]);
    const live = li.steps.filter((s) => !s.removed);
    live.forEach((s, i) => expect(LINKEDIN_STEP_KIND_AT(i + 1)).toBe(linkedinStepKind(li, s.id)));
  });

  test("with the InMail fallback on, the InMail is named by its role and every other step by its number as before (ADR 0004 13.9)", () => {
    const inmail = { ...step("im"), role: "inmail" as const };
    const li = track("li", "linkedin", "main", [step("a"), inmail, step("gone", true), step("b"), step("c")]);
    for (const s of li.steps.filter((x) => !x.removed)) expect(LINKEDIN_STEP_KIND_AT(stepNumber(li, s.id), s.role)).toBe(linkedinStepKind(li, s.id));
    const main = { label: "LinkedIn track", several: false, branch: "main" as const };
    expect(li.steps.filter((x) => !x.removed).map((s) => stepTitle(main, "linkedin", stepNumber(li, s.id), s.role))).toEqual(["Connection invite", "InMail", "First message", "Follow-up 1"]);
    // Switched off (removed), the steps keep their names; a removed InMail is still an InMail.
    const off = { ...li, steps: li.steps.map((s) => (s.id === "im" ? { ...s, removed: true } : s)) };
    expect(linkedinStepKind(off, "im")).toBe("inmail");
    expect(["a", "b", "c"].map((id) => linkedinStepKind(off, id))).toEqual(["invite", "first_message", "follow_up"]);
  });

  test("titles: the invite, the first message, follow-ups counted from 1; a win-back step says its branch; email and texts keep their numbers", () => {
    const main = { label: "LinkedIn track", several: false, branch: "main" as const };
    const winBack = { ...main, branch: "win_back" as const };
    expect([1, 2, 3, 4].map((n) => stepTitle(main, "linkedin", n))).toEqual(["Connection invite", "First message", "Follow-up 1", "Follow-up 2"]);
    expect(stepTitle(winBack, "linkedin", 1)).toBe("Win-back connection invite");
    expect(stepTitle(main, "email", 2)).toBe("Email 2");
    expect(stepTitle(winBack, "sms", 1)).toBe("Win-back text 1");
  });

  test("a LinkedIn track inside a sentence keeps its capital: never “linkedIn”", () => {
    const d = def([track("li", "linkedin"), track("li2", "linkedin"), track("w", "linkedin", "win_back")]);
    expect(trackPhrase(d, d.tracks[0]!)).toBe("LinkedIn track 1");
    expect(trackPhrase(def([track("li", "linkedin")]), track("li", "linkedin"))).toBe("the LinkedIn track");
    expect(trackPhrase(d, d.tracks[2]!)).toBe("the win-back LinkedIn track");
  });
});
