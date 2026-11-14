import { Link } from "wouter";
import type { CallQueueItem, TodayView } from "../../shared/api.ts";
import { useLiveToday } from "../calls/useLiveToday.ts";
import { CAPACITY_USED, attentionItems, dateHeading, reasonLine, todayLede, zonePlace } from "../calls/wording.ts";
import { ErrorState, StaleNotice } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { greeting, todayHeading, useNow } from "../time.ts";
import { useFocusRescue } from "../focusRescue.ts";

const TONE = { muted: "text-muted", pause: "text-pause", crit: "text-crit" } as const;
const DOT = { crit: "bg-crit", pause: "bg-pause", end: "bg-end" } as const;

/** Today, the landing page: the date, today's calls and Needs attention, as the server reports them. */
export function TodayPage() {
  const now = useNow();
  const live = useLiveToday();
  const rescue = useFocusRescue();
  const view = live.data?.today ?? null;
  const attention = live.data?.attention ?? null;
  return (
    <div ref={rescue}>
      <div className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-7">
        <div>
          <p className="mb-1.5 text-[15px] text-muted">{view ? dateHeading(view.date, now, view.userZone) : todayHeading(now)}</p>
          <h1 className="text-[38px] leading-[1.15] tracking-[-0.02em]">{greeting(now)}</h1>
          {view ? (
            <p className="mt-2 max-w-[46ch] text-[18px] text-ink-2">
              {todayLede(view.readyNow, view.laterToday)}
              {view.capacityReached ? ` ${CAPACITY_USED}` : ""}
            </p>
          ) : live.error === null ? (
            <div role="status" aria-label="Loading today’s calls" className="skeleton mt-3 h-6 w-80 max-w-full" />
          ) : null}
        </div>
        {view && view.readyNow > 0 && (
          <Link href="/calls" data-rescue="5" className="btn btn-primary h-auto gap-2.5 rounded-[12px] px-[22px] py-3.5 text-[16px] font-semibold">
            <Icon name="call" />
            Start calling
          </Link>
        )}
      </div>
      {live.freshness.stale && <StaleNotice freshness={live.freshness} onRetry={live.retry} rescue={2} />}
      <div className="grid grid-cols-1 gap-12 pt-7 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section aria-labelledby="up-next">
          <h2 id="up-next" className="mb-2 text-[19px]">
            Up next
          </h2>
          {view === null && live.error !== null ? (
            <ErrorState title="Today’s calls didn’t load." message={live.error} onRetry={live.retry} rescue={2} />
          ) : view === null ? (
            <div role="status" aria-busy="true" aria-label="Loading up next" className="flex flex-col gap-3 py-3">
              <div className="skeleton h-12 w-full" />
              <div className="skeleton h-12 w-full" />
            </div>
          ) : (
            <UpNext view={view} />
          )}
        </section>
        <section aria-labelledby="needs-attention">
          <h2 id="needs-attention" className="mb-3.5 text-[19px]">
            Needs attention
          </h2>
          {attention === null && live.error !== null ? (
            <ErrorState title="Needs attention didn’t load." message={live.error} onRetry={live.retry} rescue={2} />
          ) : attention === null ? (
            <div role="status" aria-busy="true" aria-label="Loading needs attention" className="skeleton h-20 w-full" />
          ) : (
            <Attention items={attentionItems(attention, view?.userZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, view)} />
          )}
        </section>
      </div>
    </div>
  );
}

function UpNext({ view }: { view: TodayView }) {
  const ready = view.upNext.filter((x) => x.bucket === "ready_now");
  const later = view.upNext.filter((x) => x.bucket === "later_today");
  if (ready.length === 0 && later.length === 0) {
    return <p className="py-3.5 text-[14px] text-muted">{view.capacityReached ? CAPACITY_USED : "No calls on your list. Calls appear here once a launched campaign reaches a call step."}</p>;
  }
  return (
    <>
      {ready.length > 0 ? (
        <ul>
          {ready.map((x) => (
            <Row key={x.taskId} item={x} userZone={view.userZone} today={view.date} />
          ))}
        </ul>
      ) : (
        <p className="py-3.5 text-[14px] text-muted">Nothing to call right now.</p>
      )}
      {later.length > 0 && (
        <p className="mt-3.5 text-[13px] text-muted">
          Later today: {later.map((x) => `${x.person?.name ?? x.company.name} (${lower(reasonLine(x, view.userZone, view.date).text)})`).join("; ")}.
        </p>
      )}
    </>
  );
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function Row({ item, userZone, today }: { item: CallQueueItem; userZone: string; today: string }) {
  const why = reasonLine(item, userZone, today);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-line py-3.5 [&+&]:border-t">
      <div className="min-w-0">
        <div className="font-semibold [overflow-wrap:anywhere]">{item.person?.name ?? item.company.name}</div>
        <div className="text-[13px] text-muted [overflow-wrap:anywhere]">{item.company.name}</div>
        <div className={`mt-0.5 text-[13px] font-medium ${TONE[why.tone]}`}>{why.text}</div>
      </div>
      <div className="text-right text-[13px] text-muted">
        <b className="block text-[17px] font-medium text-base-content">{item.localTime}</b>
        {zonePlace(item.zone)}
      </div>
    </li>
  );
}

function Attention({ items }: { items: ReturnType<typeof attentionItems> }) {
  if (items.length === 0) return <p className="py-3.5 text-[14px] text-muted">Nothing needs you.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-field border border-line bg-base-100 px-4 py-3.5">
          <span aria-hidden="true" className={`mt-[7px] size-[9px] rounded-full ${DOT[i.tone]}`} />
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <b className="font-semibold">{i.title}</b>
            <p className="mt-0.5 text-[13.5px] text-muted">{i.body}</p>
          </div>
          <div className="col-start-2 mt-2">
            <Link href={i.action?.href ?? "/campaigns"} className="btn btn-sm border-line-strong bg-base-100 font-medium">
              {i.action?.label ?? "Open campaigns"}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
