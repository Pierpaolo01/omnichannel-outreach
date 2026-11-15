import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CampaignPauseRead, ControlAnswer, LeadControlApi, OutreachStatus, RecordLead } from "../../shared/api.ts";
import type { Controls } from "./useControls.ts";
import type { ControlTarget } from "./requests.ts";
import { campaignConfirmationChanged, confirmationChanged, openCampaignConfirmation, openLeadConfirmation, type CampaignConfirmation, type LeadConfirmation } from "./confirmation.ts";
import {
  CAMPAIGN_DONE,
  CONTROL_LABEL,
  CONTROL_PENDING,
  campaignConfirmText,
  controlEffectText,
  controlPreviewText,
  mayStillSendText,
  nextStepSentence,
  offeredControls,
  pausedBannerText,
  refusalOf,
  statusGroupCounts,
} from "./wording.ts";

/**
 * The in-page confirmation, as the daily-workspace prototype draws it (`.confirm`): what will happen, then the action and
 * Cancel. It is not a modal: focus moves to the action when it opens, Escape or Cancel closes it and returns focus to the
 * control that opened it.
 */
export function ConfirmStrip({
  text,
  action,
  onConfirm,
  onCancel,
  changed = null,
  busy = null,
}: {
  text: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** A newer read differs from the snapshot shown: said beside it, never changing what is sent. */
  changed?: string | null;
  /** Another press on the same lead or campaign is on its way: the action waits, and says why. */
  busy?: string | null;
}) {
  const textId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div
      role="group"
      aria-labelledby={textId}
      className="flex flex-wrap items-center gap-3 rounded-box bg-pause-soft px-4 py-3 text-[14px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <span id={textId} className="min-w-0 flex-[1_1_320px] text-base-content [overflow-wrap:anywhere]">
        {text}
        {changed && <span className="mt-1 block text-ink-2">{changed}</span>}
        {busy && <span className="mt-1 block text-ink-2">{busy}</span>}
      </span>
      <span className="flex flex-wrap gap-2">
        <button
          type="button"
          ref={confirmRef}
          // aria-disabled, not disabled: focus stays on the action while it waits (verifier B1 on 4363270).
          aria-disabled={busy !== null}
          className={`btn btn-primary btn-sm font-semibold ${busy !== null ? "cursor-not-allowed opacity-50" : ""}`}
          onClick={() => {
            if (busy === null) onConfirm();
          }}
        >
          {action}
        </button>
        <button type="button" className="btn btn-ghost btn-sm font-medium text-muted hover:text-base-content" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

/** What this page knows of a control on one target: on its way, its answer, or a press that could not be queued. */
function ControlStatus({
  controls,
  target,
  pendingText,
  effectText,
  unstored,
  onDismiss,
  focusRef,
}: {
  controls: Controls;
  target: ControlTarget;
  pendingText: (action: LeadControlApi, own: boolean) => string;
  effectText: (body: unknown, action: LeadControlApi) => string;
  unstored: boolean;
  onDismiss: () => void;
  focusRef: (el: HTMLElement | null) => void;
}) {
  const pending = controls.pending(target);
  const result = controls.result(target);
  if (pending) {
    const unconfirmed = controls.unconfirmed(target);
    return (
      <p role="status" className="flex flex-wrap items-center gap-3 rounded-field bg-pause-soft px-4 py-2.5 text-[14px] text-base-content">
        <span className="min-w-0 flex-[1_1_280px]">
          {pendingText(pending.action, result === null)}
          {unconfirmed ? " Not confirmed yet. It is being sent again, and it is applied only once." : ""}
        </span>
        {unconfirmed && (
          <button type="button" className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={() => controls.retryNow()}>
            Try again now
          </button>
        )}
      </p>
    );
  }
  if (unstored) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-field bg-crit-soft px-4 py-2.5 text-[14px]">
        <span className="min-w-0 flex-[1_1_280px] text-base-content">
          <b className="font-semibold text-crit">Not sent.</b> This device’s storage is full or blocked, so the change could not be kept while it is sent. Nothing was changed.
        </span>
        <button type="button" ref={focusRef} className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  if (!result) return null;
  if (result.kind === "refused") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-field bg-crit-soft px-4 py-2.5 text-[14px]">
        <span className="min-w-0 flex-[1_1_280px] text-base-content [overflow-wrap:anywhere]">
          <b className="font-semibold text-crit">{CONTROL_LABEL[result.entry.action]} was not applied.</b> {result.message}
        </span>
        <button type="button" ref={focusRef} className="btn btn-sm border-line-strong bg-base-100 font-medium" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <p role="status" tabIndex={-1} ref={focusRef} className="rounded-field bg-you-soft px-4 py-2.5 text-[14px] text-base-content outline-offset-2 [overflow-wrap:anywhere]">
      {effectText(result.body, result.entry.action)}
    </p>
  );
}

/** The controls the spec's user expects in a status, so a refusal of one is said where they would look for it. */
const EXPECTED = {
  queued: ["skip"],
  active: ["skip"],
  in_win_back: ["skip"],
  waiting_on_call: ["skip"],
  callback_scheduled: ["skip"],
  paused: [],
  replied: ["resume_from_next_step", "move_to_win_back"],
  stopped_manually: ["resume_from_next_step", "move_to_win_back"],
  interested_on_call: [],
  declined_on_call: [],
  sequence_finished_no_response: [],
  finished_no_usable_channel: [],
} as const satisfies Record<OutreachStatus, readonly LeadControlApi[]>;

/**
 * One campaign row's controls on the person or company-lead record (spec "Person page", 2): the plain sentence, what may
 * still be sent, the controls the read allows in this status, each confirmed in place with the read's preview, and what it
 * did from the answer's effect. A refused control is not offered; where the user expects it, the read's reason is said.
 */
export function LeadControls({ lead, userZone, controls, who, campaignName }: { lead: RecordLead; userZone: string; controls: Controls; who: string; campaignName: string }) {
  const target: ControlTarget = { kind: "lead", id: lead.id };
  // The confirmation open, as a snapshot of the read it opened on (council on 57d874f, item 1): what it shows and sends.
  const [opened, setOpened] = useState<LeadConfirmation | null>(null);
  const [unstored, setUnstored] = useState(false);
  const triggers = useRef(new Map<LeadControlApi, HTMLButtonElement>());
  const firstControl = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<"status" | null>(null);
  const [refocus, setRefocus] = useState(false);
  const offered = offeredControls(lead);
  const bulkPending = controls.bulkPending(target);
  const busy = controls.pending(target) !== null || bulkPending;
  const sentence = nextStepSentence(lead, userZone);
  // Before launch every control is refused for that one reason, which the sentence already says.
  const reasons = lead.campaignState.launched ? [...new Set(EXPECTED[lead.status].map((a) => refusalOf(lead, a)).filter((r): r is string => r !== null && r !== sentence))] : [];

  // A confirmation whose control the read no longer allows (another tab, the worker) closes, and focus stays in the row;
  // one still allowed keeps its snapshot, and says when the row changed.
  if (opened !== null && !offered.some((c) => c.action === opened.action)) {
    setOpened(null);
    setRefocus(true);
  }
  useEffect(() => {
    if (refocus) firstControl.current?.focus();
  }, [refocus]);

  const confirm = (snapshot: LeadConfirmation) => {
    focusNext.current = "status";
    // The snapshot's precondition, never the newest read's: a step that changed since is the server's to refuse.
    void controls.press(target, snapshot.action, snapshot.expect).then((out) => {
      // A press refused here as busy keeps its confirmation open, saying why; it is never dropped without a word.
      if (!out.ok && out.why === "busy") {
        focusNext.current = null;
        return;
      }
      setOpened(null);
      setUnstored(!out.ok && out.why === "unstored");
    });
  };
  const placeStatus = (el: HTMLElement | null) => {
    if (el && focusNext.current === "status") {
      focusNext.current = null;
      el.focus();
    }
  };
  const label = (a: LeadControlApi) => `${CONTROL_LABEL[a]}: ${who} in ${campaignName}`;

  return (
    <>
      {mayStillSendText(lead.mayStillSend) && <p className="text-[14px] text-ink-2">{mayStillSendText(lead.mayStillSend)}</p>}
      {reasons.map((r) => (
        <p key={r} className="text-[13.5px] text-muted [overflow-wrap:anywhere]">
          {r}
        </p>
      ))}
      {bulkPending && controls.pending(target) === null && (
        <p role="status" className="rounded-field bg-pause-soft px-4 py-2.5 text-[14px] text-base-content">
          A bulk change from Leads that includes this campaign enrollment is on its way. These controls wait until it is answered.
        </p>
      )}
      <ControlStatus
        controls={controls}
        target={target}
        pendingText={(a) => `${CONTROL_PENDING[a]}…`}
        effectText={(body) => {
          const answer = body as ControlAnswer | null;
          return answer?.effect ? controlEffectText(answer.effect) : "Done.";
        }}
        unstored={unstored}
        onDismiss={() => {
          controls.dismiss(target);
          setUnstored(false);
          firstControl.current?.focus();
        }}
        focusRef={placeStatus}
      />
      {offered.length > 0 && !opened && (
        <div className="flex flex-wrap gap-1.5">
          {offered.map((c, i) => (
            <button
              key={c.action}
              type="button"
              ref={(el) => {
                if (el) triggers.current.set(c.action, el);
                if (i === 0) firstControl.current = el;
              }}
              aria-label={label(c.action)}
              disabled={busy}
              className={`btn btn-sm border-line-strong bg-base-100 font-medium ${c.action === "stop" ? "text-crit" : ""}`}
              onClick={() => {
                controls.dismiss(target);
                setUnstored(false);
                setRefocus(false);
                setOpened(openLeadConfirmation(lead, c.action));
              }}
            >
              {CONTROL_LABEL[c.action]}
            </button>
          ))}
        </div>
      )}
      {opened && (
        <ConfirmStrip
          text={controlPreviewText(opened.control, opened.campaignState, userZone)}
          action={CONTROL_LABEL[opened.action]}
          changed={confirmationChanged(opened, lead) ? ROW_CHANGED : null}
          busy={busy ? "Another change to this lead is on its way." : null}
          onConfirm={() => confirm(opened)}
          onCancel={() => {
            const back = triggers.current.get(opened.action);
            const action = opened.action;
            setOpened(null);
            // The trigger is drawn again once the strip closes.
            requestAnimationFrame(() => (triggers.current.get(action) ?? back ?? firstControl.current)?.focus());
          }}
        />
      )}
    </>
  );
}

/** Beside a confirmation whose row a newer read changed: what it shows, and sends, is still what was opened. */
export const ROW_CHANGED = "This row changed since you opened this.";

/** The plain next-step sentence under a campaign row's status (one wording function, `nextStepSentence`). */
export function LeadSentence({ lead, userZone }: { lead: RecordLead; userZone: string }) {
  return <p className="text-[14px] text-ink-2 [overflow-wrap:anywhere]">{nextStepSentence(lead, userZone)}</p>;
}

/** "(campaign paused)", beside a campaign's name on a record's row, as the prototype marks it. */
export function CampaignPausedMarker() {
  return <span className="text-[13px] font-normal text-muted">(campaign paused)</span>;
}

/**
 * The Paused banner (spec "Pause and resume"): the date the campaign was paused, the count of its leads in each status
 * group, and what may still be sent, from the campaign's read. **Provisional** (ticket 17b): no prototype draws it; this
 * is the most restrained form, the prototype's `pause-soft` strip.
 */
export function PausedBanner({ read, compact = false }: { read: CampaignPauseRead; compact?: boolean }) {
  const id = useId();
  if (!read.pause.paused) return null;
  const { title, provider } = pausedBannerText(read, read.userZone);
  const groups = statusGroupCounts(read.statusCounts);
  return (
    <section aria-labelledby={id} className={`rounded-box bg-pause-soft ${compact ? "px-3.5 py-2.5 text-[13.5px]" : "px-4 py-3 text-[14px]"}`}>
      <h2 id={id} className={`font-semibold text-pause ${compact ? "text-[13.5px]" : "text-[14px]"}`}>
        {title}
      </h2>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-base-content" aria-label="Leads in each status">
        {groups.map((g) => (
          <div key={g.group} className="flex gap-1.5">
            <dt className="text-ink-2">{g.label}</dt>
            <dd className="font-semibold tabular-nums">{g.count}</dd>
          </div>
        ))}
      </dl>
      {provider && <p className="mt-1 text-ink-2">{provider}</p>}
    </section>
  );
}

/** A campaign's Pause campaign or Resume campaign, with its in-page confirmation and its state, wherever the campaign is shown whole. */
export function CampaignPauseControl({
  campaignId,
  name,
  read,
  controls,
  layout,
}: {
  campaignId: string;
  name: string;
  read: CampaignPauseRead;
  controls: Controls;
  /** Where the button and, when there is any, the confirmation or the control's state go: the page's header, or a list row. */
  layout: (button: ReactNode, strip: ReactNode) => ReactNode;
}) {
  const target: ControlTarget = { kind: "campaign", id: campaignId };
  // The confirmation open, as a snapshot of the read it opened on (council on 57d874f, item 1).
  const [opened, setOpened] = useState<CampaignConfirmation | null>(null);
  const confirming = opened?.action ?? null;
  const [unstored, setUnstored] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<"status" | null>(null);
  const allowed = read.controls.find((c) => c.allowed);
  const action = allowed?.action ?? null;
  const busy = controls.pending(target) !== null;
  // A confirmation of an action the read no longer allows (another tab paused or resumed the campaign) closes, so the
  // action the read allows now is never left disabled behind it (review bot on 07fab27, P2).
  if (confirming !== null && confirming !== action) {
    setOpened(null);
    setRefocus(true);
  }
  // Focus goes back to the campaign's control once a confirmation another tab's change closed (verifier F2 on 8a1732a).
  useEffect(() => {
    if (refocus) triggerRef.current?.focus();
  }, [refocus]);
  const button = action ? (
    <button
      type="button"
      ref={triggerRef}
      disabled={busy || opened !== null}
      aria-label={`${action === "pause" ? "Pause campaign" : "Resume campaign"}: ${name}`}
      className="btn border-line-strong bg-base-100 font-medium"
      onClick={() => {
        controls.dismiss(target);
        setUnstored(false);
        setRefocus(false);
        setOpened(openCampaignConfirmation(read, action));
      }}
    >
      {action === "pause" ? "Pause campaign" : "Resume campaign"}
    </button>
  ) : null;
  const placeStatus = (el: HTMLElement | null) => {
    if (el && focusNext.current === "status") {
      focusNext.current = null;
      el.focus();
    }
  };
  const showing = opened !== null || busy || unstored || controls.result(target) !== null;
  const strip = !showing ? null : (
      <div className="flex flex-col gap-2">
      {opened && (
        <ConfirmStrip
          text={campaignConfirmText(opened.action, name, opened.read)}
          action={opened.action === "pause" ? "Pause campaign" : "Resume campaign"}
          changed={campaignConfirmationChanged(opened, read) ? "This campaign changed since you opened this." : null}
          busy={busy ? "Another change to this campaign is on its way." : null}
          onConfirm={() => {
            const snapshot = opened;
            focusNext.current = "status";
            // The snapshot's pause read: the server applies it only while the campaign's pause is still as it was then.
            void controls.press(target, snapshot.action, snapshot.expect).then((out) => {
              // A press refused here as busy keeps its confirmation open, saying why; never dropped without a word.
              if (!out.ok && out.why === "busy") {
                focusNext.current = null;
                return;
              }
              setOpened(null);
              setUnstored(!out.ok && out.why === "unstored");
            });
          }}
          onCancel={() => {
            setOpened(null);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      )}
      <ControlStatus
        controls={controls}
        target={target}
        pendingText={(a) => (a === "pause" ? "Pausing the campaign…" : "Resuming the campaign…")}
        // History only: what may still be sent is a present state, said by the current read's banner, never by this line
        // (verifier B3 on 8a1732a).
        effectText={(_body, a) => (a === "pause" || a === "resume" ? CAMPAIGN_DONE[a] : "Done.")}
        unstored={unstored}
        onDismiss={() => {
          controls.dismiss(target);
          setUnstored(false);
          triggerRef.current?.focus();
        }}
        focusRef={placeStatus}
      />
      </div>
  );
  return <>{layout(button, strip)}</>;
}
