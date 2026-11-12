import { useId, type ReactNode } from "react";
import { Link } from "wouter";
import type { ColleagueView, ContactDetailView, EnrollmentView, UnenrolledReason } from "../shared/api.ts";
import { Icon } from "./icons.tsx";
import { StatusBadge, enrollmentSentence } from "./status.tsx";
import { clockIn, useNow } from "./time.ts";

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-box bg-crit-soft px-4 py-3 text-[14px]">
      <span className="min-w-0 flex-[1_1_320px]">
        <b className="font-semibold text-crit">{title}</b> <span className="text-ink-2">{message}</span>
      </span>
      {onRetry && (
        <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onRetry}>
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
  const noMainLine = !details.some((d) => d.phoneKind === "main_line");
  return (
    <dl className="-mt-4 flex flex-wrap gap-x-8 gap-y-3.5 text-[14.5px]">
      {noMainLine && (
        <div>
          <dt className="text-[12.5px] text-muted">Main line</dt>
          <dd className="text-muted">None in the scraper file</dd>
        </div>
      )}
      {details.map((detail) => (
        <div key={detail.id} className="min-w-0">
          <dt className={`text-[12.5px] ${detail.newer && !detail.bad ? "font-semibold text-you" : "text-muted"}`}>
            {detailLabel(detail)}
          </dt>
          <dd className={`break-words ${detail.bad ? "text-faint line-through" : ""}`}>{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const UNENROLLED_TEXT = {
  person: "There’s no personal email or mobile, and the company has no main line. Company details aren’t used for a decision maker’s email.",
  company: "The company has no shared inbox or main line on record.",
} as const;

/** One row per campaign, with the enrollment's outreach status. */
export function CampaignRows({
  enrollments,
  unenrolledReason,
  who,
  companyIsLead = false,
}: {
  enrollments: readonly EnrollmentView[];
  unenrolledReason: UnenrolledReason;
  who: "person" | "company";
  companyIsLead?: boolean;
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
        const sentence = enrollmentSentence(enrollment.status);
        return (
          <li key={enrollment.id} className="flex flex-col gap-2 border-line py-4 [&+&]:border-t">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <span className="font-semibold">{enrollment.campaign.name}</span>
              <StatusBadge status={enrollment.status} />
            </div>
            {sentence && <p className="text-[14px] text-ink-2">{sentence}</p>}
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
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <Link href={`/leads/people/${person.id}`} className="font-semibold no-underline hover:underline">
              {person.name}
            </Link>
            <span className="flex flex-wrap gap-1.5">
              {person.enrollments.length > 0 ? (
                person.enrollments.map((e) => <StatusBadge key={e.id} status={e.status} />)
              ) : (
                <span className="text-[14px] text-muted">Not in a campaign</span>
              )}
            </span>
          </div>
          <p className="text-[14px] text-ink-2">
            {[person.title, person.unenrolledReason === "no_usable_channel" ? "No email or phone number to reach them" : ""]
              .filter(Boolean)
              .join(". ")}
          </p>
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
