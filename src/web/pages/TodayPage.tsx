import { greeting, todayHeading, useNow } from "../time.ts";

/** Today. The call list and attention items arrive with the calling and sending tickets. */
export function TodayPage() {
  const now = useNow();
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-7">
        <div>
          <p className="mb-1.5 text-[15px] text-muted">{todayHeading(now)}</p>
          <h1 className="text-[38px] leading-[1.15] tracking-[-0.02em]">{greeting(now)}</h1>
          <p className="mt-2 max-w-[46ch] text-[18px] text-ink-2">Nothing to call right now.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-12 pt-7 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-2 text-[19px]">Up next</h2>
          <p className="py-3.5 text-[14px] text-muted">No calls on your list. Calls appear here once a launched campaign reaches a call step.</p>
        </section>
        <section>
          <h2 className="mb-3.5 text-[19px]">Needs attention</h2>
          <p className="py-3.5 text-[14px] text-muted">Nothing needs you.</p>
        </section>
      </div>
    </div>
  );
}
