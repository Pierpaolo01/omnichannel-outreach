import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { BeforeLaunchView, CampaignDefinition, CopyPreview, CopySegment, LaunchBlocker, PreviewLead } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { campaignPath, longDate } from "../pages/CampaignPage.tsx";
import { emailTrackOf, fieldLabel, STEP_NOUN, stepUsing, trackName } from "./model.ts";
import { CANNOT_SEND, ConflictNotice } from "./SequenceTab.tsx";
import type { SequenceEditor } from "./useSequence.ts";

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
          <Preview campaignId={campaignId} editor={editor} leads={facts.leads} />
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
  const withEmail = facts?.load?.leadsWithEmail ?? null;
  let text: ReactNode;
  if (launchedAt) text = <><b className="font-semibold">Launched {longDate(launchedAt)}.</b> Email goes out on its own, inside each lead’s sending window.</>;
  else if (editor.save.kind === "conflict") text = null;
  // The checks for the definition on the page are still on their way (PR 41 council, item 6).
  else if (!facts) text = <><b className="font-semibold">Checking the sequence…</b> Launch is ready once the checks have arrived.</>;
  else if (editor.unsaved && editor.save.kind !== "saving")
    text = (
      <>
        <b className="font-semibold text-crit">Your latest change isn’t saved, so launch waits.</b>{" "}
        <span className="text-ink-2">{editor.save.kind === "error" ? editor.save.message : ""} The checks below are for the last saved version. Fix it in the sequence, or try again.</span>
      </>
    );
  else if (editor.unsaved) text = <><b className="font-semibold">Saving your latest change…</b> Launch is ready once it is saved.</>;
  else if (launch.nothingToLaunch) text = <><b className="font-semibold">Nothing to launch yet.</b> Add a track in the sequence to launch.</>;
  else if (n > 0) text = <><b className="font-semibold text-crit">{n} {n === 1 ? "thing blocks" : "things block"} launch.</b> <span className="text-ink-2">Fix them here or in the sequence. The warnings below don’t block.</span></>;
  else
    text = (
      <>
        <b className="font-semibold">Ready to launch.</b>{" "}
        {withEmail !== null && days !== null ? `${withEmail} ${withEmail === 1 ? "lead starts" : "leads start"} within ${days} ${days === 1 ? "day" : "days"}.` : ""}
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
      {failed && !launchedAt && editor.save.kind !== "conflict" && (
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
  const track = emailTrackOf(editor.view.definition);
  const open = (stepId?: string) => navigate(`${campaignPath(campaignId)}${track ? `?track=${encodeURIComponent(track.id)}${stepId ? `&step=${encodeURIComponent(stepId)}` : ""}` : ""}`);
  const firstUsing = (field: string) => (track ? stepUsing(track, field)?.id : undefined);
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
              {nothingToLaunch ? "With a track, launch is blocked only by empty copy, a merge field with no fallback that a lead lacks, or no connected sender." : "Every email has copy, every merge field has a fallback where a lead lacks it, and the track has a sender."}
            </span>
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {blockers.map((b) => {
            const { title, detail, action, stepId } = describeBlocker(b, firstUsing, editor.view.definition, track?.id ?? null);
            return (
              <li key={JSON.stringify(b)} className="flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-field bg-crit-soft px-3.5 py-3 text-[14px]">
                <Icon name="bad" className="mt-0.5 size-[18px] text-crit" />
                <span className="min-w-0 flex-[1_1_240px]">
                  <b className="font-semibold">{title}</b>
                  <span className="block text-ink-2">{detail}</span>
                </span>
                {action !== null && (
                  <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => open(stepId)}>
                    {action}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What a blocker says, and where it is fixed. A blocker is named by the track it belongs to, by
 * that track's own channel (email, SMS, phone), never by its position. This editor opens one email
 * track (`emailTrackOf`). A blocker on any other track says which track it is and that it cannot be
 * edited here yet, with nothing to open: a campaign can have such tracks since ticket 13a, defined
 * outside this editor.
 */
function describeBlocker(b: LaunchBlocker, firstUsing: (field: string) => string | undefined, def: CampaignDefinition, editableId: string | null): { title: string; detail: ReactNode; action: string | null; stepId?: string } {
  if (b.kind === "missing_merge_field") {
    const stepId = firstUsing(b.field);
    return {
      title: `${capitalise(fieldLabel(b.field))} has no fallback`,
      detail: `${b.leadsMissing} ${b.leadsMissing === 1 ? "lead has" : "leads have"} no ${fieldLabel(b.field)}. Add a fallback or remove the field.${stepId ? "" : " It is used only in a track this editor can’t open yet."}`,
      action: stepId ? "Add fallback" : null,
      ...(stepId ? { stepId } : {}),
    };
  }
  const track = def.tracks.find((t) => t.id === b.trackId);
  const channel = track?.channel ?? (b.kind === "no_sender" && (b.channel === "sms" || b.channel === "call") ? b.channel : "email");
  const editable = b.trackId === editableId;
  const name = track ? capitalise(trackName(def, track)) : "A track";
  const several = track !== undefined && def.tracks.filter((t) => !t.removed && t.channel === channel).length > 1;
  const cannot = channel === "email" ? `This editor opens one email track, so ${name} can’t be edited here yet.` : `Editing ${channel === "sms" ? "SMS" : "phone"} tracks arrives with a later release.`;
  if (b.kind === "empty_copy") {
    const noun = `${STEP_NOUN[channel]} ${b.stepNumber}`;
    const what = b.part === "subject" ? `${noun} has no subject` : `${noun} has no ${channel === "email" ? "copy" : "message"}`;
    if (!editable) return { title: `${name}: ${what}`, detail: cannot, action: null };
    return {
      title: several ? `${name}: ${what}` : what,
      detail: b.part === "subject" ? "Give it a subject, or let it continue the thread." : "Write it, or remove the email.",
      action: "Write it",
      stepId: b.stepId,
    };
  }
  const sender = channel === "email" ? "inbox" : "number";
  const title = `${name} has no connected sender ${sender}`;
  if (!editable) return { title, detail: `It can’t send until ${channel === "email" ? "an inbox" : "a number"} is connected. ${cannot}`, action: null };
  return { title, detail: "It can’t send until an inbox is connected.", action: "Open track" };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Warnings({ facts, editor }: { facts: BeforeLaunchView; editor: SequenceEditor }) {
  const items: { title: string; detail: string }[] = [];
  const noEmail = facts.coverage.leads - facts.coverage.email;
  if (emailTrackOf(editor.view.definition) && noEmail > 0) {
    items.push({ title: `${noEmail} ${noEmail === 1 ? "lead has" : "leads have"} no email`, detail: "They skip the email track." });
  }
  for (const a of facts.load?.accounts ?? []) {
    if (a.usedToday > 0) items.push({ title: `${a.label} has ${a.usedToday} of its ${a.capacity} sends a day used today`, detail: "Other campaigns sent or reserved them, so fewer first emails can go today." });
  }
  for (const a of editor.view.accounts.filter((x) => x.channel === "email" && !x.healthy)) {
    items.push({ title: `${a.label} ${CANNOT_SEND}`, detail: "Its leads wait until it can send again." });
  }
  if (facts.load && facts.load.notStartedWithinHorizon > 0) {
    items.push({ title: `${facts.load.notStartedWithinHorizon} leads would not start within ${facts.load.horizonDays} days`, detail: "The inboxes’ daily capacity is too small for this many leads." });
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
                  <span className="font-medium text-crit">{f.fallbacks.length > 0 ? `“${f.fallbacks.join("”, “")}” in some emails; one has no fallback. Blocks launch.` : "No fallback. Blocks launch."}</span>
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
  if (editor.launched || !load) return <p className="text-[14px] text-muted">The projection is for before launch. Once running, leads waiting for sending capacity show in Needs attention.</p>;
  if (!emailTrackOf(editor.view.definition)) return <p className="text-[14px] text-muted">Add an email track to see the load it puts on each sender inbox.</p>;
  if (load.accounts.length === 0) return <p className="text-[14px] text-crit">No connected sender inbox, so there is no load to project.</p>;
  // No figure that could contradict the engine: an inbox with no known end, or a track the estimate does not simulate yet.
  const blocked = load.cannotProject.length > 0 || load.otherTracksChangeTiming !== null;
  return (
    <>
      <table className="table text-[14px] max-[560px]:block">
        <thead className="max-[560px]:sr-only">
          <tr className="border-b border-line text-[13px] text-muted">
            <th className="px-0 py-2 font-medium">Sender inbox</th>
            <th className="py-2 font-medium">Busiest day, this campaign</th>
            <th className="py-2 font-medium">Used today, all campaigns</th>
          </tr>
        </thead>
        <tbody className="max-[560px]:block">
          {load.accounts.map((a) => (
            <tr key={a.id} className="border-line max-[560px]:flex max-[560px]:flex-col max-[560px]:gap-1 max-[560px]:py-2 [&+&]:border-t">
              <td className="px-0 py-2.5 max-[560px]:p-0">
                <span className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
                  <Icon name="email" className="mt-0.5 size-4 text-muted" />
                  <span>
                    {a.label}
                    <span className="block text-[12.5px] text-muted">At most one email every {gap(a.gapSeconds)}</span>
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
        </tbody>
      </table>
      {load.otherTracksChangeTiming !== null ? (
        <p className="mt-2 text-[13px] text-ink-2">
          {load.otherTracksChangeTiming === "this_campaign"
            ? thisCampaignsOtherTracks(editor.view.definition)
            : "Can’t project the load yet: another running campaign on these inboxes has a track (an SMS track, or a second email track) that changes when its emails go, and the estimate doesn’t include it yet."}
        </p>
      ) : blocked ? (
        <p className="mt-2 text-[13px] text-ink-2">
          Can’t project the load while{" "}
          {load.cannotProject
            .map((c) => (c.reason === "quota" ? `${c.label} waits for Instantly’s lead quota` : `${c.label} ${CANNOT_SEND}`))
            .join(", and ")}
          . Nothing says when that ends.
        </p>
      ) : (
      <p className="mt-2 text-[13px] text-muted">
        {load.daysUntilAllStart !== null
          ? `All ${load.leadsWithEmail} leads with an email start within ${load.daysUntilAllStart} ${load.daysUntilAllStart === 1 ? "day" : "days"} of launch.`
          : load.leadsWithEmail === 0
            ? "No lead has an email yet."
            : `${load.notStartedWithinHorizon} of ${load.leadsWithEmail} leads would not start within ${load.horizonDays} days.`}{" "}
        Follow-ups always go before first emails when an inbox is full. The emails other running campaigns have waiting on these inboxes are counted; every send is assumed to succeed, and replies, bounces and pauses are not foreseen.
        {load.leavesOutSms ? " SMS sends are not in this estimate yet: it counts email only." : ""}
      </p>
      )}
    </>
  );
}

/** Why this campaign's load is not projected, naming the tracks it actually has. */
function thisCampaignsOtherTracks(def: CampaignDefinition): string {
  const live = def.tracks.filter((t) => !t.removed && t.branch === "main");
  const sms = live.some((t) => t.channel === "sms");
  const emails = live.filter((t) => t.channel === "email").length;
  const has = [emails > 1 ? (emails === 2 ? "a second email track" : `${emails - 1} more email tracks`) : null, sms ? "an SMS track that doesn’t start after the email track" : null].filter((x) => x !== null).join(" and ");
  if (has === "") return "Can’t project the load yet: the email track doesn’t start at launch, and the estimate covers only an email track that does.";
  return `Can’t project the load yet: the estimate covers one email track, and this campaign also has ${has}, which can change when its emails go.${sms ? " An SMS track that starts after the email track keeps the estimate." : ""}`;
}

const gap = (seconds: number) => (seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`);

function Preview({ campaignId, editor, leads }: { campaignId: string; editor: SequenceEditor; leads: readonly PreviewLead[] }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const index = Math.max(0, leads.findIndex((l) => l.id === chosen));
  const lead = leads[index];
  const track = emailTrackOf(editor.view.definition);
  const selectId = useId();
  return (
    <section aria-labelledby="copy-for-a-lead" className="flex min-w-0 flex-col gap-3.5 rounded-box border border-line bg-base-100 px-5 pb-5 pt-4 min-[1240px]:sticky min-[1240px]:top-4">
      <h2 id="copy-for-a-lead" className="text-[19px]">
        Copy for a lead
      </h2>
      {leads.length === 0 ? (
        <p className="text-[14px] text-ink-2">
          No leads yet. <Link href={`/campaigns/${campaignId}/import`} className="underline">Import a scraper run</Link> to preview the copy for a real lead.
        </p>
      ) : !track ? (
        <p className="text-[14px] text-ink-2">Add an email track to preview its copy.</p>
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
            {lead.kind === "company" ? "Company lead" : `${lead.title ? `${lead.title}, ` : ""}${lead.company}`}.{" "}
            {lead.email ? `Email to ${lead.email}.` : "No email, so the email track is skipped for them."}
          </p>
          <p className="text-[12.5px] text-muted">
            <mark className="bg-transparent text-inherit underline decoration-hand decoration-dotted decoration-2 underline-offset-[3px]">dotted</mark> fallback text, because this lead lacks the field
          </p>
          <LeadCopy campaignId={campaignId} enrollmentId={lead.id} version={editor.view.definitionVersion} hasEmail={lead.email !== null} />
        </>
      ) : null}
    </section>
  );
}

function LeadCopy({ campaignId, enrollmentId, version, hasEmail }: { campaignId: string; enrollmentId: string; version: number; hasEmail: boolean }) {
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
  return (
    <ol className="flex flex-col gap-3" aria-label="The emails, in order">
      {preview.steps.map((s) => (
        <li key={s.stepId} className="overflow-hidden rounded-field border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-raised px-3.5 py-2 text-[13px]">
            <span className="flex items-center gap-1.5 font-semibold">
              <Icon name="email" className="size-4 text-muted" />
              Email {s.number}
            </span>
            <span className="whitespace-nowrap text-muted">Day {s.day}</span>
          </div>
          <div className="px-3.5 py-3 text-[14px] leading-[1.55]">
            {!hasEmail ? (
              <p className="text-muted">Skipped: this lead has no email.</p>
            ) : (
              <>
                <p className="mb-2 font-semibold [overflow-wrap:anywhere]">
                  <Segments segments={s.subject} empty="No subject yet" />
                </p>
                <p className="whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
                  <Segments segments={s.body} empty="No copy yet. Launch is blocked until this email has copy." />
                </p>
                {s.missing.length > 0 && (
                  <p className="mt-2 text-[13px] font-medium text-crit">
                    This lead has no {s.missing.map(fieldLabel).join(" or ")} and the field has no fallback, so this email can’t be sent to them.
                  </p>
                )}
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
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
