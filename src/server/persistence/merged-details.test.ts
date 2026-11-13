import { describe, expect, test } from "vitest";
import type { Directory, ImportPlan } from "../../domain/import-plan.ts";
import { business, csvOf, person } from "../../../test/support/export-builder.ts";
import { testApi, type TestApi } from "../../../test/support/http.ts";
import type { PersonRecord } from "../../shared/api.ts";

/**
 * A contact detail id, once issued, always stands for one live detail (docs/adr/0001). When two
 * stored details turn out to be one, the absorbed one keeps its row and id and points at the
 * detail it was merged into; nothing reads it as a live detail.
 */

async function personNamed(api: TestApi, name: string): Promise<PersonRecord> {
  const rows = (await api.get<{ rows: { kind: string; id: string; name: string }[] }>(`/api/leads?text=${encodeURIComponent(name)}`)).body.rows;
  const row = rows.find((r) => r.kind === "person" && r.name === name);
  if (!row) throw new Error(`no person named ${name}`);
  return (await api.get<PersonRecord>(`/api/people/${row.id}`)).body;
}

function detailId(record: PersonRecord, owner: "person" | "company", value: string): string {
  const found = record.contactDetails.find((d) => d.owner === owner && d.value === value);
  if (!found) throw new Error(`${record.name} shows no ${owner} detail ${value}`);
  return found.id;
}

describe("a number two colleagues hold in different forms becomes the main line", () => {
  const regionless = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "", phone_original: "", country: "" });
  const people = [
    person({ person_id: "y", business_id: "b1", full_name: "Yara Glen", direct_phone: "+442079460155" }),
    person({ person_id: "z", business_id: "b1", full_name: "Zara Glen", direct_phone: "020 7946 0155" }),
  ];
  const promoted = { businesses: [{ ...regionless, country: "GB", phone_e164: "+442079460155" }], people };

  async function merged() {
    const api = testApi();
    const campaign = (await api.createCampaign("Physio")).id;
    await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [regionless], people }));
    const yaraNumber = detailId(await personNamed(api, "Yara Glen"), "person", "+44 20 7946 0155");
    const zaraNumber = detailId(await personNamed(api, "Zara Glen"), "person", "02079460155");
    expect((await api.post(`/api/campaigns/${campaign}/imports`, csvOf(promoted))).status).toBe(201);
    return { api, campaign, yaraNumber, zaraNumber };
  }

  test("the absorbed copy's id resolves to the main line it was merged into", async () => {
    const { api, yaraNumber, zaraNumber } = await merged();
    const mainLine = await api.store.contactDetail(yaraNumber);
    expect(mainLine).toMatchObject({ id: yaraNumber, owner: { kind: "company" }, channel: "phone", phoneKind: "main_line", key: "+442079460155", bad: false });
    expect(await api.store.contactDetail(zaraNumber)).toEqual(mainLine);
    expect((await personNamed(api, "Zara Glen")).contactDetails.map((d) => d.id)).toEqual([yaraNumber]);
  });

  test("a bad mark given through the absorbed copy's id lands on the main line", async () => {
    const { api, campaign, yaraNumber, zaraNumber } = await merged();
    expect(await api.store.markContactDetailBad(zaraNumber)).toBe(true);
    expect(await api.store.contactDetail(yaraNumber)).toMatchObject({ bad: true });
    expect((await personNamed(api, "Yara Glen")).contactDetails).toEqual([expect.objectContaining({ id: yaraNumber, bad: true })]);
    // Importing the same files again changes nothing, and the id still resolves.
    const again = await api.post<{ import: { summary: { counts: Record<string, number> } } }>(`/api/campaigns/${campaign}/imports`, csvOf(promoted));
    expect(again.body.import.summary.counts).toMatchObject({ new: 0, updated: 0 });
    expect(await api.store.contactDetail(zaraNumber)).toMatchObject({ id: yaraNumber, bad: true });
  });

  test("an id never issued resolves to nothing", async () => {
    const { api } = await merged();
    expect(await api.store.contactDetail("no-such-detail")).toBeNull();
    expect(await api.store.markContactDetailBad("no-such-detail")).toBe(false);
  });
});

/**
 * The store's contract for merges, whatever the planner asks of it. These plans are written by
 * hand at the store's seam, so they can make chains and collisions the planner does not yet make.
 */
describe("the store keeps an absorbed detail out of everything that reads live details", () => {
  const harbour = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", general_emails: "info@harbour.example" });
  const staff = [
    person({ person_id: "a", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" }),
    person({ person_id: "b", business_id: "b1", full_name: "Ben Ito", email: "ben@harbour.example" }),
  ];

  async function setUp() {
    const api = testApi();
    const campaign = (await api.createCampaign("Physio")).id;
    await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [harbour], people: staff }));
    const amira = await personNamed(api, "Amira Hassan");
    const ben = await personNamed(api, "Ben Ito");
    const ids = {
      amira: amira.id,
      ben: ben.id,
      company: amira.company.id,
      amiraEmail: detailId(amira, "person", "amira@harbour.example"),
      benEmail: detailId(ben, "person", "ben@harbour.example"),
      inbox: detailId(amira, "company", "info@harbour.example"),
    };
    let n = 0;
    const apply = async (changes: Partial<ImportPlan>, inspect?: (d: Directory) => void) =>
      api.store.importIntoCampaign({
        campaign: { id: campaign },
        importId: `hand-${++n}`,
        importedAt: `2026-11-13T1${n}:00:00.000Z`,
        fileNames: { people: null, businesses: null },
        plan: (directory) => {
          inspect?.(directory);
          return {
            companies: [],
            people: [],
            details: [],
            detailChanges: [],
            consolidations: [],
            enrollments: [],
            summary: { rows: { businesses: 0, people: 0 }, counts: { new: 0, already_enrolled: 0, updated: 0, not_enrolled: 0 }, entries: [], rowRecords: { businesses: [], people: [] } },
            ...changes,
          };
        },
      });
    const email = (id: string, owner: { kind: "person"; personId: string }, value: string) => ({
      id,
      owner,
      channel: "email" as const,
      phoneKind: null,
      value,
      key: value,
      searchDigits: "",
      addedAt: "2026-11-13T12:00:00.000Z",
    });
    return { api, campaign, ids, apply, email };
  }

  test("an absorbed detail is not in the directory the planner matches and claims against", async () => {
    const { ids, apply } = await setUp();
    await apply({ consolidations: [{ fromId: ids.amiraEmail, intoId: ids.inbox }] });
    let seen: string[] = [];
    await apply({}, (d) => {
      seen = [...d.people.flatMap((p) => p.details), ...d.companies.flatMap((c) => c.details)].map((x) => x.id);
    });
    expect(seen).not.toContain(ids.amiraEmail);
    expect(seen).toContain(ids.inbox);
  });

  test("an absorbed detail is not shown, searched or counted as reach", async () => {
    const { api, ids, apply } = await setUp();
    await apply({ consolidations: [{ fromId: ids.amiraEmail, intoId: ids.inbox }] });
    const amira = await api.store.person(ids.amira);
    expect(amira?.contactDetails.map((d) => d.id)).not.toContain(ids.amiraEmail);
    expect((await api.store.searchLeads({ text: "amira@harbour", campaignId: null, status: null, companyId: null, limit: 10 })).total).toBe(0);
    expect((await api.store.company(ids.company))?.people.find((p) => p.id === ids.amira)?.unenrolledReason).toBeNull();
  });

  test("chains resolve to the one detail at their end, and a bad mark on any link survives", async () => {
    const { api, ids, apply } = await setUp();
    await api.store.markContactDetailBad(ids.amiraEmail);
    await apply({ consolidations: [{ fromId: ids.amiraEmail, intoId: ids.inbox }] });
    await apply({ consolidations: [{ fromId: ids.inbox, intoId: ids.benEmail }] });
    for (const id of [ids.amiraEmail, ids.inbox, ids.benEmail]) {
      expect(await api.store.contactDetail(id)).toMatchObject({ id: ids.benEmail, owner: { kind: "person", personId: ids.ben }, bad: true });
    }
  });

  test("an absorbed detail holds no place: its owner can hold the same value live again", async () => {
    const { api, ids, apply, email } = await setUp();
    await apply({ consolidations: [{ fromId: ids.amiraEmail, intoId: ids.inbox }] });
    await apply({ details: [email("again", { kind: "person", personId: ids.amira }, "amira@harbour.example")] });
    expect(await api.store.contactDetail("again")).toMatchObject({ id: "again", bad: false });
    expect(await api.store.contactDetail(ids.amiraEmail)).toMatchObject({ id: ids.inbox });
  });

  test("the campaign safety net does not count an absorbed detail as its old owner's destination", async () => {
    const { api, ids, apply, email } = await setUp();
    await apply({ consolidations: [{ fromId: ids.amiraEmail, intoId: ids.inbox }] });
    // Ben, enrolled in the same campaign, now holds the address Amira's absorbed copy carried.
    await apply({ details: [email("bens-copy", { kind: "person", personId: ids.ben }, "amira@harbour.example")] });
    expect(await api.store.contactDetail("bens-copy")).toMatchObject({ owner: { kind: "person", personId: ids.ben } });
  });
});
