import { useState } from "react";
import { Link } from "wouter";
import type { Campaign, ImportRecord, LeadOutcome, SummaryEntry } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { OUTCOME_LABEL, OUTCOME_ORDER, resultLede, whatHappened, whenImported } from "../importText.tsx";
import { useNow } from "../time.ts";

type Tab = "all" | LeadOutcome;

/** The result of one import: every row, with a tab per outcome. */
export function ImportResultPage({ campaignId, importId }: { campaignId: string; importId: string }) {
  const { result, retry } = useApi<{ campaign: Campaign; imports: ImportRecord[] }>(`/api/campaigns/${encodeURIComponent(campaignId)}`);
  return (
    <div>
      <Link href="/campaigns" className="mb-[18px] inline-flex items-center gap-1.5 text-[14px] text-muted no-underline hover:text-base-content">
        <Icon name="back" className="size-4" />
        Campaigns
      </Link>
      {result.state === "loading" ? (
        <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading the import result">
          <div className="skeleton h-9 w-[28rem] max-w-full" />
          <div className="skeleton h-5 w-[36rem] max-w-full" />
          <div className="skeleton mt-6 h-64 w-full" />
        </div>
      ) : result.state === "error" ? (
        <ErrorState title="This import result didn’t load." message={result.message} onRetry={retry} />
      ) : (
        <Result campaign={result.data.campaign} imports={result.data.imports} importId={importId} />
      )}
    </div>
  );
}

function Result({ campaign, imports, importId }: { campaign: Campaign; imports: readonly ImportRecord[]; importId: string }) {
  const now = useNow();
  const [tab, setTab] = useState<Tab>("all");
  const index = imports.findIndex((i) => i.id === importId);
  const record = imports[index];
  if (!record) return <h1 className="text-[30px] leading-[1.15]">No such import</h1>;

  // Imports are listed newest first, so the campaign's first import is the last one.
  const firstImport = index === imports.length - 1;
  const { summary, fileNames } = record;
  const files = [fileNames.people, fileNames.businesses].filter((n): n is string => Boolean(n));
  const when = whenImported(record.importedAt, now);
  const tabs: readonly [Tab, string, number][] = [
    ["all", "All", summary.entries.length],
    ...(["new", "already_enrolled", "updated", "not_enrolled"] as const).map(
      (o): [Tab, string, number] => [o, OUTCOME_LABEL[o], summary.counts[o]],
    ),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[30px] leading-[1.15] tracking-[-0.02em]">
            {firstImport ? "Imported into" : "Imported again into"} {campaign.name}
          </h1>
          <p className="mt-1.5 max-w-[64ch] text-[16px] text-ink-2">{resultLede(summary, firstImport)}</p>
        </div>
        <Link href={`/leads?campaign=${campaign.id}`} className="btn border-line-strong bg-base-100 font-medium no-underline">
          Find them in Leads
        </Link>
      </div>
      <p className="mt-2.5 text-[13px] text-muted">
        {when.charAt(0).toUpperCase() + when.slice(1)}
        {files.length > 0 ? ` from ${files.join(" and ")}` : ""}.{firstImport ? "" : " No sequence was restarted."}
      </p>

      {/* The approved ledger's underline tabs: a 2px ink underline sitting on a full-width rule. */}
      <div role="tablist" aria-label="Import outcomes" className="mt-[30px] flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls="import-rows"
            className={`-mb-px flex cursor-pointer items-center gap-[9px] border-b-2 px-3.5 pb-3 pt-2.5 font-medium hover:text-base-content focus-visible:outline-offset-[-2px] ${
              tab === key ? "border-base-content text-base-content" : "border-transparent text-muted"
            }`}
            onClick={() => setTab(key)}
          >
            {label}
            <span className={`text-[12.5px] tabular-nums ${tab === key ? "text-muted" : "text-faint"}`}>{count}</span>
          </button>
        ))}
      </div>

      <div
        id="import-rows"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="overflow-hidden rounded-b-box border border-t-0 border-line bg-base-100"
      >
        {/* Below 720px each row stacks into a card-like block, so nothing scrolls sideways. */}
        <div className="overflow-x-auto max-[720px]:overflow-visible">
          <table className="table text-[14px] max-[720px]:block">
            <thead className="max-[720px]:sr-only">
              <tr className="border-b border-line text-[13px] text-muted">
                <th className="px-3.5 py-3 font-medium">Decision maker or company lead</th>
                <th className="px-3.5 py-3 font-medium">Company</th>
                <th className="px-3.5 py-3 font-medium">Result</th>
                <th className="px-3.5 py-3 font-medium">What happened</th>
              </tr>
            </thead>
            <tbody className="max-[720px]:block">
              <Rows entries={summary.entries} tab={tab} onShow={setTab} />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Rows({ entries, tab, onShow }: { entries: readonly SummaryEntry[]; tab: Tab; onShow: (tab: Tab) => void }) {
  if (tab !== "all") {
    const rows = entries.filter((e) => e.outcome === tab);
    if (rows.length === 0) {
      return (
        <tr className="max-[720px]:block">
          <td colSpan={4} className="px-3.5 py-6 text-muted max-[720px]:block">
            None in this import.
          </td>
        </tr>
      );
    }
    return rows.map((entry, i) => <EntryRow key={i} entry={entry} />);
  }
  return OUTCOME_ORDER.map((outcome) => {
    const rows = entries.filter((e) => e.outcome === outcome);
    if (rows.length === 0) return null;
    const collapsed = outcome === "already_enrolled";
    return [
      <tr key={`${outcome}-head`} className="border-line max-[720px]:block">
        <td colSpan={4} className="max-[720px]:block bg-raised px-3.5 py-[9px] text-[13px] font-semibold text-muted">
          {OUTCOME_LABEL[outcome]}, {rows.length}
        </td>
      </tr>,
      ...(collapsed
        ? [
            <tr key={`${outcome}-more`} className="border-line max-[720px]:block">
              <td colSpan={4} className="max-[720px]:block px-3.5 py-3.5 text-[13.5px] text-muted">
                No change for {rows.length} {rows.length === 1 ? "lead" : "leads"}.{" "}
                <button type="button" className="link text-muted hover:text-base-content" onClick={() => onShow("already_enrolled")}>
                  Show them
                </button>
              </td>
            </tr>,
          ]
        : rows.map((entry, i) => <EntryRow key={`${outcome}-${i}`} entry={entry} />)),
    ];
  });
}

function EntryRow({ entry }: { entry: SummaryEntry }) {
  const href =
    entry.lead === null ? null : entry.lead.kind === "person" ? `/leads/people/${entry.lead.personId}` : `/leads/companies/${entry.lead.companyId}`;
  const isCompany = entry.lead?.kind === "company" || ("file" in entry && entry.file === "businesses");
  const sub = isCompany ? (entry.outcome === "not_enrolled" ? "Company" : "Company lead") : entry.lead === null ? "" : entry.title;
  return (
    <tr className="border-line align-top max-[720px]:grid max-[720px]:grid-cols-[minmax(0,1fr)_auto] max-[720px]:gap-x-3 max-[720px]:gap-y-1 max-[720px]:px-3.5 max-[720px]:py-3 max-[720px]:[&>td]:border-0 max-[720px]:[&>td]:p-0">
      <td className="px-3.5 py-3.5">
        {href ? (
          <Link href={href} className="font-semibold no-underline hover:underline">
            {entry.name}
          </Link>
        ) : (
          <span className="font-semibold">{entry.name}</span>
        )}
        {sub && <div className="text-[13px] text-muted">{sub}</div>}
      </td>
      <td className="px-3.5 py-3.5 max-[720px]:order-3 max-[720px]:col-span-2">
        {entry.lead === null ? (
          entry.reason === "ambiguous_match" && entry.file === "people" ? (
            entry.companyName
          ) : (
            <span className="text-[13px] text-muted">{entry.reason === "ambiguous_match" ? "Not matched" : "Not in the Businesses file"}</span>
          )
        ) : isCompany ? (
          <span className="text-[13px] text-muted">
            {entry.peopleAtCompany > 0 ? `${entry.peopleAtCompany} on record, none reachable` : "No named decision maker"}
          </span>
        ) : (
          <Link href={`/leads?company=${entry.companyId}`} className="no-underline hover:underline">
            {entry.companyName}
          </Link>
        )}
      </td>
      <td className="whitespace-nowrap px-3.5 py-3.5 max-[720px]:order-2 max-[720px]:text-right">
        <span className={`font-semibold ${entry.outcome === "not_enrolled" ? "text-muted" : ""}`}>{OUTCOME_LABEL[entry.outcome]}</span>
      </td>
      <td className="px-3.5 py-3.5 text-ink-2 max-[720px]:order-4 max-[720px]:col-span-2">{whatHappened(entry)}</td>
    </tr>
  );
}
