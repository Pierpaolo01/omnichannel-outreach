import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type { CampaignListItem, LeadRow, LeadSearchResult } from "../../shared/api.ts";
import { PageTitle } from "../App.tsx";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { STATUS_OPTIONS, StatusBadge } from "../status.tsx";

/** Search and filters live in the URL, so a search can be linked, refreshed and gone back to. */
function useLeadQuery() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const query = useMemo(() => {
    const params = new URLSearchParams(search);
    return { q: params.get("q") ?? "", campaign: params.get("campaign") ?? "", status: params.get("status") ?? "" };
  }, [search]);
  const update = useCallback(
    (next: Partial<typeof query>) => {
      const out = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...query, ...next })) if (value) out.set(key, value);
      const qs = out.toString();
      navigate(qs ? `/leads?${qs}` : "/leads", { replace: true });
    },
    [query, navigate],
  );
  return { query, update };
}

export function LeadsPage() {
  const { query, update } = useLeadQuery();
  const [text, setText] = useState(query.q);
  const [urlQ, setUrlQ] = useState(query.q);

  // Follow the URL when it changes from outside this box (top search, back button).
  if (query.q !== urlQ) {
    setUrlQ(query.q);
    if (query.q !== text.trim()) setText(query.q);
  }

  useEffect(() => {
    const next = text.trim();
    if (next === query.q) return;
    const timer = setTimeout(() => update({ q: next }), 200);
    return () => clearTimeout(timer);
  }, [text, query.q, update]);

  const campaigns = useApi<{ campaigns: CampaignListItem[] }>("/api/campaigns");
  const api = new URLSearchParams();
  if (query.q) api.set("q", query.q);
  if (query.campaign) api.set("campaign", query.campaign);
  if (query.status) api.set("status", query.status);
  const { result, retry } = useApi<LeadSearchResult>(`/api/leads?${api.toString()}`);
  const everyone = useApi<LeadSearchResult>("/api/leads?limit=1");

  const filtered = Boolean(query.q || query.campaign || query.status);
  const total = everyone.result.state === "ready" ? everyone.result.data.total : null;
  const shown = result.state === "ready" ? result.data : result.state === "loading" ? result.previous : null;
  const campaignList = campaigns.result.state === "ready" ? campaigns.result.data.campaigns : [];

  return (
    <div>
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-4">
        <PageTitle>Leads</PageTitle>
        {shown && total !== null && (
          <span className="text-[13px] text-muted" aria-live="polite">
            {shown.total === total ? `${total} people` : `${shown.total} of ${total} people`}
          </span>
        )}
      </div>

      <label className="input input-lg h-auto w-full gap-2.5 rounded-xl border-line-strong bg-base-100 px-4 py-[11px] text-muted focus-within:border-call focus-within:shadow-[0_0_0_3px_var(--color-call-soft)] focus-within:outline-none">
        <Icon name="search" />
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search by name, company, email or phone number"
          aria-label="Search leads"
          className="text-[17px] text-base-content"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <select
          aria-label="Campaign"
          className="select select-sm h-9 w-auto border-line-strong bg-base-100 text-[14px]"
          value={query.campaign}
          onChange={(event) => update({ campaign: event.target.value })}
        >
          <option value="">All campaigns</option>
          {campaignList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Outreach status"
          className="select select-sm h-9 w-auto border-line-strong bg-base-100 text-[14px]"
          value={query.status}
          onChange={(event) => update({ status: event.target.value })}
        >
          <option value="">Any outreach status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto font-medium text-muted"
            onClick={() => {
              setText("");
              update({ q: "", campaign: "", status: "" });
            }}
          >
            Clear search and filters
          </button>
        )}
      </div>

      <div className="mt-4">
        {result.state === "error" ? (
          <ErrorState title="Leads didn’t load." message={result.message} onRetry={retry} />
        ) : shown === null ? (
          <TableSkeleton />
        ) : total === 0 ? (
          <Empty>No leads yet. People and companies appear here once a scraper export is imported into a campaign.</Empty>
        ) : (
          <LeadTable result={shown} query={query.q} loading={result.state === "loading"} />
        )}
      </div>
    </div>
  );
}

function LeadTable({ result, query, loading }: { result: LeadSearchResult; query: string; loading: boolean }) {
  return (
    <>
      <div
        className={`overflow-hidden rounded-box border border-line bg-base-100 transition-opacity ${loading ? "opacity-60" : ""}`}
        aria-busy={loading}
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr className="border-line text-[13px] font-medium text-muted">
                <th className="px-3.5 py-3 font-medium">Person</th>
                <th className="px-3.5 py-3 font-medium">Company</th>
                <th className="px-3.5 py-3 font-medium">Campaigns</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3.5 py-6 text-muted">
                    {query
                      ? `No one matches “${query}”. Try part of the name, the email domain, or the last digits of a phone number.`
                      : "No one matches these filters."}
                  </td>
                </tr>
              ) : (
                result.rows.map((row) => <LeadTableRow key={`${row.kind}:${row.id}`} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
      {result.total > result.rows.length && (
        <p className="mt-3 text-[13px] text-muted">
          Showing the first {result.rows.length} of {result.total}. Narrow the search to see the rest.
        </p>
      )}
    </>
  );
}

function LeadTableRow({ row }: { row: LeadRow }) {
  const [, navigate] = useLocation();
  const href = row.kind === "person" ? `/leads/people/${row.id}` : `/leads/companies/${row.id}`;
  return (
    <tr
      className="cursor-pointer border-line align-top hover:[&>td]:bg-raised"
      onClick={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("a")) navigate(href);
      }}
    >
      <td className="px-3.5 py-3.5">
        <Link href={href} className="font-semibold no-underline hover:underline">
          {row.name}
        </Link>
        <div className="text-[13px] text-muted">{row.kind === "person" ? row.title : "No named decision maker"}</div>
      </td>
      <td className="px-3.5 py-3.5">
        {row.kind === "person" ? (
          <>
            {row.company.name}
            <div className="text-[13px] text-muted">{row.company.city}</div>
          </>
        ) : (
          <span className="text-[13px] text-muted">{row.enrollments.length > 0 ? "Company lead" : "Company"}</span>
        )}
      </td>
      <td className="px-3.5 py-3.5">
        <div className="flex flex-col gap-1.5">
          {row.enrollments.length > 0 ? (
            row.enrollments.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge status={e.status} />
                <span className="min-w-0 text-[13px] text-muted">{e.campaign.name}</span>
              </div>
            ))
          ) : (
            <span className="text-[13px] text-muted">
              {row.unenrolledReason === "no_usable_channel" ? "Not in a campaign: no usable email or phone" : "Not in a campaign"}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="rounded-box border border-line bg-base-100 px-5 py-6 text-muted">{children}</p>;
}

function TableSkeleton() {
  return (
    <div className="rounded-box border border-line bg-base-100 p-4" aria-busy="true" aria-label="Loading leads">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-6 border-line py-3.5 [&+&]:border-t">
          <div className="skeleton h-5 w-44" />
          <div className="skeleton h-5 w-40" />
          <div className="skeleton h-5 w-56" />
        </div>
      ))}
    </div>
  );
}
