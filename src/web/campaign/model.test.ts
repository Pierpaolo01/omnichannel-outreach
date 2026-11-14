import { describe, expect, test } from "vitest";
import { render } from "../../domain/sequence/copy.ts";
import { launchCheck } from "../../domain/sequence/blockers.ts";
import type { CampaignDefinition, StepDefinition, TrackDefinition } from "../../shared/api.ts";
import { fallbackIn, newTrack, removeStep, sendsOnItsOwn, setWindow, stepUsing, threadSubjectOf, trackName, withFallback } from "./model.ts";
import { draftProblems } from "./saveQueue.ts";

describe("the editor's fallback field rewrites every use of the field in a step", () => {
  test("adds, changes and removes a fallback, leaving other fields alone", () => {
    const text = "Hi {{first_name}}, {{ first_name | there }} at {{company}}.";
    const added = withFallback(text, "first_name", "there");
    expect(added).toBe("Hi {{first_name|there}}, {{first_name|there}} at {{company}}.");
    expect(render(added, { company: "Elm" })).toEqual({ ok: true, text: "Hi there, there at Elm." });
    expect(withFallback(added, "first_name", "")).toBe("Hi {{first_name}}, {{first_name}} at {{company}}.");
    // Braces and bars would end the token early, so they are dropped from a fallback.
    expect(withFallback("{{city}}", "city", "a|b}")).toBe("{{city|ab}}");
    expect(fallbackIn({ id: "s", waitDays: 0, subject: "{{city}}", body: "{{city|London}}", threading: "new_subject", removed: false }, "city")).toBe("London");
  });

  test("a sending window is one hours range on each chosen day, Monday first", () => {
    expect(setWindow([0, 1, 5], { start: 9, end: 17 })).toEqual([
      { day: 1, start: 9, end: 17 },
      { day: 5, start: 9, end: 17 },
      { day: 0, start: 9, end: 17 },
    ]);
  });
});

describe("removing an email and following a thread (review: SequenceTab.tsx:220 and :274)", () => {
  const step = (id: string, fields: Partial<StepDefinition> = {}): StepDefinition => ({ id, waitDays: 2, subject: "", body: `${id} copy`, threading: "continue_thread", removed: false, ...fields });
  const track = (steps: StepDefinition[]): TrackDefinition => ({ id: "t1", channel: "email", branch: "main", window: [{ day: 1, start: 9, end: 17 }], steps, start: { kind: "entry" }, removed: false });

  test("removing Email 1 makes the next email a first email: no wait, its own subject, its copy kept", () => {
    const next = removeStep(track([step("s1", { waitDays: 0, subject: "Hello", threading: "new_subject" }), step("s2"), step("s3", { waitDays: 4 })]), "s1");
    expect(next.steps.map((s) => [s.id, s.waitDays, s.threading, s.subject, s.body])).toEqual([
      ["s2", 0, "new_subject", "", "s2 copy"],
      ["s3", 4, "continue_thread", "", "s3 copy"],
    ]);
    expect(draftProblems({ timezone: "UTC", callSkipLimitDays: 2, emailPool: [], tracks: [next] })).toEqual([]);
  });

  test("a phone track's draft is said in place before it is sent: a skip limit below 1 or not whole, and calling hours with no day (ticket 14c)", () => {
    const call = (fields: Partial<TrackDefinition>): TrackDefinition => ({ ...track([step("c1", { waitDays: 0, body: "" })]), id: "p1", channel: "call", callSkipLimitDays: 2, ...fields });
    const def = (t: TrackDefinition) => ({ timezone: "UTC", callSkipLimitDays: 2, emailPool: [], tracks: [t] });
    expect(draftProblems(def(call({})))).toEqual([]);
    for (const bad of [0, -2, 1.5, Number.NaN]) expect(draftProblems(def(call({ callSkipLimitDays: bad })))).toEqual(["The call skip limit is a whole number of days, at least 1."]);
    expect(draftProblems(def(call({ window: [] })))).toEqual(["Choose at least one calling day."]);
  });

  test("removing a later email leaves the others as they were", () => {
    const steps = [step("s1", { waitDays: 0, subject: "Hello", threading: "new_subject" }), step("s2"), step("s3")];
    expect(removeStep(track(steps), "s2").steps).toEqual([steps[0], steps[2]]);
  });

  test("a continue-thread email continues the nearest earlier email that started a thread", () => {
    const steps = [step("s1", { waitDays: 0, subject: "A", threading: "new_subject" }), step("s2", { subject: "B", threading: "new_subject" }), step("s3"), step("s4")];
    expect([1, 2, 3].map((i) => threadSubjectOf(steps, i))).toEqual(["A", "B", "B"]);
  });
});

describe("the screen finds a field's step with the domain's own parser (PR 41 review: BeforeLaunchTab.tsx)", () => {
  const email = (id: string, subject: string, body: string, threading: StepDefinition["threading"] = "new_subject"): StepDefinition => ({ id, waitDays: id === "s1" ? 0 : 1, subject, body, threading, removed: false });
  const definition = (steps: StepDefinition[]): CampaignDefinition => ({
    timezone: "Europe/London",
    callSkipLimitDays: 2,
    emailPool: ["inbox-a"],
    tracks: [{ id: "t1", channel: "email", branch: "main", window: [{ day: 1, start: 9, end: 17 }], steps, start: { kind: "entry" }, removed: false }],
  });
  // A lead with none of the fields, so every field used without a fallback blocks launch.
  const blockedFields = (def: CampaignDefinition) => launchCheck(def, [{}], [{ id: "inbox-a", channel: "email", healthy: true }]).blockers.flatMap((b) => (b.kind === "missing_merge_field" ? [b.field] : []));

  const spellings: [string, StepDefinition[], string][] = [
    ["spaces inside the braces, in the body", [email("s1", "Hello", "Hi {{ first_name }},")], "s1"],
    ["a fallback after a bar elsewhere, and one use without", [email("s1", "Hello", "Hi {{first_name|there}}."), email("s2", "", "Again, {{ first_name }}.", "continue_thread")], "s2"],
    ["another case, which the domain treats as its own field", [email("s1", "Hello", "Hi {{ First_Name }}.")], "s1"],
    ["a token in the subject of an email that starts a thread", [email("s1", "", "Hi."), email("s2", "For {{ company }}", "Hello.")], "s2"],
  ];
  for (const [name, steps, expected] of spellings) {
    test(name, () => {
      const def = definition(steps);
      const fields = blockedFields(def);
      expect(fields.length).toBe(1);
      expect(stepUsing(def.tracks[0]!, fields[0]!)?.id).toBe(expected);
    });
  }

  test("a token in a continuing email's subject is not a use, as the domain renders no subject there", () => {
    const def = definition([email("s1", "Hello", "Hi."), email("s2", "{{city}}", "Hello.", "continue_thread")]);
    expect(blockedFields(def)).toEqual([]);
    expect(stepUsing(def.tracks[0]!, "city")).toBeUndefined();
  });
});

describe("what a running campaign does on its own, in its banner (council on 2cf1d90, item 3)", () => {
  test("due calls appear on the list within the daily capacity, to be worked in calling hours: the engine places them at once and shows them later today until the hours open", () => {
    const def = (channels: ("email" | "sms" | "call")[]): CampaignDefinition => ({ timezone: "UTC", callSkipLimitDays: 2, emailPool: [], tracks: channels.map((c) => newTrack(c)) });
    expect(sendsOnItsOwn(def(["call"]))).toBe("Due calls appear on your list within your daily call capacity; work them during each lead’s calling hours.");
    expect(sendsOnItsOwn(def(["email", "call"]))).toBe("Email goes out on its own, inside each lead’s sending window. Due calls appear on your list within your daily call capacity; work them during each lead’s calling hours.");
    expect(sendsOnItsOwn(def(["email", "sms"]))).toBe("Email and texts go out on their own, inside each lead’s sending window.");
  });
});

describe("a track's name inside a sentence, in the main sequence and the win-back branch (ticket 16b)", () => {
  const t = (id: string, channel: TrackDefinition["channel"], branch: TrackDefinition["branch"] = "main"): TrackDefinition => ({ id, channel, branch, window: [{ day: 1, start: 9, end: 17 }], steps: [], start: { kind: "entry" }, removed: false });
  test("SMS keeps its capitals; every other word, the branch's included, is lower case mid-sentence", () => {
    const def = { timezone: "Europe/London", callSkipLimitDays: 2, emailPool: [], smsPool: [], tracks: [t("e", "email"), t("m", "sms"), t("we", "email", "win_back"), t("wm", "sms", "win_back"), t("wm2", "sms", "win_back")] };
    const name = (id: string) => trackName(def, def.tracks.find((x) => x.id === id)!);
    expect(name("e")).toBe("the email track");
    expect(name("m")).toBe("the SMS track");
    expect(name("we")).toBe("the win-back email track");
    expect(name("wm")).toBe("win-back SMS track 1");
    expect(name("wm2")).toBe("win-back SMS track 2");
    const one = { ...def, tracks: def.tracks.filter((x) => x.id !== "wm2") };
    expect(trackName(one, one.tracks.find((x) => x.id === "wm")!)).toBe("the win-back SMS track");
  });
});
