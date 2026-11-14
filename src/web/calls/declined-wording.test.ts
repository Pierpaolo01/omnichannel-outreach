import { describe, expect, test } from "vitest";
import { EngineHarness } from "../../../test/support/engine-harness.ts";
import { business, person } from "../../../test/support/export-builder.ts";
import type { CampaignDefinition, DeclinedPath, StepDefinition, TrackDefinition } from "../../domain/sequence/definition.ts";
import type { ActivityView, CallTaskView, LeadSearchResult, PersonRecord, RecordCalls } from "../../shared/api.ts";
import { describeEntry } from "../activity.tsx";
import { DECLINED_PATH_LINE, declinedPathSourceLine, declinedRecordLine, declinePreviewLines, loggedLine, offListLine, refusedRecordLine } from "./wording.ts";

/**
 * Every sentence the screens say about a decline (ticket 16c), rendered from the server's reads at one instant: the
 * sheet before Log (the call read's `declines`), the status line after it (`loggedLine`, from the stored press), another
 * window's call on the same lead (`offListLine`), the record's campaign row and Activity. One function per state, each
 * reading only the server, so the screens cannot disagree about which path a decline took or where the lead stands.
 */

const MIN = 60_000;
const MONDAY_10 = Date.parse("2026-11-02T10:00:00Z");
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 0, end: 24 }));
const email = (id: string, waitDays = 0): StepDefinition => ({ id, waitDays, subject: `Subject ${id}`, body: `Email ${id} for {{company}}.`, threading: "new_subject", removed: false });
const call = (id: string): StepDefinition => ({ id, waitDays: 0, subject: "", body: "", threading: "new_subject", removed: false });
const track = (id: string, channel: TrackDefinition["channel"], steps: StepDefinition[], fields: Partial<TrackDefinition> = {}): TrackDefinition => ({ id, channel, branch: "main", window: ALWAYS, steps, start: { kind: "entry" }, removed: false, ...fields });
/** Two phone tracks at entry, so a decline on one takes the other off the list, an email track beside them, and a win-back branch. */
const DEFINITION: CampaignDefinition = {
  timezone: "Europe/London",
  callSkipLimitDays: 2,
  emailPool: ["inbox-a"],
  smsPool: [],
  callScript: "",
  tracks: [track("p1", "call", [call("c1")]), track("p2", "call", [call("c2")]), track("e1", "email", [email("e1s1"), email("e1s2", 3)]), track("w1", "email", [email("w1s1"), email("w1s2", 2)], { branch: "win_back" })],
};

async function world() {
  const h = new EngineHarness({ start: MONDAY_10 - 60 * MIN, accounts: [{ id: "inbox-a", capacity: 50, gapMs: MIN, k: 2, healthy: true, quotaAvailable: true, resetZone: "UTC" }] });
  await h.tick();
  await h.request("PUT", "/api/call-settings", { dailyCapacity: 20, userZone: "Europe/London" });
  h.clock = MONDAY_10 - 30 * MIN;
  const { campaign } = await h.createCampaign("Spring physio", {
    businesses: [business({ business_id: "b1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101" })],
    people: [person({ person_id: "p1", business_id: "b1", full_name: "Pat Oneil", email: "pat@harbour.example", direct_phone: "+442079460111" })],
  });
  await h.defineSequence(campaign.id, DEFINITION);
  expect((await h.launch(campaign.id)).status).toBe(200);
  await h.advanceTo(MONDAY_10);
  const row = (await h.request<LeadSearchResult>("GET", `/api/leads?campaign=${campaign.id}`)).body.rows[0]!;
  const lead = row.enrollments[0]!.id;
  const tasks = (await h.progress(lead)).tracks.flatMap((t) => (t.callTask ? [t.callTask.taskId] : []));
  const task = async (id: string) => (await h.request<CallTaskView>("GET", `/api/call-tasks/${id}`)).body;
  return { h, personId: row.id, tasks, task };
}

describe("every screen says a decline from the server's reads, so none can disagree (ticket 16c)", () => {
  for (const path of ["stop", "continue", "win_back"] as const satisfies readonly DeclinedPath[]) {
    test(`${path}: the sheet before and after Log, another window's call, the record and Activity`, async () => {
      const { h, personId, tasks, task } = await world();
      const [first, other] = tasks;
      const before = await task(first!);
      const preview = before.declines?.find((d) => d.path === path);
      expect(preview).toBeDefined();
      const lines = declinePreviewLines(preview!, before.campaign.name, "Europe/London");
      const number = before.numbers.find((n) => !n.bad)!.detailId;
      expect((await h.request("POST", `/api/call-tasks/${first!}/outcome`, { requestId: "press-1", outcome: "not_interested", declinedPath: path, numberId: number })).status).toBe(200);

      // One instant: every read after the decline.
      const after = await task(first!);
      const elsewhere = await task(other!);
      const rec = (await h.request<PersonRecord & RecordCalls>("GET", `/api/people/${personId}`)).body;
      const entry = (await h.request<ActivityView>("GET", `/api/people/${personId}/activity`)).body.entries.find((e) => e.kind === "call" && e.outcome === "not_interested");
      const status = rec.enrollments[0]!.status;

      // The status the preview said is the status every read gives now.
      expect(after.status).toBe(preview!.status);
      expect(status).toBe(preview!.status);
      const logged = loggedLine({ requestId: "press-1", who: "Pat Oneil", body: { requestId: "press-1", outcome: "not_interested", numberId: number, note: "", noteScope: "person" }, task: after }, "Europe/London");
      const recordLine = declinedRecordLine(rec.declines[0]!, status);
      const activity = describeEntry(entry!, "Europe/London").body ?? "";
      const offList = offListLine("Pat Oneil", elsewhere.offList, null, "Europe/London");

      // The path, said once per screen, in the words of one table.
      expect(logged).toContain(DECLINED_PATH_LINE[path]);
      expect(activity.startsWith(DECLINED_PATH_LINE[path].slice(0, -1))).toBe(true);
      const said = {
        stop: { record: "Their outreach in this campaign stopped there.", offList: "Pat Oneil declined on a call, so their outreach in this campaign stopped and the call left the list." },
        continue: { record: "their other channels continue.", offList: "Pat Oneil declined on another call, so no call is made to them again in this campaign and this call left the list." },
        // The decline skips the lead's other started phone track as declined before entering win-back (ticket 16a's `decline`).
        win_back: { record: "moved to this campaign’s win-back branch, which is running.", offList: "Pat Oneil declined on another call, so no call is made to them again in this campaign and this call left the list." },
      }[path];
      expect(recordLine).toContain(said.record);
      expect(offList).toBe(said.offList);
      // Each track the preview named is in Activity, said from the same state at this instant.
      for (const t of preview!.tracks) expect(activity).toContain(t.track.label);
      expect(lines.tracks).toHaveLength(preview!.tracks.length);
    });
  }

  test("a kept refusal names the path its press carried", () => {
    const line = refusedRecordLine({ who: "Pat Oneil", body: { outcome: "not_interested", declinedPath: "continue" }, refused: { message: "This call is no longer on the list.", offList: null } }, "Europe/London");
    expect(line).toBe("Not logged: not interested (“Keep the email and SMS steps going”) for Pat Oneil. This call is no longer on the list.");
  });
});

describe("where the preselected path comes from is said from the read: set on the phone track, or not set (review bot on d478d6d)", () => {
  const set = { declinedPath: "win_back" as const, declinedPathSet: true, track: { label: "Phone track" } };
  const unset = { declinedPath: "stop" as const, declinedPathSet: false, track: { label: "Phone track" } };

  test("untouched, or the user's choice equal to the preselection", () => {
    expect(declinedPathSourceLine(set, null, "Pat Oneil")).toBe("Preselected from the phone track’s setting.");
    expect(declinedPathSourceLine(set, "win_back", "Pat Oneil")).toBe("Preselected from the phone track’s setting.");
    expect(declinedPathSourceLine(unset, null, "Pat Oneil")).toBe("No path is set on the phone track for a declined call, so the one logging uses without a choice is preselected.");
    expect(declinedPathSourceLine(unset, "stop", "Pat Oneil")).toBe("No path is set on the phone track for a declined call, so the one logging uses without a choice is preselected.");
  });

  test("overridden: a set path is named as the track's setting; with none set, no setting is claimed", () => {
    expect(declinedPathSourceLine(set, "continue", "Pat Oneil")).toBe("For Pat Oneil only: the phone track is set to “Move to the win-back messages”.");
    const overUnset = declinedPathSourceLine(unset, "continue", "Pat Oneil");
    expect(overUnset).toBe("For Pat Oneil only: no path is set on the phone track, so without a choice logging uses “Stop all outreach in this campaign”.");
    expect(overUnset).not.toContain("is set to");
  });
});
