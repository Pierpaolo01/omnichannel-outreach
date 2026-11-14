import { Link } from "wouter";
import type { PersonRecord, RecordCalls, RecordControls } from "../../shared/api.ts";
import type { Controls } from "../controls/useControls.ts";
import { Activity } from "../activity.tsx";
import { useControls } from "../controls/useControls.ts";
import { useLiveRead } from "../controls/useLiveRead.ts";
import { BackToLeads, CampaignRows, ContactRow, ErrorState, LocalTime, PeopleRows, RecordSkeleton, Section } from "../components.tsx";

export function PersonPage({ id }: { id: string }) {
  // Read live (ticket 17b): after a control's answer, on another tab's control and while visible.
  const { read, refresh } = useLiveRead<PersonRecord & RecordCalls & RecordControls>(`/api/people/${encodeURIComponent(id)}`);
  const targets = read.state === "ready" ? read.data.leads.map((l) => ({ kind: "lead" as const, id: l.id })) : [];
  const controls = useControls(targets, refresh);
  return (
    <div>
      <BackToLeads />
      {read.state === "loading" ? (
        <RecordSkeleton />
      ) : read.state === "error" ? (
        read.notFound ? (
          <NoSuchRecord />
        ) : (
          <ErrorState title="This record didn’t load." message={read.message} onRetry={() => void refresh()} />
        )
      ) : (
        <Person person={read.data} controls={controls} reads={read.reads} />
      )}
    </div>
  );
}

function Person({ person, controls, reads }: { person: PersonRecord & RecordCalls & RecordControls; controls: Controls; reads: number }) {
  const { company } = person;
  return (
    <article className="flex max-w-[780px] flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-1 text-[13.5px] text-muted">Decision maker</p>
          <h1 className="text-[34px] leading-[1.15] tracking-[-0.02em]">{person.name}</h1>
          <p className="mt-1 text-[16px] text-ink-2">
            {person.title ? `${person.title} at ` : ""}
            <Link href={`/leads?company=${company.id}`} className="font-semibold no-underline hover:underline">
              {company.name}
            </Link>
            {company.city ? `, ${company.city}` : ""}
          </p>
        </div>
        <LocalTime timeZone={person.timezone} />
      </header>

      <ContactRow details={person.contactDetails} />

      <Section title="Campaigns">
        <CampaignRows
          enrollments={person.enrollments}
          unenrolledReason={person.unenrolledReason}
          who="person"
          companyIsLead={person.companyIsLead}
          calls={person}
          leads={person}
          controls={controls}
          name={person.name}
        />
      </Section>

      {person.colleagues.length > 0 && (
        <Section title={`Others at ${company.name}`}>
          <PeopleRows people={person.colleagues} />
        </Section>
      )}

      <Activity path={`/api/people/${encodeURIComponent(person.id)}/activity`} reads={reads} />
    </article>
  );
}

export function NoSuchRecord() {
  return (
    <div className="max-w-[780px]">
      <h1 className="text-[30px] leading-[1.15]">No one found</h1>
      <p className="mt-2 text-muted">
        This record isn’t in the CRM. <Link href="/leads" className="text-base-content underline">Back to Leads</Link>.
      </p>
    </div>
  );
}
