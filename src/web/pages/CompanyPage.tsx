import { Redirect } from "wouter";
import type { CompanyRecord, RecordCalls } from "../../shared/api.ts";
import { Activity } from "../activity.tsx";
import { useApi } from "../api.ts";
import { BackToLeads, CampaignRows, ContactRow, ErrorState, LocalTime, PeopleRows, RecordSkeleton, Section } from "../components.tsx";
import { NoSuchRecord } from "./PersonPage.tsx";

/**
 * A company lead's record: the company contacted through its own details. A company that is not
 * a lead has no page of its own; its record is Leads filtered to the company (principal, 12 Nov 2026).
 */
export function CompanyPage({ id }: { id: string }) {
  const { result, retry } = useApi<CompanyRecord & RecordCalls>(`/api/companies/${encodeURIComponent(id)}`);
  return (
    <div>
      <BackToLeads />
      {result.state === "loading" ? (
        <RecordSkeleton />
      ) : result.state === "error" ? (
        result.notFound ? (
          <NoSuchRecord />
        ) : (
          <ErrorState title="This record didn’t load." message={result.message} onRetry={retry} />
        )
      ) : result.data.enrollments.length === 0 && result.data.people.length > 0 ? (
        <Redirect to={`/leads?company=${result.data.id}`} replace />
      ) : (
        <Company company={result.data} />
      )}
    </div>
  );
}

function Company({ company }: { company: CompanyRecord & RecordCalls }) {
  return (
    <article className="flex max-w-[780px] flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-1 text-[13.5px] text-muted">{company.enrollments.length > 0 ? "Company lead" : "Company"}</p>
          <h1 className="text-[34px] leading-[1.15] tracking-[-0.02em]">{company.name}</h1>
          <p className="mt-1 text-[16px] text-ink-2">
            {[company.people.length > 0 ? "" : "No named decision maker", company.city].filter(Boolean).join(", ")}
          </p>
        </div>
        <LocalTime timeZone={company.timezone} />
      </header>

      {company.people.length > 0 && company.enrollments.length > 0 && (
        <p className="-mt-6 max-w-[60ch] text-[14px] text-ink-2">{companyLeadNote(company)}</p>
      )}

      <ContactRow details={company.contactDetails} />

      <Section title="Campaigns">
        <CampaignRows enrollments={company.enrollments} unenrolledReason={company.unenrolledReason} who="company" calls={company} />
      </Section>

      {company.people.length > 0 && (
        <Section title="People on record">
          <PeopleRows people={company.people} />
        </Section>
      )}

      {company.enrollments.length > 0 && <Activity path={`/api/companies/${encodeURIComponent(company.id)}/activity`} />}
    </article>
  );
}

/**
 * Why a company with decision makers on record is a company lead. It was enrolled while none of
 * them could be reached; a later import can make one reachable, and the company lead carries on
 * (whether it should end then is with the principal), so the note follows what is true now.
 */
function companyLeadNote(company: CompanyRecord): string {
  // A colleague is reachable when enrolled or holding a usable channel: then no reason is given.
  const reachable = company.people.filter((p) => p.unenrolledReason === null).length;
  if (reachable === 0) return "None of its decision makers can be reached directly, so the company is contacted through its shared inbox.";
  const who = company.people.length === 1 ? "Its decision maker" : `${reachable} of its ${company.people.length} decision makers`;
  return `It is contacted through its shared inbox as a company lead. ${who} can now be reached too; their campaigns are under People on record.`;
}
