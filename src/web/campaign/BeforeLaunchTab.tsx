import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { BeforeLaunchView, CampaignDefinition, CopyPreview, CopySegment, LoadProjectionView, PreviewLead, SmsProviderStatus } from "../../shared/api.ts";
import { stepNoun, trackLabel } from "../../shared/track-label.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { campaignPath, longDate } from "../pages/CampaignPage.tsx";
import { fieldLabel, sendsOnItsOwn, trackName, trackTitle } from "./model.ts";
import { describeBlocker } from "./blocker-wording.ts";
import { CANNOT_SEND, ConflictNotice } from "./SequenceTab.tsx";
import type { SequenceEditor } from "./useSequence.ts";
import { withheldExplanation } from "./withheld.ts";

/**
 * Before launch: the three blockers, every other condition as a warning, coverage, missing merge
 * fields, the projected daily load, and the copy rendered for one real lead at a time.
 */
export function BeforeLaunchTab({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const version = editor.view.definitionVersion;
  const { result, retry } = useApi<BeforeLaunchView>(`/api/campaigns/${encodeURIComponent(campaignId)}/before-launch?v=${version}${editor.launched ? "&launched" : ""}`);
  // Only checks for the current version are shown: while a newer version loads, the loading
  // state shows, not the older checks (PR 41 council, item 2).
  const facts = result.state === "ready" ? result.data : null;
  return (
    <div className="flex flex-col gap-4">
      <LaunchBar editor={editor} facts={facts} />
      {result.state === "error" ? (
        <ErrorState title="The checks before launch didn’t load." message={result.message} onRetry={retry} />
      ) : !facts ? (
        <div role="status" aria-busy="true" aria-label="Loading the checks before launch" className="grid grid-cols-1 gap-4 min-[1240px]:grid-cols-[minmax(0,1fr)_460px]">
          <div className="flex flex-col gap-3">
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-32 w-full" />
            <div className="skeleton h-40 w-full" />
          </div>
          <div className="skeleton h-[420px] w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 min-[1240px]:grid-cols-[minmax(0,1fr)_460px]">
          <div className="flex min-w-0 flex-col gap-6">
            <Blockers campaignId={campaignId} editor={editor} />
            <Warnings facts={facts} editor={editor} />
            <Card title="Channel coverage">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Coverage n={facts.coverage.email} of={facts.coverage.leads} what="have an email" />
                <Coverage n={facts.coverage.mobile} of={facts.coverage.leads} what="have a mobile" />
                <Coverage n={facts.coverage.phone} of={facts.coverage.leads} what="have a phone number" />
              </div>
            </Card>
            <Card title="Missing merge fields">
              <MissingFields facts={facts} />
            </Card>
            <Card title="Daily load">
              <DailyLoad facts={facts} editor={editor} />
            </Card>
          </div>
          <Preview campaignId={campaignId} editor={editor} leads={facts.leads} horizonDays={facts.load?.horizonDays ?? null} />
        </div>
      )}
    </div>
  );
}

function LaunchBar({ editor, facts }: { editor: SequenceEditor; facts: BeforeLaunchView | null }) {
  const [error, setError] = useState<string | null>(null);
  // When the focused Launch button or "Load the saved version" goes away, focus moves to this
  // line, which then says what happened (PR 41 re-check, F8).
  const said = useRef<HTMLParagraphElement>(null);
  const { launch, launchedAt } = editor.view;
  const n = launch.blockers.length;
  const failed = editor.unsaved && editor.save.kind !== "saving";
  const tone = launchedAt || (launch.nothingToLaunch && !failed) ? "bg-base-100 border-line" : n > 0 || failed ? "bg-crit-soft border-transparent" : "bg-base-100 border-line";
  const days = facts?.load?.daysUntilAllStart ?? null;
  const starting = facts?.load?.leadsToStart ?? null;
  let text: ReactNode;
  if (launchedAt) text = <><b className="font-semibold">Launched {longDate(launchedAt)}.</b> {sendsOnItsOwn(editor.view.definition)}</>;
  else if (editor.save.kind === "conflict") text = null;
  // The checks for the definition on the page are still on their way (PR 41 council, item 6).
  else if (!facts) text = <><b className="font-semibold">Checking the sequence…</b> Launch is ready once the checks have arrived.</>;
  else if (editor.unsaved && editor.save.kind !== "saving")
    text = (
      <>
        <b className="font-semibold text-crit">Your latest change isn’t saved, so launch waits.</b>{" "}
        <span className="text-ink-2">{editor.save.kind === "error" || editor.save.kind === "invalid" ? editor.save.message : ""} The checks below are for the last saved version. {editor.save.kind === "invalid" ? "Fix it in the sequence." : "Fix it in the sequence, or try again."}</span>
      </>
    );
  else if (editor.unsaved) text = <><b className="font-semibold">Saving your latest change…</b> Launch is ready once it is saved.</>;
  else if (launch.nothingToLaunch) text = <><b className="font-semibold">Nothing to launch yet.</b> Add a track in the sequence to launch.</>;
  else if (n > 0) text = <><b className="font-semibold text-crit">{n} {n === 1 ? "thing blocks" : "things block"} launch.</b> <span className="text-ink-2">Fix them here or in the sequence. The warnings below don’t block.</span></>;
  else
    text = (
      <>
        <b className="font-semibold">Ready to launch.</b>{" "}
        {starting !== null && days !== null ? `${starting} ${starting === 1 ? "lead starts" : "leads start"} within ${days} ${days === 1 ? "day" : "days"}.` : ""}
      </>
    );
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-box border px-4 py-3.5 text-[14.5px] ${tone}`}>
      <p ref={said} tabIndex={-1} className="min-w-0 flex-[1_1_360px] rounded-field outline-offset-4">
        {text}
      </p>
      {!launchedAt && !launch.nothingToLaunch && (
        <button
          type="button"
          className="btn btn-primary font-semibold"
          // Only once the checks for the definition on the page have arrived (PR 41 re-check, F7).
          disabled={!editor.launching && (!launch.canLaunch || editor.unsaved || !facts)}
          // While the launch is pending the button stays focusable, so keyboard focus never falls to the
          // page, and does nothing: it is marked disabled for assistive technology (re-check 4, F8).
          aria-disabled={editor.launching}
          onClick={() => {
            if (editor.launching) return;
            setError(null);
            editor.launch().then(
              () => said.current?.focus(),
              (e: unknown) => setError(e instanceof Error ? e.message : "Launch failed."),
            );
          }}
        >
          {editor.launching ? "Launching…" : "Launch campaign"}
        </button>
      )}
      {editor.save.kind === "conflict" && (
        <div className="w-full">
          <ConflictNotice editor={editor} onLoaded={() => said.current?.focus()} />
        </div>
      )}
      {/* Trying again cannot help a draft that cannot be saved as it stands. */}
      {failed && !launchedAt && editor.save.kind !== "conflict" && editor.save.kind !== "invalid" && (
        <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={editor.retrySave}>
          Try again
        </button>
      )}
      {error !== null && (
        <div className="w-full">
          <ErrorState title="The campaign didn’t launch." message={error} />
        </div>
      )}
    </div>
  );
}

function Blockers({ campaignId, editor }: { campaignId: string; editor: SequenceEditor }) {
  const [, navigate] = useLocation();
  const { blockers, nothingToLaunch } = editor.view.launch;
  const def = editor.view.definition;
  const sms = useApi<SmsProviderStatus>("/api/sms-provider").result;
  const open = (trackId: string, stepId?: string) => navigate(`${campaignPath(campaignId)}?track=${encodeURIComponent(trackId)}${stepId ? `&step=${encodeURIComponent(stepId)}` : ""}`);
  return (
    <section aria-labelledby="blocks-launch">
      <h3 id="blocks-launch" className="mb-2 text-[15px] font-semibold">
        Blocks launch
      </h3>
      {blockers.length === 0 ? (
        <div className="flex gap-2.5 rounded-field bg-you-soft px-3.5 py-3 text-[14px]">
          <Icon name="ok" className="mt-0.5 size-[18px] text-you" />
          <span>
            <b className="font-semibold">{nothingToLaunch ? "No track yet." : "Nothing blocks launch."}</b>
            <span className="block text-ink-2">
              {nothingToLaunch ? "With a track, launch is blocked only by empty copy, a merge field with no fallback that a lead lacks, or no connected sender." : "Every message has copy, every merge field has a fallback where a lead lacks it, and every email and SMS track has a sender."}
            </span>
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {blockers.map((b) => {
            const { title, detail, actions } = describeBlocker(b, def, sms.state === "ready" ? sms.data : null);
            return (
              <li key={JSON.stringify(b)} className="flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-field bg-crit-soft px-3.5 py-3 text-[14px]">
                <Icon name="bad" className="mt-0.5 size-[18px] text-crit" />
                <span className="min-w-0 flex-[1_1_240px] [overflow-wrap:anywhere]">
                  <b className="font-semibold">{title}</b>
                  <span className="block text-ink-2">{detail}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {actions.map((a) => (
                    <button key={`${a.trackId}/${a.stepId ?? ""}`} type="button" className="btn btn-sm h-auto min-h-7 border-line-strong bg-base-100 py-1 font-medium" onClick={() => open(a.trackId, a.stepId)}>
                      {a.label}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

function Warnings({ facts, editor }: { facts: BeforeLaunchView; editor: SequenceEditor }) {
  const items: { title: string; detail: string }[] = [];
  const live = editor.view.definition.tracks.filter((t) => !t.removed && t.branch === "main");
  const noEmail = facts.coverage.leads - facts.coverage.email;
  const noMobile = facts.coverage.leads - facts.coverage.mobile;
  const noPhone = facts.coverage.leads - facts.coverage.phone;
  const after = (channel: "email" | "sms" | "call") => live.some((t) => t.start.kind === "after" && live.find((x) => x.id === (t.start as { trackId: string }).trackId)?.channel === channel);
  // Each warning names the tracks it is about, by their own channel and order.
  const tracksOn = (channel: "email" | "sms" | "call") => and(live.filter((t) => t.channel === channel).map((t) => trackName(editor.view.definition, t)));
  if (live.some((t) => t.channel === "email") && noEmail > 0) {
    items.push({ title: `${noEmail} ${noEmail === 1 ? "lead has" : "leads have"} no email`, detail: `They skip ${tracksOn("email")}${after("email") ? ", and the tracks after it start sooner" : ""}.` });
  }
  if (live.some((t) => t.channel === "sms") && noMobile > 0) {
    items.push({ title: `${noMobile} ${noMobile === 1 ? "lead has" : "leads have"} no mobile of their own`, detail: `They skip ${tracksOn("sms")}${after("sms") ? ", and the tracks after it start sooner" : ""}. Company leads are never texted.` });
  }
  if (live.some((t) => t.channel === "call") && noPhone > 0) {
    items.push({ title: `${noPhone} ${noPhone === 1 ? "lead has" : "leads have"} no phone number`, detail: `They skip ${tracksOn("call")}${after("call") ? ", and the tracks after it start sooner" : ""}. A company’s main line counts for everyone at the company.` });
  }
  // ADR 0003 7.2: an empty call script is a warning, never a blocker.
  if (live.some((t) => t.channel === "call") && !(editor.view.definition.callScript ?? "").trim()) {
    items.push({ title: "The call script is empty", detail: "Your call tasks will show no talking points. Write them in a phone track, in the sequence." });
  }
  for (const a of facts.load?.accounts ?? []) {
    if (a.usedToday > 0) items.push({ title: `${a.label} has ${a.usedToday} of its ${a.capacity} sends a day used today`, detail: `Other campaigns sent or reserved them, so fewer first ${a.channel === "sms" ? "texts" : "emails"} can go today.` });
  }
  // A sender the win-back branch uses counts too: its emails and texts go from the same pools (ticket 16b).
  const sending = editor.view.definition.tracks.filter((t) => !t.removed);
  for (const a of editor.view.accounts.filter((x) => !x.healthy && sending.some((t) => t.channel === x.channel))) {
    items.push({ title: `${a.label} ${CANNOT_SEND}`, detail: "Its leads wait until it can send again." });
  }
  if (facts.load?.someNotStartedWithinHorizon) {
    items.push({ title: `Some leads would not start within ${facts.load.horizonDays} days`, detail: "The senders’ daily capacity is too small for this many leads, or their texts wait for a free number." });
  }
  return (
    <section aria-labelledby="warnings">
      <h3 id="warnings" className="mb-2 text-[15px] font-semibold">
        Warnings <span className="text-[12.5px] font-normal text-muted">don’t block</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-[14px] text-muted">No warnings.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((w) => (
            <li key={w.title} className="flex gap-2.5 rounded-field border border-line bg-base-100 px-3.5 py-3 text-[14px]">
              <Icon name="warn" className="mt-0.5 size-[18px] text-pause" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <b className="font-semibold">{w.title}</b>
                <span className="block text-ink-2">{w.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-box border border-line bg-base-100 px-5 pb-5 pt-4">
      <h2 id={id} className="mb-3 text-[19px]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Coverage({ n, of, what }: { n: number; of: number; what: string }) {
  return (
    <div className="rounded-field bg-raised px-3 py-2.5 text-[13.5px] text-ink-2">
      <b className="text-[19px] font-semibold text-base-content">{n}</b> <span className="text-muted">of {of}</span>
      <div>{what}</div>
    </div>
  );
}

function MissingFields({ facts }: { facts: BeforeLaunchView }) {
  if (facts.mergeFields.length === 0) return <p className="text-[14px] text-muted">The copy uses no merge fields.</p>;
  return (
    <table className="table text-[14px] max-[560px]:block">
      <thead className="max-[560px]:sr-only">
        <tr className="border-b border-line text-[13px] text-muted">
          <th className="px-0 py-2 font-medium">Merge field</th>
          <th className="py-2 font-medium">Leads without it</th>
          <th className="py-2 font-medium">What they get</th>
        </tr>
      </thead>
      <tbody className="max-[560px]:block">
        {facts.mergeFields.map((f) => {
          const blocks = f.someUseWithoutFallback && f.leadsMissing > 0;
          return (
            <tr key={f.field} className="border-line max-[560px]:flex max-[560px]:flex-wrap max-[560px]:gap-x-3 max-[560px]:py-2 [&+&]:border-t">
              <td className="px-0 py-2.5 max-[560px]:p-0">
                <span className={`rounded-[5px] px-1.5 text-[12.5px] font-semibold ${blocks ? "bg-crit-soft text-crit" : "bg-hand-soft text-hand"}`}>{fieldLabel(f.field)}</span>
              </td>
              <td className="py-2.5 max-[560px]:p-0">
                {f.leadsMissing}
                {f.companyLeadsMissing > 0 && f.companyLeadsMissing === f.leadsMissing ? ` company ${f.leadsMissing === 1 ? "lead" : "leads"}` : ""}
              </td>
              <td className="py-2.5 max-[560px]:p-0">
                {f.leadsMissing === 0 ? (
                  <span className="text-muted">Every lead has it</span>
                ) : blocks ? (
                  <span className="font-medium text-crit">{f.fallbacks.length > 0 ? `“${f.fallbacks.join("”, “")}” in some messages; one has no fallback. Blocks launch.` : "No fallback. Blocks launch."}</span>
                ) : (
                  `“${f.fallbacks.join("”, “")}”`
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DailyLoad({ facts, editor }: { facts: BeforeLaunchView; editor: SequenceEditor }) {
  const load = facts.load;
  const def = editor.view.definition;
  if (editor.launched || !load) return <p className="text-[14px] text-muted">The projection is for before launch. Once running, leads waiting for sending capacity show in Needs attention.</p>;
  if (!def.tracks.some((t) => !t.removed && t.branch === "main")) return <p className="text-[14px] text-muted">Add a track to see the load it puts on each sender.</p>;
  // No figure that could contradict the engine: a track the server names (no sender, or after a
  // call), or a sender with no known end.
  const blocked = load.withheldBy !== null || load.cannotProject.length > 0 || load.stoppedEarly !== null;
  const calls = def.tracks.some((t) => !t.removed && t.branch === "main" && t.channel === "call");
  const callRow = load.calls;
  return (
    <>
      {(load.accounts.length > 0 || callRow !== null) && (
        <table className="table text-[14px] max-[560px]:block">
          <thead className="max-[560px]:sr-only">
            <tr className="border-b border-line text-[13px] text-muted">
              <th className="px-0 py-2 font-medium">Sender</th>
              <th className="py-2 font-medium">Busiest day, this campaign</th>
              <th className="py-2 font-medium">Used today, all campaigns</th>
            </tr>
          </thead>
          <tbody className="max-[560px]:block">
            {load.accounts.map((a) => (
              <tr key={a.id} className="border-line max-[560px]:flex max-[560px]:flex-col max-[560px]:gap-1 max-[560px]:py-2 [&+&]:border-t">
                <td className="px-0 py-2.5 max-[560px]:p-0">
                  <span className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
                    <Icon name={a.channel} className="mt-0.5 size-4 text-muted" />
                    <span>
                      <span className="sr-only">{a.channel === "sms" ? "SMS number " : "Email inbox "}</span>
                      {a.label}
                      <span className="block text-[12.5px] text-muted">
                        At most one {a.channel === "sms" ? "text" : "email"} every {gap(a.gapSeconds)}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="py-2.5 max-[560px]:p-0">{blocked ? "—" : `${a.busiestDay} a day`}</td>
                <td className="py-2.5 max-[560px]:p-0">
                  <span className={a.usedToday >= a.capacity ? "font-medium text-pause" : ""}>
                    {a.usedToday} of {a.capacity}
                  </span>
                  <span className="mt-1 block h-1 w-24 overflow-hidden rounded-sm bg-line" aria-hidden="true">
                    <span className={`block h-full ${a.usedToday >= a.capacity ? "bg-pause" : "bg-base-content"}`} style={{ width: `${Math.min(100, (a.usedToday / Math.max(1, a.capacity)) * 100)}%` }} />
                  </span>
                </td>
              </tr>
            ))}
            {callRow !== null && (
              <tr className="border-line max-[560px]:flex max-[560px]:flex-col max-[560px]:gap-1 max-[560px]:py-2 [&+&]:border-t">
                <td className="px-0 py-2.5 max-[560px]:p-0">
                  <span className="flex items-start gap-1.5">
                    <Icon name="call" className="mt-0.5 size-4 text-muted" />
                    <span>
                      Your calls
                      <span className="block text-[12.5px] text-muted">At most {callRow.capacity} new calls a day on your list, across campaigns</span>
                    </span>
                  </span>
                </td>
                <td className="py-2.5 max-[560px]:p-0">{blocked || callRow.busiestDay === null ? "—" : `${callRow.busiestDay} a day`}</td>
                <td className="py-2.5 max-[560px]:p-0">
                  <span className={callRow.onListToday >= callRow.capacity ? "font-medium text-pause" : ""}>
                    {callRow.onListToday} of {callRow.capacity}
                  </span>
                  <span className="mt-1 block h-1 w-24 overflow-hidden rounded-sm bg-line" aria-hidden="true">
                    <span className={`block h-full ${callRow.onListToday >= callRow.capacity ? "bg-pause" : "bg-base-content"}`} style={{ width: `${Math.min(100, (callRow.onListToday / Math.max(1, callRow.capacity)) * 100)}%` }} />
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {load.withheldBy !== null ? (
        <p className={`${load.accounts.length > 0 || callRow !== null ? "mt-2" : ""} text-[13.5px] text-crit`}>
          {/* Worded from the tracks the server names, never guessed from this campaign's channels. */}
          {withheldExplanation(load.withheldBy)}
        </p>
      ) : load.stoppedEarly === "bound" ? (
        <p className="mt-2 text-[13.5px] text-ink-2">This campaign is too large to estimate here: working out its daily load would take too long, so no figure is shown. Nothing else on this page is affected.</p>
      ) : load.stoppedEarly === "horizon" ? (
        <p className="mt-2 text-[13.5px] text-ink-2">This campaign runs past the estimate’s {load.horizonDays} days: some of its leads, messages or calls come later than that, so no figure is shown. Nothing else on this page is affected.</p>
      ) : load.cannotProject.length > 0 ? (
        <p className="mt-2 text-[13px] text-ink-2">
          Can’t project the load while {and(load.cannotProject.map(heldSaid))}. Nothing says when that ends.
        </p>
      ) : (
        <p className="mt-2 text-[13px] text-muted">
          {load.leadsToStart === 0
            ? "No lead has a channel these tracks use yet."
            : load.daysUntilAllStart !== null
              ? `All ${load.leadsToStart} leads start within ${load.daysUntilAllStart} ${load.daysUntilAllStart === 1 ? "day" : "days"} of launch.`
              : ""}{" "}
          {calls ? "A lead starts with its first email or text, or when its first call goes on your list. " : ""}
          {/* The server's word, from the finished run (ticket 16a): its win-back branch is never entered under the assumption. */}
          {load.winBackNotCounted
            ? "Every email and text of the main sequence counts: tracks that start together and tracks that wait for another. This campaign’s win-back emails and texts are not counted: the figures assume every call gets no answer, so nobody enters win-back."
            : "Every email and text counts: tracks that start together and tracks that wait for another."}{" "}
          {callCaveat(calls, load.callsNotCounted)} Follow-ups always go before first messages when a sender is full. What other running campaigns have waiting on these senders is counted; every send is assumed to succeed, and replies, bounces, bad numbers and pauses are not foreseen.
        </p>
      )}
    </>
  );
}

/** Why one sender keeps the figure from being projected (ADR 0003, ticket 13b): said with the sender. */
function heldSaid(c: LoadProjectionView["cannotProject"][number]): string {
  switch (c.reason) {
    case "quota":
      return `${c.label} waits for Instantly’s lead quota`;
    case "cannot_send":
      return `${c.label} ${CANNOT_SEND}`;
    case "unsettled_work":
      return `some of ${c.label}’s sends are held by work only the provider or you can settle (Needs attention lists it)`;
    case "reply_being_matched":
      return `a reply to ${c.label} is being matched to its lead, which may stop that lead`;
  }
}

/**
 * What the estimate assumes about the user's calls, here and in the campaigns sharing these senders
 * or the call list (ADR 0003, ticket 14c; review bot on 5cd8a93): every call on the list is worked on
 * its day and gets no answer. The engine's own rules then finish its phone track, start the tracks
 * after it, and put that lead's later messages and calls first. Any other outcome changes it, as a
 * reply would.
 */
function callCaveat(here: boolean, elsewhere: readonly { readonly name: string }[]): string {
  if (!here && elsewhere.length === 0) return "";
  const where = and([...(here ? ["this campaign"] : []), ...elsewhere.map((c) => c.name)]);
  return `For calls in ${where}, it assumes you log every call on your list at the end of the day it is there, after its calling hours, and that each one gets no answer: its phone track then finishes, the tracks after it start from then, and that lead’s later messages and calls go first. A call logged earlier in the day can bring the messages after it forward and change the order of that day’s sends; another outcome changes the estimate too, as a reply would. `;
}

const gap = (seconds: number) => (seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`);

function Preview({ campaignId, editor, leads, horizonDays }: { campaignId: string; editor: SequenceEditor; leads: readonly PreviewLead[]; horizonDays: number | null }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const index = Math.max(0, leads.findIndex((l) => l.id === chosen));
  const lead = leads[index];
  const def = editor.view.definition;
  const live = def.tracks.filter((t) => !t.removed && t.branch === "main");
  const selectId = useId();
  const reach = (l: PreviewLead) => {
    const parts: string[] = [];
    if (live.some((t) => t.channel === "email")) parts.push(l.email ? `Email to ${l.email}.` : "No email, so the email track is skipped for them.");
    if (live.some((t) => t.channel === "sms")) parts.push(l.mobile ? "Texts to their own mobile." : l.kind === "company" ? "A company lead is never texted, so the SMS track is skipped." : "No mobile of their own, so the SMS track is skipped for them.");
    if (live.some((t) => t.channel === "call")) parts.push(l.phone ? "Calls on your list, to a number of theirs or their company’s main line." : `No phone number, so ${live.filter((t) => t.channel === "call").length > 1 ? "the phone tracks are" : "the phone track is"} skipped for them.`);
    return parts.join(" ");
  };
  return (
    <section aria-labelledby="copy-for-a-lead" className="flex min-w-0 flex-col gap-3.5 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4 min-[1240px]:sticky min-[1240px]:top-4">
      <h2 id="copy-for-a-lead" className="text-[19px]">
        Copy for a lead
      </h2>
      {leads.length === 0 ? (
        <p className="text-[14px] text-ink-2">
          No leads yet. <Link href={`/campaigns/${campaignId}/import`} className="underline">Import a scraper run</Link> to preview the copy for a real lead.
        </p>
      ) : live.length === 0 ? (
        <p className="text-[14px] text-ink-2">Add a track to preview its copy.</p>
      ) : lead ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={selectId} className="sr-only">
              Preview as lead
            </label>
            <select id={selectId} className="select min-w-0 flex-[1_1_200px] border-line-strong" value={lead.id} onChange={(e) => setChosen(e.target.value)}>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.kind === "company" ? " (company lead)" : ""}
                </option>
              ))}
            </select>
            <span className="flex gap-1">
              <button type="button" className="btn btn-sm border-line-strong bg-base-100 px-2" aria-label="Previous lead" disabled={index === 0} onClick={() => setChosen(leads[index - 1]?.id ?? null)}>
                <Icon name="back" className="size-4" />
              </button>
              <button type="button" className="btn btn-sm border-line-strong bg-base-100 px-2" aria-label="Next lead" disabled={index === leads.length - 1} onClick={() => setChosen(leads[index + 1]?.id ?? null)}>
                <Icon name="forward" className="size-4" />
              </button>
            </span>
            <span className="text-[13px] text-muted" aria-live="polite">
              Lead {index + 1} of {leads.length}
            </span>
          </div>
          <p className="-mt-1 text-[13px] text-muted [overflow-wrap:anywhere]">
            {lead.kind === "company" ? "Company lead" : `${lead.title ? `${lead.title}, ` : ""}${lead.company}`}. {reach(lead)}
          </p>
          <p className="text-[12.5px] text-muted">
            <mark className="bg-transparent text-inherit underline decoration-hand decoration-dotted decoration-2 underline-offset-[3px]">dotted</mark> fallback text, because this lead lacks the field. Each day is the day the estimate below sends the message, counted from launch day, day 1; a message the estimate does not reach shows no day, and says why.
          </p>
          <LeadCopy campaignId={campaignId} enrollmentId={lead.id} version={editor.view.definitionVersion} def={def} horizonDays={horizonDays} />
        </>
      ) : null}
    </section>
  );
}

/** When a message goes, as Copy for a lead heads it: the estimate's day, or why it has none. One source for every day shown. */
function whenSent(s: CopyPreview["steps"][number], horizonDays: number | null, entry: CopyPreview["winBackEntry"] = "declined_path"): string {
  if (s.day !== null) return s.waitsOnCall ? `Day ${s.day}, after ${s.waitsOnCall}’s call` : `Day ${s.day}`;
  switch (s.noDay) {
    case "skipped":
      return "Skipped";
    case "beyond_horizon":
      return horizonDays === null ? "After the estimate ends" : `After the estimate’s ${horizonDays} days`;
    case "not_sent":
      return "Not sent";
    case "win_back":
      // How a lead can enter the branch, from the server's read (`winBackEntry`; council on aaf82b7).
      return entry === "chosen_for_a_lead" ? "Only if chosen for them" : entry === "never" ? "Never sent" : "Only if they decline";
    default:
      return "No day: no estimate";
  }
}

function LeadCopy({ campaignId, enrollmentId, version, def, horizonDays }: { campaignId: string; enrollmentId: string; version: number; def: CampaignDefinition; horizonDays: number | null }) {
  const { result, retry } = useApi<CopyPreview>(`/api/campaigns/${encodeURIComponent(campaignId)}/preview/${encodeURIComponent(enrollmentId)}?v=${version}`);
  if (result.state === "error") return <ErrorState title="This lead’s copy didn’t load." message={result.message} onRetry={retry} />;
  // Only copy for this lead and this version: never the previous lead's copy under this name.
  const preview = result.state === "ready" && result.data.lead.id === enrollmentId ? result.data : null;
  if (!preview)
    return (
      <div role="status" aria-busy="true" aria-label="Loading the copy" className="flex flex-col gap-2">
        <div className="skeleton h-40 w-full" />
      </div>
    );
  const several = def.tracks.filter((t) => !t.removed && t.branch === "main").length > 1;
  return (
    <>
      <ol className="flex flex-col gap-3" aria-label="The messages, in the order they can go">
        {preview.steps.map((s) => (
          <PreviewMessage key={s.stepId} s={s} def={def} named={several} horizonDays={horizonDays} />
        ))}
      </ol>
      {/* The win-back branch (ticket 16b), from the server's read: only for a lead who declines on a call, so undated. */}
      {preview.winBack.length > 0 && (
        <section aria-labelledby="win-back-copy" className="flex flex-col gap-2.5">
          <h3 id="win-back-copy" className="text-[15px] font-semibold">
            If they decline: the win-back branch
          </h3>
          <p className="-mt-1 text-[13px] text-muted">{WIN_BACK_ENTRY[preview.winBackEntry]}</p>
          <ol className="flex flex-col gap-3" aria-label="The win-back branch’s messages">
            {preview.winBack.map((s) => (
              <PreviewMessage key={s.stepId} s={s} def={def} named={trackLabel(def, { id: s.trackId, channel: s.channel }).several} horizonDays={horizonDays} entry={preview.winBackEntry} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/** How a lead can enter the win-back branch, as the server reads it (`winBackEntry`; council on aaf82b7): one sentence above its messages. */
const WIN_BACK_ENTRY: Record<CopyPreview["winBackEntry"], string> = {
  declined_path: "These go only if this lead declines on a call and moves to the branch, which the estimate never assumes, so none has a day.",
  chosen_for_a_lead: "No phone track’s declined path is win back, so these go only if win back is chosen for this lead when their declined call is logged. None has a day.",
  never: "The campaign has no phone track to decline on, so no lead can enter the win-back branch: these are never sent.",
};

/** One message of Copy for a lead: its heading with the day it goes, or why it has none, and its copy rendered for the lead. */
function PreviewMessage({ s, def, named, horizonDays, entry }: { s: CopyPreview["steps"][number]; def: CampaignDefinition; named: boolean; horizonDays: number | null; entry?: CopyPreview["winBackEntry"] }) {
  const track = def.tracks.find((t) => t.id === s.trackId);
  const sms = s.channel === "sms";
  // A step of the win-back branch is named for it, as the shared label says (ticket 16c): "Win-back email 1".
  const noun = `${stepNoun(trackLabel(def, { id: s.trackId, channel: s.channel }), sms ? "sms" : "email")} ${s.number}`;
  return (
    <li className="overflow-hidden rounded-field border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-raised px-3.5 py-2 text-[13px]">
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">
          <Icon name={sms ? "sms" : "email"} className="size-4 flex-none text-muted" />
          <span className="[overflow-wrap:anywhere]">
            {noun}
            {named && track ? <span className="font-normal text-muted"> · {trackTitle(def, track)}</span> : null}
          </span>
        </span>
        <span className="whitespace-nowrap text-muted">{whenSent(s, horizonDays, entry)}</span>
      </div>
      <div className="px-3.5 py-3 text-[14px] leading-[1.55]">
        {s.skipped ? (
          <p className="text-muted">{sms ? "Skipped: this lead has no mobile of their own to text." : "Skipped: this lead has no email."}</p>
        ) : (
          <>
            {!sms && (
              <p className="mb-2 font-semibold [overflow-wrap:anywhere]">
                <Segments segments={s.subject} empty="No subject yet" />
              </p>
            )}
            <p className={`whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere] ${sms ? "w-fit max-w-[42ch] rounded-[14px_14px_14px_4px] bg-raised px-3 py-2 shadow-[inset_0_0_0_1px_var(--color-line)]" : ""}`}>
              <Segments segments={s.body} empty={`No copy yet. Launch is blocked until this ${sms ? "text" : "email"} has copy.`} />
            </p>
            {s.missing.length > 0 && (
              <p className="mt-2 text-[13px] font-medium text-crit">
                This lead has no {s.missing.map(fieldLabel).join(" or ")} and the field has no fallback, so this {sms ? "text" : "email"} can’t be sent to them.
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function Segments({ segments, empty }: { segments: readonly CopySegment[]; empty: string }) {
  if (segments.every((s) => s.kind === "literal" && s.text.trim() === "")) return <span className="font-normal text-muted">{empty}</span>;
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "fallback" ? (
          <mark key={i} title={`Fallback: this lead has no ${fieldLabel(s.field ?? "")}`} className="bg-transparent text-inherit underline decoration-hand decoration-dotted decoration-2 underline-offset-[3px]">
            {s.text}
          </mark>
        ) : s.kind === "missing" ? (
          <mark key={i} className="rounded-[4px] bg-crit-soft px-1 text-crit">
            no {fieldLabel(s.field ?? "")}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
