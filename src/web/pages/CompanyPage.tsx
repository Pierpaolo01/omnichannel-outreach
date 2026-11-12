import type { CompanyRecord } from "../../shared/api.ts";
import { useApi } from "../api.ts";
import { BackToLeads, CampaignRows, ContactRow, ErrorState, LocalTime, PeopleRows, RecordSkeleton, Section } from "../components.tsx";
import { NoSuchRecord } from "./PersonPage.tsx";

/** A company lead's record: the company contacted through its own details. */
export function CompanyPage({ id }: { id: string }) {
  const { result, retry } = useApi<CompanyRecord>(`/api/companies/${encodeURIComponent(id)}`);
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
      ) : (
        <Company company={result.data} />
      )}
    </div>
  );
}

function Company({ company }: { company: CompanyRecord }) {
  return (
    <article className="flex max-w-[780px] flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-1 text-[13.5px] text-muted">{company.enrollments.length > 0 ? "Company lead" : "Company"}</p>
          <h1 className="text-[34px] leading-[1.15] tracking-[-0.02em]">{company.name}</h1>
          <p className="mt-1 text-[16px] text-ink-2">
            {company.people.length > 0 ? "Company" : "No named decision maker"}
            {company.city ? `, ${company.city}` : ""}
          </p>
        </div>
        <LocalTime timeZone={company.timezone} />
      </header>

      <ContactRow details={company.contactDetails} />

      <Section title="Campaigns">
        <CampaignRows enrollments={company.enrollments} unenrolledReason={company.unenrolledReason} who="company" />
      </Section>

      {company.people.length > 0 && (
        <Section title="People on record">
          <PeopleRows people={company.people} />
        </Section>
      )}
    </article>
  );
}
