import { useEffect, useId, useRef } from "react";
import type { BulkAddAnswer, BulkControlAction, BulkControlAnswer, CampaignListItem } from "../../shared/api.ts";
import type { Bulk } from "./useBulk.ts";
import { addResultText, bulkPendingText, controlResultText } from "./wording.ts";

const BAR_BUTTON = "btn btn-sm border-[color-mix(in_srgb,var(--color-band-ink)_35%,transparent)] bg-transparent font-medium text-band-ink hover:border-band-ink hover:bg-transparent disabled:border-[color-mix(in_srgb,var(--color-band-ink)_20%,transparent)] disabled:bg-transparent disabled:text-band-muted";

/**
 * The bulk bar, as the daily-workspace prototype draws it (`.bulk`): the count selected, Add to campaign…, Pause, Resume,
 * Stop, and Clear selection, on the dark band, sticky while the table scrolls.
 */
export function BulkBar({
  count,
  campaigns,
  busy,
  onAction,
  onAdd,
  onClear,
}: {
  count: number;
  campaigns: readonly Pick<CampaignListItem, "id" | "name">[];
  /** A bulk change is on its way from this device: the actions wait. */
  busy: boolean;
  onAction: (action: BulkControlAction, opener: HTMLElement) => void;
  onAdd: (campaignId: string, opener: HTMLElement) => void;
  onClear: () => void;
}) {
  const labelId = useId();
  return (
    <div role="toolbar" aria-labelledby={labelId} className="sticky top-3 z-[4] mt-4 flex flex-wrap items-center gap-2.5 rounded-xl bg-band px-3.5 py-2.5 text-[14px] text-band-ink shadow-[0_10px_30px_-12px_rgba(21,26,45,0.5)]">
      <b id={labelId} className="mr-1.5 font-semibold">
        {count} selected
      </b>
      <select
        aria-label="Add to campaign"
        className="select select-sm w-auto max-w-full border-[color-mix(in_srgb,var(--color-band-ink)_35%,transparent)] bg-band text-band-ink"
        value=""
        disabled={busy || campaigns.length === 0}
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value, e.target);
        }}
      >
        <option value="">Add to campaign…</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {(["pause", "resume", "stop"] as const).map((action) => (
        <button key={action} type="button" className={BAR_BUTTON} disabled={busy} onClick={(e) => onAction(action, e.currentTarget)}>
          {action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Stop"}
        </button>
      ))}
      <button type="button" className={`${BAR_BUTTON} ml-auto`} onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}

/**
 * A bulk action's in-page confirmation (the prototype's `.confirm`): the server's preview of its scope and what it will
 * do, the action and Cancel. A preview with nothing to do offers Close only. Not a modal: focus moves to the action (or
 * Close) when it opens, and Escape or Cancel returns it to the control that opened it.
 */
export function BulkConfirm({ text, action, canConfirm, onConfirm, onCancel }: { text: string; action: string; canConfirm: boolean; onConfirm: () => void; onCancel: () => void }) {
  const textId = useId();
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), [text]);
  return (
    <div
      role="group"
      aria-labelledby={textId}
      className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-pause-soft px-4 py-3 text-[14px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <span id={textId} className="min-w-0 flex-[1_1_320px] text-base-content [overflow-wrap:anywhere]">
        {text}
      </span>
      <span className="flex flex-wrap gap-2">
        {canConfirm && (
          <button type="button" ref={first} className="btn btn-primary btn-sm font-semibold" onClick={onConfirm}>
            {action}
          </button>
        )}
        <button type="button" ref={canConfirm ? undefined : first} className="btn btn-ghost btn-sm font-medium text-muted hover:text-base-content" onClick={onCancel}>
          {canConfirm ? "Cancel" : "Close"}
        </button>
      </span>
    </div>
  );
}

/** The preview being read, or failing to load. */
export function BulkChecking({ error, onRetry, onCancel }: { error: string | null; onRetry: () => void; onCancel: () => void }) {
  if (error !== null) {
    return (
      <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-crit-soft px-4 py-3 text-[14px]">
        <span className="min-w-0 flex-[1_1_320px]">
          <b className="font-semibold text-crit">What this would do didn’t load.</b> <span className="text-ink-2">{error} Nothing was changed.</span>
        </span>
        <span className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost btn-sm font-medium text-muted hover:text-base-content" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
    );
  }
  return (
    <p role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-pause-soft px-4 py-3 text-[14px] text-base-content">
      <span className="loading loading-spinner loading-xs text-pause" aria-hidden="true" />
      Checking what this would do…
    </p>
  );
}

/**
 * What this device knows of a bulk change: on its way, what the server did (lead by lead, in the past tense, from the
 * answer), a refusal of the whole bulk, or a press storage would not keep. Each takes focus when it appears.
 */
export function BulkStatus({ bulk, unstored, onDismissUnstored, onDismissed }: { bulk: Bulk; unstored: boolean; onDismissUnstored: () => void; /** Focus goes on after a Dismiss. */ onDismissed: () => void }) {
  const pending = bulk.pending();
  const result = bulk.result;
  const ref = useRef<HTMLElement | null>(null);
  const shown = pending ? `pending:${pending.bulkId}` : unstored ? "unstored" : result ? `${result.kind}:${result.press.bulkId}` : null;
  useEffect(() => {
    if (shown !== null) ref.current?.focus();
  }, [shown]);
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  if (pending) {
    const unconfirmed = bulk.unconfirmed();
    return (
      <p role="status" tabIndex={-1} ref={setRef} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-pause-soft px-4 py-3 text-[14px] text-base-content outline-offset-2">
        <span className="min-w-0 flex-[1_1_280px]">
          {bulkPendingText(pending.action, pending.campaign)}
          {unconfirmed ? " Not confirmed yet. It is being sent again, and each change is applied only once." : ""}
        </span>
        {unconfirmed && (
          <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => bulk.retryNow()}>
            Try again now
          </button>
        )}
      </p>
    );
  }
  if (unstored) {
    return (
      <div role="alert" tabIndex={-1} ref={setRef} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-crit-soft px-4 py-3 text-[14px] outline-offset-2">
        <span className="min-w-0 flex-[1_1_280px] text-base-content">
          <b className="font-semibold text-crit">Not sent.</b> This device’s storage is full or blocked, so the change could not be kept while it is sent. Nothing was changed.
        </span>
        <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => {
            onDismissUnstored();
            onDismissed();
          }}>
          Dismiss
        </button>
      </div>
    );
  }
  if (!result) return null;
  if (result.kind === "refused") {
    return (
      <div role="alert" tabIndex={-1} ref={setRef} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-crit-soft px-4 py-3 text-[14px] outline-offset-2">
        <span className="min-w-0 flex-[1_1_280px] text-base-content [overflow-wrap:anywhere]">
          <b className="font-semibold text-crit">Nothing was changed.</b> {result.message}
        </span>
        <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => {
          bulk.dismiss();
          onDismissed();
        }}>
          Dismiss
        </button>
      </div>
    );
  }
  const answer = result.body as BulkControlAnswer | BulkAddAnswer;
  const { summary, refused } = answer.action === "add" ? addResultText(answer) : controlResultText(answer, result.press.labels);
  return (
    <div role="status" tabIndex={-1} ref={setRef} className="mt-3 flex flex-wrap items-start gap-3 rounded-xl bg-you-soft px-4 py-3 text-[14px] text-base-content outline-offset-2">
      <div className="min-w-0 flex-[1_1_320px] [overflow-wrap:anywhere]">
        <p className="font-semibold">{summary}</p>
        {refused.length > 0 && (
          <>
            <p className="mt-1 text-ink-2">{answer.action === "add" ? "Not added:" : "Not changed:"}</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-ink-2">
              {refused.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <button type="button" className="btn btn-ghost btn-sm font-medium text-muted hover:text-base-content" onClick={() => {
          bulk.dismiss();
          onDismissed();
        }}>
        Dismiss
      </button>
    </div>
  );
}
