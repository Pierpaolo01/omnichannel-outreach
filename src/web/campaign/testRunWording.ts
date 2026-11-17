import { isMessageRequestChannel, isSocialChannel, MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type SocialChannel } from "../../domain/social-channels.ts";
import type { TestRunEnding, TestRunRead, TestStepRow } from "../../shared/api.ts";
import { clockTime } from "../time.ts";
import { stepWaitWords } from "../controls/wording.ts";

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
import { conversationTaken } from "./sms-wording.ts";
import { expiryLine } from "./linkedin-wording.ts";
import { dateIn, holdReasonClause } from "../calls/wording.ts";

/**
 * The Test run tab's words (ticket 21), from the read only: what each step's stored facts say, never more. Email has no
 * delivery receipt, so a sent email says "Sent"; nothing here claims inbox placement.
 */

/** HH:MM in `zone`, with the weekday when it is not the read's own day. */
export function timeIn(zone: string, iso: string, readAt: string): string {
  const day = (t: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const clock = clockTime(zone, iso);
  if (day(iso) === day(readAt)) return clock;
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short" }).format(new Date(iso))} ${clock}`;
}

type RunFacts = Pick<TestRunRead, "steps"> & Partial<Pick<TestRunRead, "stopReply">>;

/** The main sequence's steps, and the branch's once entered: the steps a finished run could have sent. */
function reachable(run: RunFacts): TestStepRow[] {
  const entered = run.steps.some((s) => s.branch === "win_back" && s.state !== "not_reached");
  return run.steps.filter((s) => s.branch === "main" || entered);
}
const went = (s: TestStepRow) => s.state === "sent" || s.state === "logged";

/** How a run ended, as the panel heads it; a finished run says "every step ran" only when its facts say so (council on ffa202c, item 13). */
export function endingTitle(ending: TestRunEnding, run: RunFacts | null): string {
  switch (ending) {
    case "your_reply":
      return "Stopped by your reply";
    case "finished":
      return run !== null && reachable(run).every(went) ? "Finished: every step ran" : "Finished";
    case "no_contact_left":
      return "Finished: no test contact left to reach";
    case "interested":
      return "Ended: you logged Interested on the test call";
    case "declined":
      return "Ended: you logged Not interested, and the path stops";
    case "stopped":
      return "Stopped";
    case "edited":
      return "Stopped by an edit";
    default:
      throw new Error(`an ending the tab does not know: ${String(ending satisfies never)}`);
  }
}

/** What the run's end means, under its title. */
export function endingDetail(ending: TestRunEnding, run: RunFacts): string {
  switch (ending) {
    case "your_reply":
      // Said from the stored channel of the reply that stopped it (ticket 25): a social one is the user's own mark.
      return isSocialChannel(run.stopReply)
        ? `The reply you marked on ${SOCIAL_CHANNELS[run.stopReply].name} stopped it, as a prospect’s reply stops their outreach.`
        : run.stopReply === "email" || run.stopReply === "sms"
          ? `A reply from your test ${run.stopReply === "email" ? "email" : "mobile"} stopped it, as a prospect’s reply stops their outreach.`
          : `A reply from your test email or mobile, or one you marked on ${SOCIAL_CHANNEL_LIST.map((c) => SOCIAL_CHANNELS[c].name).join(" or ")}, stopped it, as a prospect’s reply stops their outreach.`;
    case "finished":
      return finishedDetail(run);
    case "no_contact_left":
      return "No channel of the sequence could reach your test contacts any more.";
    case "interested":
      return "Interested ends a lead’s outreach in the campaign, so it ended this test.";
    case "declined":
      return "The phone track’s declined path is Stop, so the test ended there.";
    case "stopped":
      return "You stopped it. Nothing more goes to your test contacts.";
    case "edited":
      return "The sequence was edited while it ran, so it no longer tested the current version. Run it again.";
    default:
      throw new Error(`an ending the tab does not know: ${String(ending satisfies never)}`);
  }
}

/** The failure reasons a step's result can carry (the engine's words), each said for itself (council on dee365d, item 13). */
const FAILURE_REASONS = ["invalid address", "invalid number", "profile unreachable", "not connected", "account unreachable", "not allowed"] as const;
type FailureReason = (typeof FAILURE_REASONS)[number];
const isFailureReason = (r: string | null): r is FailureReason => (FAILURE_REASONS as readonly (string | null)[]).includes(r);

/** Why a step failed, from its own reason through one exhaustive switch; with none known, by its channel as before. */
export function failureWords(row: Pick<TestStepRow, "channel" | "reason">): string {
  if (!isFailureReason(row.reason)) return row.channel === "sms" ? "number not reachable" : row.channel === "linkedin" ? "profile not reachable" : isMessageRequestChannel(row.channel) ? "account not reachable" : "bounced";
  switch (row.reason) {
    case "invalid address":
      return "bounced";
    case "invalid number":
      return "number not reachable";
    case "profile unreachable":
      return "profile not reachable";
    // Q37's interim: the connection is gone, and the profile is still the person's; it is not marked wrong.
    case "not connected":
      return "no longer connected on LinkedIn, so the message couldn’t go";
    // A message-request channel's two refusals (ADR 0004 13.3, Q44), in the step's own channel's name.
    case "account unreachable":
      return "account not reachable";
    case "not allowed":
      return `${isSocialChannel(row.channel) ? SOCIAL_CHANNELS[row.channel].name : "The platform"} didn’t allow the message; the account isn’t marked wrong`;
    default: {
      const unhandled: never = row.reason;
      throw new Error(`A failure reason with no words: ${String(unhandled)}`);
    }
  }
}

/** The step's state on the right of its row. `soon`: a due step whose time is at most two minutes from the read. */
export function stepStateText(row: TestStepRow, zone: string, readAt: string): string {
  const at = row.at === null ? "" : timeIn(zone, row.at, readAt);
  switch (row.state) {
    case "sent":
      return `Sent ${at}`;
    case "failed":
      return `Failed ${at}: ${failureWords(row)}`;
    case "skipped":
      return "Skipped";
    case "with_provider":
      return row.channel === "sms" ? "With the SMS provider" : isSocialChannel(row.channel) ? `With the ${SOCIAL_CHANNELS[row.channel].name} session` : "With Instantly";
    case "held":
      return "On hold";
    case "due": {
      // A test's first message waits for the user to accept the invite by hand (ADR 0004 section 8, Q40): the day the wait
      // ends is the read's fact, never when the message goes.
      if (row.at === null && row.waits === "awaiting_acceptance")
        return `Waiting for you to accept the invite on your test profile${row.until !== undefined ? `; the wait ends ${dateIn(zone, row.until)}` : ""}`;
      // No time the engine can promise: the read's reason, in the one wording function (ADR 0003 "Reads that say when").
      if (row.at === null && row.waits !== null) return capitalise(stepWaitWords(row.waits, row.channel));
      const ms = row.at === null ? Infinity : Date.parse(row.at) - Date.parse(readAt);
      // Its time has come and nothing of its own holds it: ready, in line for its sender, never "now" (ADR 0003).
      if (ms <= 0) return "Ready to send, in line for its sender";
      // The earliest it can go, never a promise (verifier on 178de98, item 9).
      return ms <= 2 * 60_000 ? "Earliest in about 1 min" : `Earliest ${at}`;
    }
    case "on_your_list":
      return "On your Calls list";
    case "listed_later":
      return row.at === null ? "Not on your list" : `On your list from ${new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(new Date(row.at))}`;
    case "logged":
      return `Logged ${at}: ${outcomeWord(row.outcome)}`;
    case "not_reached":
      return "";
    default:
      throw new Error(`a step state the tab does not know: ${String(row.state satisfies never)}`);
  }
}

const OUTCOMES: Readonly<Record<string, string>> = {
  no_answer: "No answer",
  voicemail: "Voicemail",
  gatekeeper: "Gatekeeper",
  wrong_number: "Wrong number",
  interested: "Interested",
  not_interested: "Not interested",
  callback_requested: "Callback requested",
};
const outcomeWord = (outcome: string | null): string => (outcome === null ? "" : (OUTCOMES[outcome] ?? outcome));

/** The line under a step's name: where it goes, or why it waits. */
export function stepDetail(row: TestStepRow, run: Pick<TestRunRead, "email" | "mobile" | "running"> & Partial<Pick<TestRunRead, "linkedin" | "linkedinTracks" | "social">>): string {
  if (row.state === "not_reached") {
    if (!run.running) return "Not reached";
    if (row.branch === "win_back") return "Runs if you log Not interested and the path is Win back";
    return row.channel === "call" ? "A test call goes on your Calls list when it is due" : "Waits for the steps before it";
  }
  if (row.state === "skipped" && row.reason === "sms_conversation_taken") return `Skipped: ${conversationTaken(row.owners ?? [], row.channel, "your test")}`;
  // An acceptance wait that ran out: said from the run's own withdrawal state, through the record's function (item 2).
  if (row.state === "skipped" && row.reason === "invite_not_accepted") {
    const view = run.linkedinTracks?.find((t) => t.trackId === row.trackId)?.view;
    const said = expiryLine(view?.withdrawal ?? null, "this test", view ?? { withdrawalAsked: false, withdrawalStuck: false });
    return `Skipped: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  if (row.state === "skipped") return row.reason === "missing_channel" ? `Skipped: no test ${row.channel === "email" ? "email" : isSocialChannel(row.channel) ? `${SOCIAL_CHANNELS[row.channel].name} ${SOCIAL_CHANNELS[row.channel].addressNoun}` : "mobile"} saved` : SKIPPED_BECAUSE[row.reason ?? ""] ?? "Skipped";
  if (row.channel === "call") return row.state === "on_your_list" ? "Log any outcome to continue. The canvas paths apply." : `To ${run.mobile ?? "your mobile"}`;
  if (row.state === "held") return `On hold because ${row.hold ? holdReasonClause(row.hold, row.holdOwners ?? [], row.channel) : "something waits on you"}. Nothing is dropped.`;
  if (row.state === "due" && row.waits === "awaiting_acceptance") return "Accept it by hand on your test profile. A test doesn’t shorten the wait for acceptance; the messages after it wait about a minute each.";
  if (row.state === "due") return "The wait is cut to about a minute";
  // Where it went, by its own channel's stored contact (ticket 25): never another channel's.
  const to = row.channel === "email" ? run.email : row.channel === "sms" ? run.mobile : row.channel === "linkedin" ? (run.linkedin ?? null) : isMessageRequestChannel(row.channel) ? (run.social?.[row.channel] ?? null) : null;
  return `To ${to ?? ""}`;
}

/** "4 of 8 steps done": steps with a result (sent, failed, skipped or logged) of the steps the run can reach in the main sequence and any branch it entered. */
export function progressText(run: TestRunRead): string {
  const done = run.steps.filter((s) => s.state === "sent" || s.state === "failed" || s.state === "skipped" || s.state === "logged").length;
  const entered = run.steps.some((s) => s.branch === "win_back" && s.state !== "not_reached");
  const total = run.steps.filter((s) => s.branch === "main" || entered).length;
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} done`;
}

/** A finished run, from its steps: how many went, and which were skipped for want of a test contact. */
function finishedDetail(run: RunFacts): string {
  const steps = reachable(run);
  const sent = steps.filter(went).length;
  if (sent === steps.length) return "Every step of the sequence went to your test contacts.";
  const missing = (contact: "email" | "mobile" | SocialChannel) =>
    steps.filter((s) => s.state === "skipped" && s.reason === "missing_channel" && (contact === "email" ? s.channel === "email" : contact === "mobile" ? s.channel === "sms" || s.channel === "call" : s.channel === contact));
  const parts: string[] = [`${sent} of ${steps.length} ${steps.length === 1 ? "step" : "steps"} went to your test contacts.`];
  const noMobile = missing("mobile");
  if (noMobile.length > 0) {
    const texts = noMobile.some((s) => s.channel === "sms");
    const calls = noMobile.filter((s) => s.channel === "call").length;
    const what = [texts ? "the texts" : null, calls === 1 ? "the call" : calls > 1 ? "the calls" : null].filter((x): x is string => x !== null).join(" and ");
    parts.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} ${noMobile.length === 1 ? "was" : "were"} skipped: no test mobile was saved.`);
  }
  if (missing("linkedin").length > 0) parts.push(`The LinkedIn ${missing("linkedin").length === 1 ? "step was" : "steps were"} skipped: no test LinkedIn profile was saved.`);
  for (const c of MESSAGE_REQUEST_CHANNELS) {
    const n = missing(c).length;
    if (n > 0) parts.push(`The ${SOCIAL_CHANNELS[c].name} ${n === 1 ? "message was" : "messages were"} skipped: no test ${SOCIAL_CHANNELS[c].name} account was saved.`);
  }
  if (missing("email").length > 0) parts.push(`The ${missing("email").length === 1 ? "email was" : "emails were"} skipped: no test email was saved.`);
  const other = steps.filter((s) => !went(s) && !(s.state === "skipped" && s.reason === "missing_channel")).length;
  if (other > 0) parts.push(`${other} ${other === 1 ? "other step did" : "other steps did"} not go: each says why below.`);
  return parts.join(" ");
}

/** Why a step was skipped, other than a missing test contact (`TestStepRow.reason`). */
const SKIPPED_BECAUSE: Readonly<Record<string, string>> = {
  bad_destination: "Skipped: the test contact was marked wrong",
  declined: "Skipped: you logged Not interested",
  skipped_by_you: "Skipped by you",
  unworked: "Skipped: the call was not worked in time",
  win_back: "Skipped: the test moved to the win-back branch",
  interested: "Skipped: you logged Interested",
  // LinkedIn (ticket 24b): the invite skipped for an existing connection; a step its track left when the wait ran out.
  already_connected: "Skipped: your session is already connected to your test profile",

};
