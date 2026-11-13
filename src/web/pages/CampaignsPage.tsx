import { Link } from "wouter";
import type { CampaignListItem, LeadOutcome } from "../../shared/api.ts";
import { PageTitle, QuickSearch } from "../App.tsx";
import { useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { whenImported } from "../importText.tsx";
import { useNow } from "../time.ts";
import { LaunchBadge, campaignPath } from "./CampaignPage.tsx";

const TRACK_NAME = { email: "Email track", sms: "SMS track", call: "Phone track" } as const;

/** Campaigns: the list, with New campaign and Import again (guided import, chosen 12 November 2026). */
export function CampaignsPage() {
  const { result, retry } = useApi<{ campaigns: CampaignListItem[] }>("/api/campaigns");
  const campaigns = result.state === "ready" ? result.data.campaigns : null;

  return (
    <div>
      <QuickSearch />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageTitle>Campaigns</PageTitle>
        {campaigns && campaigns.length > 0 && <NewCampaignButton />}
      </div>
      {result.state === "error" ? (
        <div className="mt-5">
          <ErrorState title="Campaigns didn’t load." message={result.message} onRetry={retry} />
        </div>
      ) : campaigns === null ? (
        <div className="mt-5 flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading campaigns">
          <div className="skeleton h-[104px] w-full" />
          <div className="skeleton h-[104px] w-full" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="mt-6 flex flex-col items-start gap-2.5 rounded-box border border-dashed border-line-strong bg-base-100 px-10 py-11">
          <h2 className="text-[19px]">Start a campaign from a scraper run</h2>
          <p className="max-w-[60ch] text-ink-2">
            Name the campaign and add the People and Businesses files the scraper exported. The people and companies in them become this
            campaign’s leads.
          </p>
          <div className="mt-2">
            <NewCampaignButton />
          </div>
        </div>
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {campaigns.map((campaign) => (
            <CampaignRow key={campaign.id} campaign={campaign} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NewCampaignButton() {
  return (
    <Link href="/campaigns/new" className="btn btn-primary gap-1.5 font-semibold no-underline">
      <Icon name="plus" className="size-4" />
      New campaign
    </Link>
  );
}

const COUNT_WORDS: readonly [LeadOutcome, string][] = [
  ["new", "new"],
  ["updated", "updated"],
  ["not_enrolled", "not enrolled"],
];

function CampaignRow({ campaign }: { campaign: CampaignListItem }) {
  const now = useNow();
  const last = campaign.lastImport;
  const changes = last
    ? COUNT_WORDS.filter(([key]) => last.counts[key] > 0)
        .map(([key, word]) => `${last.counts[key]} ${word}`)
        .join(", ") || "no changes"
    : null;
  return (
    <li className="grid grid-cols-1 items-center gap-x-5 gap-y-3 rounded-box border border-line bg-base-100 px-5 py-[18px] sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 text-[17px]">
            <Link href={campaignPath(campaign.id)} className="no-underline hover:underline">
              {campaign.name}
            </Link>
          </h2>
          <LaunchBadge launchedAt={campaign.sequence.launchedAt} />
        </div>
        <p className="mt-1 text-[13.5px] text-muted">
          {campaign.leadCount} {campaign.leadCount === 1 ? "lead" : "leads"}.{" "}
          {last ? (
            <>
              Last import {whenImported(last.importedAt, now)}: {changes}.{" "}
              <Link href={`/campaigns/${campaign.id}/imports/${last.id}`} className="text-muted underline hover:text-base-content">
                See result
              </Link>
            </>
          ) : (
            "Nothing imported yet."
          )}
        </p>
        {campaign.sequence.tracks.length === 0 ? (
          <p className="mt-2.5 flex items-center gap-2 text-[13px] text-faint">
            <span className="w-[62px] border-t-[1.5px] border-dashed border-line-strong" aria-hidden="true" />
            No sequence yet
          </p>
        ) : (
          <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-muted">
            {campaign.sequence.tracks.map((channel, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="w-2 border-t border-line-strong" aria-hidden="true" />}
                <span className="grid size-7 place-items-center rounded-[7px] border border-line-strong bg-base-100 text-ink-2" title={TRACK_NAME[channel]}>
                  <Icon name={channel === "call" ? "call" : channel} className="size-4" />
                </span>
              </span>
            ))}
            <span className="sr-only">Sequence: {campaign.sequence.tracks.map((c) => TRACK_NAME[c]).join(", ")}</span>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 justify-self-start sm:justify-self-end">
        <Link
          href={`/campaigns/${campaign.id}/import`}
          className="btn gap-1.5 border-line-strong bg-base-100 font-medium no-underline"
          aria-label={`${last ? "Import again into" : "Import into"} ${campaign.name}`}
        >
          <Icon name="upload" className="size-4" />
          {last ? "Import again" : "Import"}
        </Link>
        <Link href={campaignPath(campaign.id)} className="btn border-line-strong bg-base-100 font-medium no-underline" aria-label={`Open ${campaign.name}`}>
          Open
        </Link>
      </div>
    </li>
  );
}
