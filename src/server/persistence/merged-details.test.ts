import { describe, expect, test } from "vitest";
import type { DetailConsolidation, Directory, ImportPlan, NewDetail } from "../../domain/import-plan.ts";
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

// Review round 2 (GPT): the store read the copy in the region of the first main line on record,
// the planner in the region of the line being claimed, and refused a merge the planner asked for.
// Without a country, Zara's national copy is kept as its digits and never read (review round 4).
describe("a company with a foreign main line and no country lists a colleague's number as a second main line", () => {
  const atlantic = business({ business_id: "b1", place_id: "P1", business_name: "Atlantic Physio", phone_e164: "+12025550199", phone_original: "+1 202 555 0199", country: "" });
  const yara = person({ person_id: "y", business_id: "b1", full_name: "Yara Glen", direct_phone: "+442079460155" });
  const zara = person({ person_id: "z", business_id: "b1", full_name: "Zara Glen", direct_phone: "020 7946 0155" });

  for (const [order, people] of [["Yara first", [yara, zara]], ["Zara first", [zara, yara]]] as const) {
    test(`the international copy moves into the new line; the copy kept by its digits stays as written (${order})`, async () => {
      const api = testApi();
      const campaign = (await api.createCampaign("Physio")).id;
      expect((await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [atlantic], people: [...people] }))).status).toBe(201);
      const yaraNumber = detailId(await personNamed(api, "Yara Glen"), "person", "+44 20 7946 0155");
      const zaraNumber = detailId(await personNamed(api, "Zara Glen"), "person", "02079460155");
      const promoted = await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [{ ...atlantic, phone_e164: "+442079460155", phone_original: "+44 20 7946 0155" }], people: [] }));
      expect(promoted.status).toBe(201);
      const line = await api.store.contactDetail(yaraNumber);
      expect(line).toMatchObject({ owner: { kind: "company" }, phoneKind: "main_line", key: "+442079460155" });
      expect(await api.store.contactDetail(zaraNumber)).toMatchObject({ id: zaraNumber, owner: { kind: "person" }, key: "02079460155" });
    });
  }
});

/**
 * The store's contract for merges, whatever the planner asks of it. These plans are written by
 * hand at the store's seam, so they can make chains the planner does not yet make; every merge
 * in them is one the import could ask for: one detail, held twice at one company.
 */
describe("the store keeps an absorbed detail out of everything that reads live details", () => {
  const harbour = business({ business_id: "b1", place_id: "P1", business_name: "Harbour Lane Physio", phone_e164: "+442079460101", general_emails: "info@harbour.example" });
  const quay = business({ business_id: "b2", place_id: "P2", business_name: "Quay Street Dental", phone_e164: "+442079460199", phone_original: "+44 20 7946 0199" });
  const staff = [
    person({ person_id: "a", business_id: "b1", full_name: "Amira Hassan", email: "amira@harbour.example" }),
    person({ person_id: "b", business_id: "b1", full_name: "Ben Ito", email: "ben@harbour.example" }),
  ];

  async function setUp() {
    const api = testApi();
    const campaign = (await api.createCampaign("Physio")).id;
    await api.post(`/api/campaigns/${campaign}/imports`, csvOf({ businesses: [harbour, quay], people: staff }));
    const amira = await personNamed(api, "Amira Hassan");
    const ben = await personNamed(api, "Ben Ito");
    const quayId = (await api.store.searchLeads({ text: "Quay", campaignId: null, status: null, companyId: null, limit: 5 })).rows[0]?.id ?? "";
    const ids = {
      amira: amira.id,
      ben: ben.id,
      company: amira.company.id,
      amiraEmail: detailId(amira, "person", "amira@harbour.example"),
      inbox: detailId(amira, "company", "info@harbour.example"),
      quayLine: (await api.store.company(quayId))?.contactDetails[0]?.id ?? "",
    };
    let n = 0;
    const apply = async (changes: Partial<ImportPlan>, inspect?: (d: Directory) => void) =>
      api.store.importIntoCampaign({
        campaign: { id: campaign },
        importId: `hand-${++n}`,
        importedAt: `2026-11-13T12:${String(n).padStart(2, "0")}:00.000Z`,
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
    const at = "2026-11-13T12:00:00.000Z";
    const amiraOwns = { kind: "person" as const, personId: ids.amira };
    const harbourOwns = { kind: "company" as const, companyId: ids.company };
    const email = (id: string, owner: NewDetail["owner"], value: string): NewDetail => ({ id, owner, channel: "email", phoneKind: null, value, key: value, searchDigits: "", addedAt: at });
    const phone = (id: string, owner: NewDetail["owner"], value: string, key: string, phoneKind: NewDetail["phoneKind"] = "direct"): NewDetail => ({ id, owner, channel: "phone", phoneKind, value, key, searchDigits: key.replace(/\D/g, ""), addedAt: at });
    // Amira's own copy of the company's shared inbox, as a person holds one before the company lists it.
    const inboxCopy = email("amira-inbox-copy", amiraOwns, "info@harbour.example");
    return { api, campaign, ids, apply, email, phone, amiraOwns, harbourOwns, inboxCopy };
  }

  test("an absorbed detail is not in the directory the planner matches and claims against", async () => {
    const { ids, apply, inboxCopy } = await setUp();
    await apply({ details: [inboxCopy] });
    await apply({ consolidations: [{ fromId: inboxCopy.id, intoId: ids.inbox, key: "info@harbour.example", region: null }] });
    let seen: string[] = [];
    await apply({}, (d) => {
      seen = [...d.people.flatMap((p) => p.details), ...d.companies.flatMap((c) => c.details)].map((x) => x.id);
    });
    expect(seen).not.toContain(inboxCopy.id);
    expect(seen).toContain(ids.inbox);
  });

  test("an absorbed detail is not shown or counted as reach, and search finds the same leads", async () => {
    const { api, ids, apply, inboxCopy } = await setUp();
    const search = async () => (await api.store.searchLeads({ text: "info@harbour", campaignId: null, status: null, companyId: null, limit: 10 })).rows.map((r) => r.id);
    const found = await search();
    await apply({ details: [inboxCopy] });
    await apply({ consolidations: [{ fromId: inboxCopy.id, intoId: ids.inbox, key: "info@harbour.example", region: null }] });
    const amira = await api.store.person(ids.amira);
    expect(amira?.contactDetails.filter((d) => d.owner === "person").map((d) => d.id)).toEqual([ids.amiraEmail]);
    expect(await search()).toEqual(found);
    expect((await api.store.company(ids.company))?.people.find((p) => p.id === ids.amira)?.unenrolledReason).toBeNull();
  });

  test("chains resolve to the one detail at their end, and a bad mark on any link survives", async () => {
    const { api, ids, apply, phone, amiraOwns, harbourOwns } = await setUp();
    // Amira's number, once stored by its digits, once read; then the company lists it as a second main line.
    const digits = phone("amira-digits", amiraOwns, "020 7946 0177", "02079460177");
    const read = phone("amira-read", amiraOwns, "+44 20 7946 0177", "+442079460177");
    const line = phone("harbour-0177", harbourOwns, "+44 20 7946 0177", "+442079460177", "main_line");
    await apply({ details: [digits, read, line] });
    await api.store.markContactDetailBad(digits.id);
    await apply({ consolidations: [{ fromId: digits.id, intoId: read.id, key: "+442079460177", region: "GB" }] });
    await apply({ consolidations: [{ fromId: read.id, intoId: line.id, key: "+442079460177", region: "GB" }] });
    for (const id of [digits.id, read.id, line.id]) {
      expect(await api.store.contactDetail(id)).toMatchObject({ id: line.id, owner: harbourOwns, key: "+442079460177", bad: true });
    }
    expect(await api.store.contactDetail(ids.inbox)).toMatchObject({ id: ids.inbox });
  });

  test("an absorbed detail holds no place: its owner can hold the same value live again", async () => {
    const { api, ids, apply, inboxCopy } = await setUp();
    await apply({ details: [inboxCopy] });
    await apply({ consolidations: [{ fromId: inboxCopy.id, intoId: ids.inbox, key: "info@harbour.example", region: null }] });
    await apply({ details: [{ ...inboxCopy, id: "again" }] });
    expect(await api.store.contactDetail("again")).toMatchObject({ id: "again", bad: false });
    expect(await api.store.contactDetail(inboxCopy.id)).toMatchObject({ id: ids.inbox });
  });

  test("the campaign safety net does not count an absorbed detail as its old owner's destination", async () => {
    const { api, ids, apply, email, inboxCopy } = await setUp();
    await apply({ details: [inboxCopy] });
    await apply({ consolidations: [{ fromId: inboxCopy.id, intoId: ids.inbox, key: "info@harbour.example", region: null }] });
    // Ben, enrolled in the same campaign as Amira, now holds the address her absorbed copy carried.
    await apply({ details: [email("bens-copy", { kind: "person", personId: ids.ben }, "info@harbour.example")] });
    expect(await api.store.contactDetail("bens-copy")).toMatchObject({ owner: { kind: "person", personId: ids.ben } });
  });

  describe("the store refuses a merge of two details that are not one, and keeps nothing of the import", () => {
    const refused = async (merge: (s: Awaited<ReturnType<typeof setUp>>) => DetailConsolidation, extra: (s: Awaited<ReturnType<typeof setUp>>) => NewDetail[] = () => []) => {
      const s = await setUp();
      const before = await s.api.store.person(s.ids.amira);
      await expect(s.apply({ details: extra(s), consolidations: [merge(s)] })).rejects.toThrow(/cannot be merged/);
      expect(await s.api.store.person(s.ids.amira)).toEqual(before);
    };

    test("another channel", () => refused((s) => ({ fromId: s.ids.amiraEmail, intoId: s.ids.quayLine, key: "+442079460199", region: "GB" })));
    test("another address", () => refused((s) => ({ fromId: s.ids.amiraEmail, intoId: s.ids.inbox, key: "info@harbour.example", region: null })));
    test("the same number at another company", () =>
      refused((s) => ({ fromId: "amira-0199", intoId: s.ids.quayLine, key: "+442079460199", region: "GB" }), (s) => [s.phone("amira-0199", s.amiraOwns, "+44 20 7946 0199", "+442079460199")]));
    test("a company's detail into a person's", () => refused((s) => ({ fromId: s.ids.inbox, intoId: s.inboxCopy.id, key: "info@harbour.example", region: null }), (s) => [s.inboxCopy]));
    test("a target that does not hold the claim's key", () => refused((s) => ({ fromId: s.inboxCopy.id, intoId: s.ids.inbox, key: "office@harbour.example", region: null }), (s) => [s.inboxCopy]));
    // The planner's claim names the region it read the copy in; the store uses that reading, never its own.
    test("a number stored by its digits that reads as the line only in another region than the claim's", () =>
      refused(
        () => ({ fromId: "amira-digits", intoId: "harbour-0177", key: "+442079460177", region: "US" }),
        (s) => [s.phone("amira-digits", s.amiraOwns, "020 7946 0177", "02079460177"), s.phone("harbour-0177", s.harbourOwns, "+44 20 7946 0177", "+442079460177", "main_line")],
      ));
    test("a detail already merged", async () => {
      const s = await setUp();
      await s.apply({ details: [s.inboxCopy] });
      const merge = { fromId: s.inboxCopy.id, intoId: s.ids.inbox, key: "info@harbour.example", region: null };
      await s.apply({ consolidations: [merge] });
      await expect(s.apply({ consolidations: [merge] })).rejects.toThrow(/cannot be merged/);
    });
  });
});
