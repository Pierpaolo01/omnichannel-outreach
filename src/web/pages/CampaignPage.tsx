import type { ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type { BeforeLaunchView, CampaignDetail, ImportRecord, LeadOutcome } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { BeforeLaunchTab } from "../campaign/BeforeLaunchTab.tsx";
import { SequenceTab } from "../campaign/SequenceTab.tsx";
import { useSequence, type SequenceEditor } from "../campaign/useSequence.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { whenImported } from "../importText.tsx";
import { useNow } from "../time.ts";

export type CampaignTab = "sequence" | "before-launch" | "test-run" | "leads" | "imports";

const TAB_PATH: Record<CampaignTab, string> = { sequence: "", "before-launch": "/before-launch", "test-run": "/test-run", leads: "/leads", imports: "/imports" };

export const campaignPath = (id: string, tab: CampaignTab = "sequence") => `/campaigns/${encodeURIComponent(id)}${TAB_PATH[tab]}`;

/**
 * A campaign: tabs, with the Sequence canvas and its inspector first (variant A, "Tabs and
 * inspector", provisionally selected on 12 November 2026; DESIGN.md).
 */
export function CampaignPage({ id, tab }: { id: string; tab: CampaignTab }) {
  const detail = useApi<CampaignDetail>(`/api/campaigns/${encodeURIComponent(id)}`);
  const sequence = useSequence(id);
  const editor = sequence.editor;

  if (detail.result.state === "error" || sequence.result.state === "error") {
    const failed = detail.result.state === "error" ? detail.result : sequence.result.state === "error" ? sequence.result : null;
    return (
      <div>
        <BackToCampaigns />
        {failed?.notFound ? (
          <NoSuchCampaign />
        ) : (
          <ErrorState
            title="This campaign didn’t load."
            message={failed?.message ?? ""}
            onRetry={() => {
              detail.retry();
              sequence.retry();
            }}
          />
        )}
      </div>
    );
  }
  if (detail.result.state !== "ready" || !editor) return <CampaignSkeleton />;
  return <Campaign detail={detail.result.data} editor={editor} tab={tab} />;
}

function Campaign({ detail, editor, tab }: { detail: CampaignDetail; editor: SequenceEditor; tab: CampaignTab }) {
  const now = useNow();
  const { campaign, imports, leadCount } = detail;
  const { view } = editor;
  const blockers = view.launch.blockers.length;
  const lastImport = imports[0];
  return (
    <div>
      <BackToCampaigns />
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 text-[30px] leading-[1.15] tracking-[-0.02em] [overflow-wrap:anywhere]">{campaign.name}</h1>
            <LaunchBadge launchedAt={view.launchedAt} />
          </div>
          <p className="mt-1.5 text-[13.5px] text-muted">
            {view.launchedAt ? `Launched ${longDate(view.launchedAt)} · ` : ""}
            {leadCount} {leadCount === 1 ? "lead" : "leads"}
            {lastImport ? ` · last import ${whenImported(lastImport.importedAt, now)}` : " · nothing imported yet"}
          </p>
        </div>
        {!editor.launched && tab !== "before-launch" && (
          <div className="flex flex-wrap items-center gap-2.5 sm:mt-1.5">
            {view.launch.nothingToLaunch ? (
              <span className="text-[12.5px] text-muted">Add a track to launch</span>
            ) : blockers > 0 ? (
              <span className="text-[12.5px] text-crit">
                {blockers} {blockers === 1 ? "thing blocks" : "things block"} launch
              </span>
            ) : null}
            {view.launch.canLaunch ? (
              <Link href={campaignPath(campaign.id, "before-launch")} className="btn btn-primary font-semibold no-underline">
                Launch…
              </Link>
            ) : (
              <button type="button" className="btn btn-primary font-semibold" disabled>
                Launch
              </button>
            )}
          </div>
        )}
      </header>
      {editor.launched && (
        <p className="mt-4 rounded-box border border-line bg-base-100 px-4 py-3 text-[14px] text-ink-2">
          Email goes out on its own, inside each lead’s sending window. Pausing, resuming and editing a running campaign arrive with later releases.
        </p>
      )}

      <nav aria-label="Campaign" className="mt-3.5 flex flex-wrap gap-1 border-b border-line">
        <TabLink href={campaignPath(campaign.id)} current={tab === "sequence"}>
          Sequence
        </TabLink>
        <TabLink href={campaignPath(campaign.id, "before-launch")} current={tab === "before-launch"}>
          Before launch
          {view.launch.nothingToLaunch ? null : blockers > 0 ? (
            <span className="text-[12.5px] font-semibold text-crit">{blockers} to fix</span>
          ) : (
            <span className="text-[12.5px] font-semibold text-you">{editor.launched ? "Launched" : "Ready"}</span>
          )}
        </TabLink>
        <TabLink href={campaignPath(campaign.id, "test-run")} current={tab === "test-run"}>
          Test run
        </TabLink>
        <TabLink href={campaignPath(campaign.id, "leads")} current={tab === "leads"}>
          Leads <span className="text-[12.5px] tabular-nums text-muted">{leadCount}</span>
        </TabLink>
        <TabLink href={campaignPath(campaign.id, "imports")} current={tab === "imports"}>
          Imports <span className="text-[12.5px] tabular-nums text-muted">{imports.length}</span>
        </TabLink>
      </nav>

      <div className="mt-4">
        {tab === "sequence" && <SequenceTab campaignId={campaign.id} editor={editor} />}
        {tab === "before-launch" && <BeforeLaunchTab campaignId={campaign.id} editor={editor} />}
        {tab === "test-run" && <TestRunTab />}
        {tab === "leads" && <LeadsTab campaignId={campaign.id} version={view.definitionVersion} />}
        {tab === "imports" && <ImportsTab campaignId={campaign.id} imports={imports} />}
      </div>
    </div>
  );
}

function TabLink({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`-mb-px flex items-center gap-[9px] border-b-2 px-3.5 pb-3 pt-2.5 font-medium no-underline hover:text-base-content focus-visible:outline-offset-[-2px] ${
        current ? "border-base-content text-base-content" : "border-transparent text-muted"
      }`}
    >
      {children}
    </Link>
  );
}

export function LaunchBadge({ launchedAt }: { launchedAt: string | null }) {
  return launchedAt ? (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-you-soft py-0.5 pl-[7px] pr-2 text-[13px] font-medium text-you before:size-[7px] before:rounded-full before:bg-current before:content-['']">
      Running
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-raised py-0.5 pl-[7px] pr-2 text-[13px] font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] before:box-border before:size-2 before:rounded-full before:border-[1.5px] before:border-dashed before:border-current before:content-['']">
      Not launched
    </span>
  );
}

export const longDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso)).replace(",", "");

function BackToCampaigns() {
  return (
    <Link href="/campaigns" className="mb-[18px] inline-flex items-center gap-1.5 text-[14px] text-muted no-underline hover:text-base-content">
      <Icon name="back" className="size-4" />
      Campaigns
    </Link>
  );
}

function NoSuchCampaign() {
  return (
    <div className="max-w-[680px]">
      <h1 className="text-[30px] leading-[1.15]">No such campaign</h1>
      <p className="mt-2 text-muted">
        It may have been removed, or the link is wrong.{" "}
        <Link href="/campaigns" className="text-base-content underline">
          Back to Campaigns
        </Link>
        .
      </p>
    </div>
  );
}

function CampaignSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the campaign">
      <div className="skeleton mb-[18px] h-4 w-24" />
      <div className="skeleton h-9 w-96 max-w-full" />
      <div className="skeleton mt-2 h-4 w-64 max-w-full" />
      <div className="skeleton mt-6 h-10 w-full" />
      <div className="skeleton mt-4 h-[360px] w-full" />
    </div>
  );
}

function TestRunTab() {
  return (
    <div className="max-w-[680px] rounded-box border border-dashed border-line-strong bg-base-100 px-6 py-6">
      <h2 className="text-[19px]">Test runs arrive with a later release</h2>
      <p className="mt-2 text-ink-2">
        A test run will send every step to your own test email and mobile from the real sender inboxes, with each wait cut to about a minute.
        It is optional: you can launch without one.
      </p>
    </div>
  );
}

const COUNT_WORDS: readonly [LeadOutcome, string][] = [
  ["new", "new"],
  ["updated", "updated"],
  ["already_enrolled", "already enrolled"],
  ["not_enrolled", "not enrolled"],
];

function ImportsTab({ campaignId, imports }: { campaignId: string; imports: readonly ImportRecord[] }) {
  const now = useNow();
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">Every import into this campaign, newest first.</p>
        <Link href={`/campaigns/${campaignId}/import`} className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium no-underline">
          <Icon name="upload" className="size-4" />
          {imports.length > 0 ? "Import again" : "Import"}
        </Link>
      </div>
      {imports.length === 0 ? (
        <p className="rounded-box border border-dashed border-line-strong bg-base-100 px-5 py-5 text-ink-2">Nothing imported yet. Import a scraper run to add this campaign’s leads.</p>
      ) : (
        <ul className="rounded-box border border-line bg-base-100">
          {imports.map((record) => {
            const files = [record.fileNames.people, record.fileNames.businesses].filter((f): f is string => Boolean(f));
            const counts = Object.fromEntries(record.summary.entries.reduce((m, e) => m.set(e.outcome, (m.get(e.outcome) ?? 0) + 1), new Map<string, number>()));
            const changes = COUNT_WORDS.filter(([key]) => (counts[key] ?? 0) > 0)
              .map(([key, word]) => `${counts[key]} ${word}`)
              .join(", ");
            return (
              <li key={record.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-line px-4 py-3 text-[14px] [&+&]:border-t">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <b className="font-semibold">{capitalise(whenImported(record.importedAt, now))}</b>
                  {files.length > 0 ? ` · ${files.join(" and ")}` : ""}
                </span>
                <span className="text-ink-2">
                  {changes || "no changes"} ·{" "}
                  <Link href={`/campaigns/${campaignId}/imports/${record.id}`} className="underline">
                    See result
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const SHOWN = 50;

function LeadsTab({ campaignId, version }: { campaignId: string; version: number }) {
  const { result, retry } = useApi<BeforeLaunchView>(`/api/campaigns/${encodeURIComponent(campaignId)}/before-launch?v=${version}`);
  const [, navigate] = useLocation();
  const all = new URLSearchParams(useSearch()).get("all") === "1";
  if (result.state === "error") return <ErrorState title="The leads didn’t load." message={result.message} onRetry={retry} />;
  if (result.state === "loading")
    return (
      <div role="status" aria-busy="true" aria-label="Loading the leads" className="flex flex-col gap-2">
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-12 w-full" />
        <div className="skeleton h-12 w-full" />
      </div>
    );
  const { leads } = result.data;
  const shown = all ? leads : leads.slice(0, SHOWN);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-muted">Every lead in this campaign that hasn’t ended. Open one for their record.</p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/leads?campaign=${campaignId}`} className="btn btn-sm border-line-strong bg-base-100 font-medium no-underline">
            Open in Leads
          </Link>
          <Link href={`/campaigns/${campaignId}/import`} className="btn btn-sm gap-1.5 border-line-strong bg-base-100 font-medium no-underline">
            <Icon name="upload" className="size-4" />
            Import again
          </Link>
        </div>
      </div>
      {leads.length === 0 ? (
        <p className="rounded-box border border-dashed border-line-strong bg-base-100 px-5 py-5 text-ink-2">
          No leads yet. <Link href={`/campaigns/${campaignId}/import`} className="underline">Import a scraper run</Link> to add them.
        </p>
      ) : (
        <div className="overflow-hidden rounded-box border border-line bg-base-100">
          <table className="table text-[14px] max-[720px]:block">
            <thead className="max-[720px]:sr-only">
              <tr className="border-b border-line text-[13px] text-muted">
                <th className="px-3.5 py-3 font-medium">Lead</th>
                <th className="px-3.5 py-3 font-medium">Company</th>
                <th className="px-3.5 py-3 font-medium">Email · mobile · phone</th>
                <th className="px-3.5 py-3 font-medium">Uses a fallback for</th>
              </tr>
            </thead>
            <tbody className="max-[720px]:block">
              {shown.map((lead) => (
                <tr key={lead.id} className="border-line max-[720px]:block max-[720px]:px-1 max-[720px]:py-2 [&+&]:border-t">
                  <td className="px-3.5 py-3 max-[720px]:block max-[720px]:py-1">
                    <Link href={lead.kind === "person" ? `/leads/people/${lead.recordId}` : `/leads/companies/${lead.recordId}`} className="font-semibold no-underline hover:underline [overflow-wrap:anywhere]">
                      {lead.name}
                    </Link>
                    <div className="text-[13px] text-muted">{lead.kind === "company" ? "Company lead" : lead.title}</div>
                  </td>
                  <td className="px-3.5 py-3 [overflow-wrap:anywhere] max-[720px]:block max-[720px]:py-1">{lead.kind === "company" ? <span className="text-muted">No named decision maker</span> : lead.company}</td>
                  <td className="px-3.5 py-3 max-[720px]:block max-[720px]:py-1">
                    <span className="flex items-center gap-1.5">
                      <Channel has={lead.email !== null} icon="email" label="email" />
                      <Channel has={lead.mobile} icon="sms" label="mobile" />
                      <Channel has={lead.phone} icon="call" label="phone number" />
                    </span>
                  </td>
                  <td className="px-3.5 py-3 max-[720px]:block max-[720px]:py-1">
                    {lead.lacks.length === 0 ? (
                      <span className="text-muted">Nothing missing</span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5">
                        {lead.lacks.map((field) => (
                          <span key={field} className="rounded-[5px] bg-hand-soft px-1.5 text-[12.5px] font-semibold text-hand">
                            {field.replace(/_/g, " ")}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length < leads.length && (
            <p className="border-t border-line px-3.5 py-3 text-[14px]">
              {leads.length - shown.length} more leads.{" "}
              <button type="button" className="cursor-pointer underline" onClick={() => navigate(`${campaignPath(campaignId, "leads")}?all=1`)}>
                Show all {leads.length}
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Channel({ has, icon, label }: { has: boolean; icon: "email" | "sms" | "call"; label: string }) {
  return (
    <span className={has ? "text-ink-2" : "text-line-strong"} title={has ? `Has a ${label}` : `No ${label}`}>
      <Icon name={icon} className="size-4" />
      <span className="sr-only">{has ? `Has a ${label}.` : `No ${label}.`}</span>
    </span>
  );
}
