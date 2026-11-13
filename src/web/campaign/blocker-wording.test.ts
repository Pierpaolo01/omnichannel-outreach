import { describe, expect, test } from "vitest";
import { launchCheck } from "../../domain/sequence/blockers.ts";
import type { CampaignDefinition, TrackDefinition } from "../../shared/api.ts";
import { describeBlocker } from "./blocker-wording.ts";

/** Every launch blocker names its track and channel from the fact the server sends (ticket 13b, verifier B2). */
const week = [{ day: 1, start: 9, end: 17 }];
const track = (id: string, channel: "email" | "sms", body: string, subject = ""): TrackDefinition => ({
  id,
  channel,
  branch: "main",
  window: week,
  start: { kind: "entry" },
  removed: false,
  steps: [{ id: `${id}-1`, waitDays: 0, subject: channel === "email" ? subject : "", body, threading: "new_subject", removed: false }],
});
const def = (tracks: TrackDefinition[], pools: { email?: string[]; sms?: string[] } = {}): CampaignDefinition => ({ timezone: "Europe/London", callSkipLimitDays: 2, emailPool: pools.email ?? ["inbox-a"], smsPool: pools.sms ?? ["+447700900001"], tracks });
const senders = [
  { id: "inbox-a", channel: "email" as const, healthy: true },
  { id: "+447700900001", channel: "sms" as const, healthy: true },
];
const said = (d: CampaignDefinition, leads = [{}]) => launchCheck(d, leads, senders).blockers.map((b) => describeBlocker(b, d));

describe("each blocker kind names its track and channel", () => {
  test("empty copy: on an email track, an SMS track, and a second track of one channel", () => {
    expect(said(def([track("e", "email", "", "Hi")])).map((w) => w.title)).toEqual(["The email track: Email 1 has no copy"]);
    expect(said(def([track("m", "sms", "")])).map((w) => w.title)).toEqual(["The SMS track: Text 1 has no message"]);
    expect(said(def([track("m1", "sms", "Hi."), track("m2", "sms", "")])).map((w) => w.title)).toEqual(["SMS track 2: Text 1 has no message"]);
    expect(said(def([track("m", "sms", "")]))[0]!.actions).toEqual([{ label: "Write it", trackId: "m", stepId: "m-1" }]);
  });

  test("a merge field with no fallback: each message that uses it, with an action that opens it", () => {
    const email = said(def([track("e", "email", "Hi {{first_name}}.", "Hi")]));
    expect(email.map((w) => w.title)).toEqual(["First name has no fallback in Email 1 of the email track"]);
    const sms = said(def([track("m", "sms", "Hi {{first_name}}.")]));
    expect(sms.map((w) => w.title)).toEqual(["First name has no fallback in Text 1 of the SMS track"]);
    expect(sms[0]!.actions).toEqual([{ label: "Add fallback", trackId: "m", stepId: "m-1" }]);
    const second = said(def([track("m1", "sms", "Hi {{first_name|there}}."), track("m2", "sms", "Hi {{first_name}}.")]));
    expect(second.map((w) => w.title)).toEqual(["First name has no fallback in Text 1 of SMS track 2"]);
    const both = said(def([track("e", "email", "Hi {{first_name}}.", "Hi"), track("m", "sms", "Hi {{first_name}}.")]));
    expect(both.map((w) => w.title)).toEqual(["First name has no fallback in Email 1 of the email track and Text 1 of the SMS track"]);
    expect(both[0]!.actions.map((a) => a.label)).toEqual(["Add fallback: Email 1 of the email track", "Add fallback: Text 1 of the SMS track"]);
  });

  test("no connected sender: on an email track, an SMS track, and a second track of one channel", () => {
    expect(said(def([track("e", "email", "Hi.", "Hi")], { email: [] })).map((w) => w.title)).toEqual(["The email track has no connected sender inbox"]);
    expect(said(def([track("m", "sms", "Hi.")], { sms: [] })).map((w) => w.title)).toEqual(["The SMS track has no connected sender number"]);
    expect(said(def([track("e1", "email", "Hi.", "Hi"), track("e2", "email", "Hi.", "Hi")], { email: [] })).map((w) => w.title)).toEqual([
      "Email track 1 has no connected sender inbox",
      "Email track 2 has no connected sender inbox",
    ]);
  });
});
