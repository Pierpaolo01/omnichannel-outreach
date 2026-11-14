import { useId, type ReactNode } from "react";
import { Link } from "wouter";
import type { ColleagueView, ContactDetailView, EnrollmentView, RecordCalls, RecordControls, UnenrolledReason } from "../shared/api.ts";
import { declinedRecordLine, recordCallLine } from "./calls/wording.ts";
import { Icon } from "./icons.tsx";
import { StatusBadge } from "./status.tsx";
import { CampaignPausedMarker, LeadControls, LeadSentence } from "./controls/ControlViews.tsx";
import type { Controls } from "./controls/useControls.ts";
import { clockIn, useNow } from "./time.ts";
import type { Freshness } from "./calls/refresher.ts";

export function ErrorState({ title, message, onRetry, retryRef, rescue }: { title: string; message: string; onRetry?: () => void; retryRef?: (el: HTMLButtonElement | null) => void; rescue?: number }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-box bg-crit-soft px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-[1_1_320px]">
        <b className="font-semibold text-crit">{title}</b> <span className="text-ink-2">{message}</span>
      </span>
      {onRetry && (
        <button type="button" ref={retryRef} data-rescue={rescue} className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function BackToLeads() {
  return (
    <Link href="/leads" className="mb-[18px] inline-flex items-center gap-1.5 text-[14px] text-muted no-underline hover:text-base-content">
      <Icon name="back" className="size-4" />
      Leads
    </Link>
  );
}

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-[19px] leading-[1.25]">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The prospect's local time, top right of the person page. */
export function LocalTime({ timeZone }: { timeZone: string | null }) {
  const now = useNow();
  if (!timeZone) return null;
  return (
    <div className="text-right">
      <div className="text-[26px] font-medium leading-none">{clockIn(timeZone, now)}</div>
      <div className="mt-1 text-[13px] text-muted">Their time</div>
    </div>
  );
}

const PHONE_LABEL = { direct: "Direct", mobile: "Mobile", main_line: "Main line" } as const;

function detailLabel(detail: ContactDetailView): string {
  const base =
    detail.channel === "email" ? (detail.owner === "company" ? "Shared inbox" : "Email") : PHONE_LABEL[detail.phoneKind ?? "direct"];
  if (detail.bad) return `${base}, marked wrong`;
  if (detail.newer) return `${base}, newer`;
  return base;
}

/**
 * Every contact detail in one row. Bad details are struck through; newer ones are marked.
 * A missing company main line is said out loud, since calls depend on it.
 */
export function ContactRow({ details }: { details: readonly ContactDetailView[] }) {
  const own = details.filter((d) => d.owner === "person");
  const mainLines = details.filter((d) => d.phoneKind === "main_line");
  const inboxes = details.filter((d) => d.owner === "company" && d.channel === "email");
  const item = (detail: ContactDetailView) => (
    <div key={detail.id} className="min-w-0">
      <dt className="text-[12.5px] text-muted">{detailLabel(detail)}</dt>
      <dd className={`break-words ${detail.bad ? "text-faint line-through" : ""}`}>{detail.value}</dd>
    </div>
  );
  return (
    <dl className="-mt-4 flex flex-wrap gap-x-8 gap-y-3.5 text-[14.5px]">
      {own.map(item)}
      {mainLines.length > 0 ? (
        mainLines.map(item)
      ) : (
        <div>
          <dt className="text-[12.5px] text-muted">Main line</dt>
          <dd className="text-muted">None in the scraper file</dd>
        </div>
      )}
      {inboxes.map(item)}
    </dl>
  );
}

/** Why someone on record has no enrollment, worded as the import results word it. */
export const UNENROLLED_SHORT = {
  person: "no personal email or mobile, and no usable company main line",
  company: "no usable main line or shared inbox",
} as const;

export const UNENROLLED_TEXT = {
  person: "There’s no personal email or mobile, and the company has no usable main line. Company details aren’t used for a decision maker’s email.",
  company: "The company has no usable main line or shared inbox.",
} as const;

/** One row per campaign, with the enrollment's outreach status. */
export function CampaignRows({
  enrollments,
  unenrolledReason,
  who,
  companyIsLead = false,
  calls,
  leads,
  controls,
  name,
}: {
  enrollments: readonly EnrollmentView[];
  unenrolledReason: UnenrolledReason;
  who: "person" | "company";
  companyIsLead?: boolean;
  /** Each enrollment's open calls, as the record's read gives them (ticket 15b). */
  calls?: RecordCalls;
  /** Each enrollment's read, its controls and sentence (ticket 17b), and the page's control requests. */
  leads: RecordControls;
  controls: Controls;
  /** Whose record this is, to label each control. */
  name: string;
}) {
  if (enrollments.length === 0) {
    return (
      <p className="py-4 text-[14px] text-muted">
        Not in any campaign.{unenrolledReason === "no_usable_channel" ? ` ${UNENROLLED_TEXT[who]}` : ""}
        {who === "person" && companyIsLead ? " The company is contacted through its shared inbox instead." : ""}
      </p>
    );
  }
  return (
    <ul>
      {enrollments.map((enrollment) => {
        // The enrollment's own read at the record's instant: its status, sentence and controls (ticket 17b).
        const lead = leads.leads.find((l) => l.id === enrollment.id) ?? null;
        const status = lead?.status ?? enrollment.status;
        return (
          <li key={enrollment.id} className="flex flex-col gap-2 border-line py-4 [&+&]:border-t">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">
                {enrollment.campaign.name}
                {lead?.campaignState.paused && <CampaignPausedMarker />}
              </span>
              <StatusBadge status={status} />
            </div>
            {lead && <LeadSentence lead={lead} userZone={leads.userZone} />}
            {/* A decline on a call and the path it took (ticket 16c), beside the status the server reads now. */}
            {calls?.declines
              .filter((d) => d.enrollmentId === enrollment.id)
              .map((d) => (
                <p key={`declined-${d.enrollmentId}`} className="text-[14px] text-ink-2 [overflow-wrap:anywhere]">
                  {declinedRecordLine(d, status)}
                </p>
              ))}
            {calls?.calls
              .filter((c) => c.enrollmentId === enrollment.id)
              .map((c) => {
                // Only the first sentence of an overdue callback is in the critical colour (council on 32454ea, F).
                const line = recordCallLine(c, calls.today);
                return (
                  <p key={c.taskId} className="text-[14px] text-ink-2 [overflow-wrap:anywhere]">
                    <span className={c.reason === "overdue" ? "text-crit" : ""}>{line.lead}</span>
                    {line.rest ? ` ${line.rest}` : ""}
                  </p>
                );
              })}
            {lead && <LeadControls lead={lead} userZone={leads.userZone} controls={controls} who={name} campaignName={enrollment.campaign.name} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Others at the company: status and role, linking to their own page. No quick actions. */
export function PeopleRows({ people }: { people: readonly ColleagueView[] }) {
  return (
    <ul>
      {people.map((person) => (
        <li key={person.id} className="flex flex-col gap-2 border-line py-4 [&+&]:border-t">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div className="min-w-0">
              <Link href={`/leads/people/${person.id}`} className="font-semibold no-underline hover:underline">
                {person.name}
              </Link>
              {person.title && <p className="text-[14px] text-ink-2">{person.title}</p>}
            </div>
            <div className="min-w-0 sm:max-w-[60%] sm:[&_li]:justify-end">
              <EnrollmentList
                enrollments={person.enrollments}
                empty={
                  person.unenrolledReason === "no_usable_channel"
                    ? `Not in a campaign: ${UNENROLLED_SHORT.person}`
                    : "Not in a campaign"
                }
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Each enrollment as its status and the campaign it belongs to, as on Leads rows. */
export function EnrollmentList({ enrollments, empty }: { enrollments: readonly EnrollmentView[]; empty: string }) {
  if (enrollments.length === 0) return <span className="text-[13px] text-muted">{empty}</span>;
  return (
    <ul className="flex flex-col gap-1.5">
      {enrollments.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-2">
          <StatusBadge status={e.status} />
          <span className="min-w-0 text-[13px] text-muted [overflow-wrap:anywhere]">{e.campaign.name}</span>
        </li>
      ))}
    </ul>
  );
}

export function RecordSkeleton() {
  return (
    <div className="flex max-w-[780px] flex-col gap-10" role="status" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-3">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-9 w-72" />
        <div className="skeleton h-5 w-96 max-w-full" />
      </div>
      <div className="flex gap-8">
        <div className="skeleton h-10 w-48" />
        <div className="skeleton h-10 w-40" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="skeleton h-6 w-32" />
        <div className="skeleton h-12 w-full" />
      </div>
    </div>
  );
}

/**
 * A clock-driven screen whose reads keep failing (ADR 0003 4.4.1, "Freshness"): what it shows stays,
 * with this notice and Try again; refreshing carries on by itself meanwhile.
 */
export function StaleNotice({ freshness, onRetry, retryRef, rescue }: { freshness: Freshness; onRetry: () => void; retryRef?: (el: HTMLButtonElement | null) => void; rescue?: number }) {
  const since = freshness.lastReadAt ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(freshness.lastReadAt)) : null;
  return (
    <div role="status" className="mt-4 flex flex-wrap items-center gap-3 rounded-box bg-pause-soft px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-[1_1_320px] text-base-content">
        This may be out of date: the last {freshness.failures} updates didn’t load{since ? `, so it shows the list as of ${since}` : ""}. It keeps trying.
      </span>
      <button type="button" ref={retryRef} data-rescue={rescue} className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
