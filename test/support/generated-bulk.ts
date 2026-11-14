import type { BulkRules } from "../../src/server/bulk.ts";
import type { BulkAddAnswer, BulkAddPreview, BulkControlAnswer, BulkControlPreview, BulkRowRef, LeadSearchResult, OutreachStatus } from "../../src/shared/api.ts";
import type { CampaignDefinition, StepDefinition } from "../../src/domain/sequence/definition.ts";
import { EngineHarness } from "./engine-harness.ts";
import { business, person } from "./export-builder.ts";
import { random } from "./generated-sequences.ts";

/**
 * The generated bulk runs (ticket 18; ADR 0003 "Ticket 18"). Through the real HTTP app, SQLite store and engine on the
 * fake email provider, with fictitious data: three campaigns (one not launched), people and a company lead enrolled in
 * random subsets, and a person with no usable channel. Two tabs open confirmations on random selections, scopes and
 * actions, and press them with the answer delivered, lost after the server applied it, or lost before it arrived; a
 * stored press is sent again by either tab or after a reload; leads change between a confirmation and its press by
 * per-lead controls from elsewhere. The record below is independent of src/domain/sequence: it keeps each enrollment's
 * state (running, paused, stopped) and each campaign's enrollments, and predicts every preview and answer from the
 * controls table of ADR 0003 "Ticket 17a" and from whether a lead's state changed since the confirmation's read.
 * Invariants B1 to B6 are checked after every step.
 */

export type BulkInvariant = "B1" | "B2" | "B3" | "B4" | "B5" | "B6";
export const bulkInvariantsOf = (problem: string): BulkInvariant[] => [...problem.matchAll(/\b(B[1-6])\b/g)].map((m) => m[1] as BulkInvariant);

export interface BulkRunOptions {
  readonly bulkRules?: Partial<BulkRules>;
  readonly steps?: number;
}

const MIN = 60_000;
/** Monday 2 November 2026, 09:00 London (GMT). */
const MONDAY_9 = Date.parse("2026-11-02T09:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays: number): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
/** Long waits: after the first email nothing falls due during a run, so only the user's actions change a lead. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [{ id: "e1", channel: "email", branch: "main", window: ALWAYS, steps: [email("s1", 0), email("s2", 30), email("s3", 30)], start: { kind: "entry" }, removed: false }],
};

const BUSINESSES = [
  business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" }),
  business({ business_id: "b2", business_name: "Kestrel Dental", phone_e164: "+442079460201" }),
  business({ business_id: "b3", business_name: "Quayside Clinic", general_emails: "hello@quayside.example" }),
  business({ business_id: "b4", business_name: "Fernhill Rooms" }),
];
const PEOPLE = [
  person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example" }),
  person({ person_id: "p2", business_id: "b1", full_name: "Nia Cole", email: "nia@harbour.example" }),
  person({ person_id: "p3", business_id: "b2", full_name: "Rae Lund", email: "rae@kestrel.example" }),
  person({ person_id: "p4", business_id: "b2", full_name: "Ivo Marsh", email: "ivo@kestrel.example" }),
  person({ person_id: "p5", business_id: "b1", full_name: "Lea Park", email: "lea@harbour.example" }),
];
/** On record, never reachable: no email or mobile, and Fernhill Rooms has no main line. */
const ODA = person({ person_id: "p9", business_id: "b4", full_name: "Oda Finch" });
const COMPANY_LEAD = "Quayside Clinic";

/** `ended`: outreach ended other than by the user's stop (no usable channel here); no control of these runs applies to it. */
type State = "running" | "paused" | "stopped" | "ended";
const ENDED_OTHERWISE: readonly OutreachStatus[] = ["replied", "interested_on_call", "declined_on_call", "sequence_finished_no_response", "finished_no_usable_channel"];
const stateOf = (status: OutreachStatus): State => (status === "paused" ? "paused" : status === "stopped_manually" ? "stopped" : ENDED_OTHERWISE.includes(status) ? "ended" : "running");
type ControlAction = "pause" | "resume" | "stop";

interface RecordEnrollment {
  readonly id: string;
  readonly campaignId: string;
  readonly rowKey: string;
  state: State;
}

/** The controls table (ADR 0003 "Ticket 17a"), for the states these runs reach: whether the action applies. */
function allowed(action: ControlAction | "resume_from_next_step", launched: boolean, state: State): boolean {
  if (!launched || state === "ended") return false;
  if (action === "pause") return state === "running";
  if (action === "resume") return state === "paused";
  if (action === "stop") return state !== "stopped";
  return state === "stopped";
}
const after = (action: ControlAction | "resume_from_next_step"): State => (action === "pause" ? "paused" : action === "stop" ? "stopped" : "running");

interface Confirmation {
  readonly kind: "control";
  readonly preview: BulkControlPreview;
  /** The record's state of each item at the read, by enrollment id. */
  readonly seen: ReadonlyMap<string, State>;
}
interface AddConfirmation {
  readonly kind: "add";
  readonly preview: BulkAddPreview;
  readonly rows: readonly BulkRowRef[];
}
interface StoredPress {
  readonly bulkId: string;
  readonly body: unknown;
  readonly confirmation: Confirmation | AddConfirmation;
  /** Whether a send of it has reached the server, and the first answer the server gave (for replays). */
  arrived: boolean;
  first: BulkControlAnswer | BulkAddAnswer | null;
}

export async function runBulk(seed: number, options: BulkRunOptions = {}): Promise<{ problems: string[]; stats: { features: string[] } }> {
  const rnd = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const chance = (p: number) => rnd() < p;
  const problems: string[] = [];
  const features = new Set<string>();
  const fail = (what: string) => problems.push(what);

  const h = new EngineHarness({
    start: MONDAY_9,
    accounts: [{ id: "inbox-a", capacity: 500, gapMs: 1000, k: 5, healthy: true, quotaAvailable: true, resetZone: "UTC" }],
    ...(options.bulkRules ? { bulkRules: options.bulkRules } : {}),
  });
  await h.tick();

  // Three campaigns: two launched, one not. Each imports every business and a random subset of the people.
  const campaigns: { id: string; name: string; launched: boolean }[] = [];
  for (const [i, name] of ["Clinics", "Dentists", "Draft"].entries()) {
    const people = PEOPLE.filter(() => chance(0.6));
    const { campaign } = await h.createCampaign(name, { businesses: BUSINESSES, people: [...people, ...(i === 0 ? [ODA] : [])] });
    await h.defineSequence(campaign.id, DEFINITION);
    const launched = name !== "Draft";
    if (launched && (await h.launch(campaign.id)).status !== 200) throw new Error("launch refused");
    campaigns.push({ id: campaign.id, name, launched });
  }
  await h.advanceTo(MONDAY_9 + 10 * MIN);
  const launchedOf = (campaignId: string) => campaigns.find((c) => c.id === campaignId)?.launched ?? false;

  // The rows Leads shows, and the record's enrollments as the imports made them.
  const search = async () => (await h.request<LeadSearchResult>("GET", "/api/leads")).body.rows;
  const rows = (await search()).map((r) => ({ ref: { kind: r.kind, id: r.id } as BulkRowRef, name: r.name, key: `${r.kind}:${r.id}` }));
  const record: RecordEnrollment[] = (await search()).flatMap((r) => r.enrollments.map((e) => ({ id: e.id, campaignId: e.campaign.id, rowKey: `${r.kind}:${r.id}`, state: stateOf(e.status) })));
  const odaKey = rows.find((r) => r.name === "Oda Finch")?.key ?? "";
  // The import's company-lead rule, for these companies: a company with people on record (all reachable here but Oda,
  // whose company has no shared inbox) is never added as a company lead.
  const companiesWithPeople = new Set((await search()).flatMap((r) => (r.kind === "person" ? [`company:${r.company.id}`] : [])));
  const notEnrollable = (key: string) => key === odaKey || companiesWithPeople.has(key);

  let ids = 0;
  const tabs: [Confirmation | AddConfirmation | null, Confirmation | AddConfirmation | null] = [null, null];
  const outbox: StoredPress[] = [];

  /** B5 and B6: every enrollment's state and the set of enrollments equal the record's. */
  const checkState = async (when: string) => {
    const seen = (await search()).flatMap((r) => r.enrollments.map((e) => ({ id: e.id, campaignId: e.campaign.id, rowKey: `${r.kind}:${r.id}`, state: stateOf(e.status) })));
    const pairs = new Set<string>();
    for (const e of seen) {
      const pair = `${e.rowKey}|${e.campaignId}`;
      if (pairs.has(pair)) fail(`B6 ${when}: ${e.rowKey} is enrolled twice in ${e.campaignId}`);
      pairs.add(pair);
      const mine = record.find((r) => r.id === e.id);
      if (!mine) fail(`B6 ${when}: enrollment ${e.id} of ${e.rowKey} is not in the record`);
      else if (mine.state !== e.state) fail(`B5 ${when}: ${e.rowKey} in ${e.campaignId} is ${e.state}, the record says ${mine.state}`);
    }
    for (const r of record) if (!seen.some((e) => e.id === r.id)) fail(`B6 ${when}: the record's enrollment ${r.id} is gone`);
  };

  /** A per-lead control from elsewhere (another page's Pause, Stop, Resume or restart). */
  const elsewhere = async (target?: RecordEnrollment, action?: ControlAction | "resume_from_next_step") => {
    const e = target ?? pick(record);
    const a = action ?? pick(["pause", "resume", "stop", "resume_from_next_step"] as const);
    const res = await h.request("POST", `/api/enrollments/${e.id}/controls`, { requestId: `elsewhere-${++ids}`, action: a });
    const ok = allowed(a, launchedOf(e.campaignId), e.state);
    if ((res.status === 200) !== ok) fail(`B5 a ${a} from elsewhere on ${e.rowKey} answered ${res.status}, the record expected ${ok ? 200 : 409}`);
    if (res.status === 200) e.state = after(a);
  };

  const open = async (tab: 0 | 1) => {
    const selection = rows.filter(() => chance(0.45));
    if (selection.length === 0) selection.push(pick(rows));
    if (chance(0.25)) {
      const target = pick(campaigns);
      // Oda is selected now and then: the add of a person with no usable channel (B6).
      if (!selection.some((r) => r.key === odaKey) && chance(0.4)) selection.push(rows.find((r) => r.key === odaKey) ?? pick(rows));
      const res = await h.request<BulkAddPreview>("POST", "/api/bulk/preview", { action: "add", rows: selection.map((r) => r.ref), campaignId: target.id });
      if (res.status !== 200) return fail(`B4 an add preview answered ${res.status}`);
      for (const row of res.body.rows) {
        const key = `${row.row.kind}:${row.row.id}`;
        const enrolled = record.some((r) => r.rowKey === key && r.campaignId === target.id);
        const expected = enrolled ? "already_enrolled" : notEnrollable(key) ? "not_enrolled" : "enroll";
        if (row.outcome !== expected) fail(`B6 the add preview says ${row.outcome} for ${key}, the record expects ${expected}`);
      }
      const tally = { enroll: res.body.rows.filter((r) => r.outcome === "enroll").length, alreadyEnrolled: res.body.rows.filter((r) => r.outcome === "already_enrolled").length, notEnrolled: res.body.rows.filter((r) => r.outcome === "not_enrolled").length };
      if (JSON.stringify(tally) !== JSON.stringify(res.body.counts)) fail(`B4 the add preview's counts ${JSON.stringify(res.body.counts)} are not its rows' ${JSON.stringify(tally)}`);
      tabs[tab] = { kind: "add", preview: res.body, rows: selection.map((r) => r.ref) };
      features.add("add-confirmation");
      return;
    }
    const action = pick(["pause", "resume", "stop"] as const);
    const scope = chance(0.5) ? null : pick(campaigns).id;
    const res = await h.request<BulkControlPreview>("POST", "/api/bulk/preview", { action, rows: selection.map((r) => r.ref), campaignId: scope });
    if (res.status !== 200) return fail(`B4 a preview answered ${res.status}`);
    const expected = record.filter((e) => selection.some((r) => r.key === e.rowKey) && (scope === null || e.campaignId === scope)).map((e) => e.id).sort();
    const got = res.body.items.map((i) => i.enrollmentId).sort();
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(`B1 the preview's items ${got.join(",")} are not the scope's enrollments ${expected.join(",")} (scope ${scope ?? "every campaign"})`);
    const seen = new Map<string, State>();
    for (const item of res.body.items) {
      const mine = record.find((e) => e.id === item.enrollmentId);
      if (!mine) continue;
      seen.set(mine.id, mine.state);
      const ok = allowed(action, launchedOf(mine.campaignId), mine.state);
      if (item.control.allowed !== ok) fail(`B4 the preview ${ok ? "refuses" : "allows"} ${action} on ${mine.rowKey} in ${mine.campaignId} (${mine.state})`);
    }
    const refused = res.body.items.filter((i) => !i.control.allowed).length;
    if (res.body.counts.applies !== res.body.items.length - refused || res.body.counts.refused !== refused) fail(`B4 the preview's counts are not its items' tallies`);
    features.add(scope === null ? "scope-every-campaign" : "scope-one-campaign");
    if (refused > 0) features.add("preview-with-refusals");
    tabs[tab] = { kind: "control", preview: res.body, seen };
  };

  /** What the server should answer for each item, at the instant the press first reaches it; applies the record. */
  const arrive = (press: StoredPress): Map<string, "applied" | "refused"> => {
    const predicted = new Map<string, "applied" | "refused">();
    const c = press.confirmation;
    if (c.kind === "add") {
      const target = c.preview.campaign.id;
      for (const ref of c.rows) {
        const key = `${ref.kind}:${ref.id}`;
        if (record.some((r) => r.rowKey === key && r.campaignId === target) || notEnrollable(key)) continue;
        // Enrolled now: its id comes from the answer.
        record.push({ id: `pending:${key}|${target}`, campaignId: target, rowKey: key, state: "running" });
      }
      return predicted;
    }
    for (const item of c.preview.items) {
      if (!item.control.allowed) continue;
      const mine = record.find((e) => e.id === item.enrollmentId);
      if (!mine) continue;
      const unchanged = c.seen.get(mine.id) === mine.state;
      const applies = unchanged && allowed(c.preview.action, launchedOf(mine.campaignId), mine.state);
      if (!unchanged) features.add("changed-between-confirmation-and-press");
      predicted.set(mine.id, applies ? "applied" : "refused");
      if (applies) mine.state = after(c.preview.action);
    }
    return predicted;
  };

  /** Fills in the ids of enrollments an add made, from its answer. */
  const settleAdd = (answer: BulkAddAnswer) => {
    for (const r of answer.results) {
      const key = `${r.row.kind}:${r.row.id}`;
      const pending = record.find((e) => e.id === `pending:${key}|${answer.campaign.id}`);
      if (r.outcome === "enrolled" && r.enrollmentId && pending) Object.assign(pending, { id: r.enrollmentId });
      if (r.outcome === "enrolled" && !pending) fail(`B6 the add enrolled ${key}, which the record did not expect`);
      if (r.outcome !== "enrolled" && pending) fail(`B6 the add did not enroll ${key} (${r.outcome}), which the record expected`);
      if (r.outcome === "enrolled") features.add("add-enrolled");
      if (r.outcome === "already_enrolled") features.add("add-already-enrolled");
      if (r.outcome === "not_enrolled") features.add("add-no-usable-channel");
    }
  };

  /** One send of a stored press: the answer delivered, lost after the server applied it, or lost before it arrived. */
  const send = async (press: StoredPress, delivery: "delivered" | "lost-after" | "lost-before") => {
    if (delivery === "lost-before") {
      features.add("lost-before-arrival");
      return;
    }
    const firstArrival = !press.arrived;
    const predicted = firstArrival ? arrive(press) : null;
    press.arrived = true;
    const res = await h.request<BulkControlAnswer | BulkAddAnswer>("POST", "/api/bulk", press.body);
    if (res.status !== 200) return fail(`B4 the press ${press.bulkId} answered ${res.status}: ${JSON.stringify(res.body)}`);
    const answer = res.body;
    if (answer.action === "add") {
      if (firstArrival) {
        settleAdd(answer);
        // Each new lead's first email goes out now, so nothing of it falls due between a later confirmation and its press.
        await h.advanceTo(h.clock + 5 * MIN);
      }
      else if (JSON.stringify({ ...answer, replayed: false }) !== JSON.stringify({ ...(press.first as BulkAddAnswer), replayed: false })) fail(`B2 the add ${press.bulkId} sent again answered differently`);
      else features.add("add-replayed");
    } else {
      const tally = { applied: answer.results.filter((r) => r.outcome === "applied").length, refused: answer.results.filter((r) => r.outcome === "refused").length };
      if (JSON.stringify(tally) !== JSON.stringify(answer.counts)) fail(`B4 the answer's counts ${JSON.stringify(answer.counts)} are not its rows' ${JSON.stringify(tally)}`);
      for (const r of answer.results) {
        if (predicted) {
          const want = predicted.get(r.enrollmentId);
          if (want !== r.outcome) {
            // Applied where the record refuses: B3 when the lead really changed (it was not what the confirmation showed),
            // B4 when the answer claims what the server did not do.
            const mine = record.find((e) => e.id === r.enrollmentId);
            const now = mine ? stateOf((await h.request<{ status: OutreachStatus }>("GET", `/api/enrollments/${mine.id}`)).body.status) : null;
            const changed = mine !== undefined && now !== mine.state;
            fail(`${want === "refused" && changed ? "B3" : "B4"} item ${r.enrollmentId} of ${press.bulkId} was ${r.outcome}${r.reason ? ` (${r.reason})` : ""}, the record expected ${want ?? "no item"}`);
          }
          if (r.outcome === "refused") features.add("item-refused-at-the-press");
        } else {
          const first = (press.first as BulkControlAnswer | null)?.results.find((x) => x.enrollmentId === r.enrollmentId);
          if (first && (first.outcome !== r.outcome || first.reason !== r.reason)) fail(`B2 item ${r.enrollmentId} of ${press.bulkId} sent again answered ${r.outcome}, first ${first.outcome}`);
          // A per-lead request that applied is answered again with its first answer, never applied a second time.
          if (first?.outcome === "applied" && !r.replayed) fail(`B2 item ${r.enrollmentId} of ${press.bulkId} sent again was applied again, not replayed`);
          features.add("press-sent-again");
        }
      }
    }
    if (firstArrival && delivery === "delivered") press.first = answer;
    if (firstArrival && delivery === "lost-after") {
      // The server applied it; the page never saw the answer. The first answer is the one the server keeps: ask for it again.
      press.first = answer;
      features.add("lost-after-arrival");
    }
    if (delivery === "delivered") outbox.splice(outbox.indexOf(press), 1);
  };

  const press = async (tab: 0 | 1) => {
    const c = tabs[tab];
    if (!c) return;
    const bulkId = `bulk-${seed}-${++ids}`;
    const body =
      c.kind === "add"
        ? { bulkId, action: "add", campaignId: c.preview.campaign.id, rows: c.rows }
        : { bulkId, action: c.preview.action, campaignId: c.preview.scope?.id ?? null, items: c.preview.items.flatMap((i) => (i.control.allowed ? [{ enrollmentId: i.enrollmentId, expect: { status: i.status, preview: i.control.digest } }] : [])) };
    if (c.kind === "control" && c.preview.counts.applies === 0) {
      tabs[tab] = null;
      return;
    }
    if (c.kind === "add" && c.rows.length === 0) return;
    // A confirmation pressed from both tabs on one read: the other tab keeps its copy and may press it too.
    if (tabs[tab === 0 ? 1 : 0] === c) features.add("two-tabs-one-read");
    tabs[tab] = null;
    const stored: StoredPress = { bulkId, body, confirmation: c, arrived: false, first: null };
    outbox.push(stored);
    // Now and then a lead changes between the confirmation's read and the press.
    if (c.kind === "control" && chance(0.3)) {
      const item = pick(c.preview.items.filter((i) => i.control.allowed));
      const mine = item ? record.find((e) => e.id === item.enrollmentId) : undefined;
      if (mine) await elsewhere(mine, pick(["pause", "resume", "stop", "resume_from_next_step"] as const));
    }
    await send(stored, pick(["delivered", "delivered", "lost-after", "lost-before"] as const));
  };

  const resend = async () => {
    const stored = pick(outbox);
    if (!stored) return;
    // A press whose answer was lost: now and then one of its leads is put back by another tab first (B2).
    if (stored.arrived && stored.confirmation.kind === "control" && chance(0.5)) {
      const applied = (stored.first as BulkControlAnswer | null)?.results.find((r) => r.outcome === "applied");
      const mine = applied ? record.find((e) => e.id === applied.enrollmentId) : undefined;
      if (mine) {
        await elsewhere(mine, mine.state === "paused" ? "resume" : mine.state === "stopped" ? "resume_from_next_step" : "pause");
        features.add("lead-put-back-before-a-resend");
      }
    }
    features.add(pick(["resent-by-the-other-tab", "resent-after-a-reload"]));
    await send(stored, pick(["delivered", "delivered", "lost-after"] as const));
  };

  const steps = options.steps ?? 28;
  for (let step = 0; step < steps; step++) {
    const roll = rnd();
    const tab = chance(0.5) ? 0 : 1;
    if (roll < 0.15) await elsewhere();
    else if (roll < 0.45) await open(tab);
    else if (roll < 0.55) {
      // The other tab opens the same confirmation on the same read.
      const other = tab === 0 ? 1 : 0;
      if (tabs[tab]) tabs[other] = tabs[tab];
      else await open(tab);
    } else if (roll < 0.85) await press(tab);
    else await resend();
    await checkState(`after step ${step} (seed ${seed})`);
    if (problems.length > 0) break;
  }
  // Settle: every stored press is sent until answered.
  for (const stored of [...outbox]) {
    await send(stored, "delivered");
    await checkState(`after settling (seed ${seed})`);
  }
  await h.store.close();
  return { problems, stats: { features: [...features] } };
}
