import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import type { CallsView, CallTaskView, CampaignMeasures, LeadSearchResult } from "../../src/shared/api.ts";
import { EngineHarness } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";

/**
 * A small world for the campaign measures (ticket 22): one campaign with an email track of two steps, an SMS track of one
 * text and a phone track, all starting at launch, on the fake providers. Every name, address and number is fictitious.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Monday 2 November 2026, 09:00 London (GMT). */
export const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
export const SMS_NUMBER = "+447700900001";

const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const text = (id: string, waitDays = 0): StepDefinition => ({ ...email(id, waitDays), subject: "" });
export const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 5,
  emailPool: ["inbox-a"],
  smsPool: [SMS_NUMBER],
  callScript: "Ask who looks after new patient bookings.",
  tracks: [
    { id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1"), email("s2", 1)], start: { kind: "entry" }, removed: false },
    { id: "x1", channel: "sms", branch: "main", window: ALWAYS, steps: [text("t1")], start: { kind: "entry" }, removed: false },
    { id: "p1", channel: "call", branch: "main", window: ALWAYS, steps: [{ ...email("c1"), subject: "", body: "" }], start: { kind: "entry" }, removed: false },
  ],
};
export const EMAIL_ONLY: CampaignDefinition = { ...DEFINITION, smsPool: [], tracks: [DEFINITION.tracks[0]!] };

export const HARBOUR = business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" });
export const KESTREL = business({ business_id: "b2", business_name: "Kestrel Dental", phone_e164: "+442079460201" });
export const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", dial_phone: "+447700900101", dial_phone_type: "mobile" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example", dial_phone: "+447700900102", dial_phone_type: "mobile" }),
  person({ person_id: "p3", business_id: "b1", full_name: "Sam Reed", email: "sam@harbour.example", dial_phone: "+447700900103", dial_phone_type: "mobile" }),
  person({ person_id: "p4", business_id: "b1", full_name: "Ivo Marsh", email: "ivo@harbour.example", dial_phone: "+447700900104", dial_phone_type: "mobile" }),
];
export const OTHERS = [
  person({ person_id: "p5", business_id: "b2", full_name: "Rae Lund", email: "rae@kestrel.example" }),
  person({ person_id: "p6", business_id: "b2", full_name: "Lea Park", email: "lea@kestrel.example" }),
];

export interface MeasuresWorld {
  readonly h: EngineHarness;
  readonly campaignId: string;
  readonly lead: (name: string) => string;
  readonly measures: (campaignId?: string) => Promise<CampaignMeasures>;
  readonly log: (name: string, outcome: string, extra?: Record<string, unknown>) => Promise<number>;
  readonly control: (name: string, action: string) => Promise<number>;
}

let requests = 0;

/** The campaign, imported and launched at Monday 09:00 with the providers' fakes set up by `prepare` before launch. */
/** Weekdays, 09:00 to 17:00: the browser scenarios launch at 07:00, so nothing goes out until the window opens. */
export const WEEKDAYS_9_TO_17 = [1, 2, 3, 4, 5].map((day) => ({ day, start: 9, end: 17 }));

export async function measuresWorld(prepare: (h: EngineHarness) => void = () => undefined, options: { readonly start?: number; readonly weekdayHours?: boolean } = {}): Promise<MeasuresWorld> {
  const h = new EngineHarness({
    start: options.start ?? MONDAY_9,
    accounts: [{ id: "inbox-a", capacity: 500, gapMs: MIN, k: 5, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    sms: { numbers: [{ id: SMS_NUMBER, capacity: 500, gapMs: MIN, k: 5, healthy: true, resetZone: "Europe/London" }] },
  });
  prepare(h);
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
  const { campaign } = await h.createCampaign("Clinics", { businesses: [HARBOUR], people: PEOPLE });
  await h.defineSequence(campaign.id, options.weekdayHours ? { ...DEFINITION, tracks: DEFINITION.tracks.map((t) => ({ ...t, window: WEEKDAYS_9_TO_17 })) } : DEFINITION);
  const rows = async () => (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows;
  const byName = new Map((await rows()).map((r) => [r.name, r.enrollments.find((e) => e.campaign.id === campaign.id)?.id ?? ""]));
  const lead = (name: string) => byName.get(name) ?? "";
  const measures = async (id = campaign.id) => {
    const res = await h.request<CampaignMeasures>("GET", `/api/campaigns/${id}/measures`);
    if (res.status !== 200) throw new Error(`measures answered ${res.status}`);
    return res.body;
  };
  const log = async (name: string, outcome: string, extra: Record<string, unknown> = {}) => {
    const item = (await h.request<CallsView>("GET", "/api/calls")).body.readyNow.find((x) => x.enrollmentId === lead(name));
    if (!item) throw new Error(`no listed call for ${name}`);
    const view = (await h.request<CallTaskView>("GET", `/api/call-tasks/${item.taskId}`)).body;
    const numberId = view.numbers.find((n) => !n.bad)?.detailId;
    return (await h.request("POST", `/api/call-tasks/${item.taskId}/outcome`, { requestId: `log-${++requests}`, outcome, numberId, note: "", ...extra })).status;
  };
  const control = async (name: string, action: string) => (await h.request("POST", `/api/enrollments/${lead(name)}/controls`, { requestId: `control-${++requests}`, action })).status;
  return { h, campaignId: campaign.id, lead, measures, log, control };
}

export async function launch(world: MeasuresWorld): Promise<void> {
  const res = await world.h.launch(world.campaignId);
  if (res.status !== 200) throw new Error(`launch answered ${res.status}`);
}
