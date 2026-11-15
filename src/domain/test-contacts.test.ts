import { describe, expect, test } from "vitest";
import { parseTestContacts } from "./test-contacts.ts";

describe("test contacts are read the way a lead's details are (ADR 0003 'Ticket 21')", () => {
  test("an address keys lower-case and a mobile keys to E.164; blank is none", () => {
    expect(parseTestContacts({ email: " Alex.Own@Personal-Mail.example ", mobile: "+44 7700 900456" })).toEqual({
      ok: true,
      contacts: { email: { value: "alex.own@personal-mail.example", key: "alex.own@personal-mail.example" }, mobile: { value: "+44 7700 900456", key: "+447700900456" } },
    });
    expect(parseTestContacts({ email: "", mobile: "  " })).toEqual({ ok: true, contacts: { email: null, mobile: null } });
  });

  test("a malformed address and a number not in international form are refused, by field", () => {
    expect(parseTestContacts({ email: "alex at home", mobile: "" })).toMatchObject({ ok: false, field: "email" });
    expect(parseTestContacts({ email: "", mobile: "07700 900456" })).toMatchObject({ ok: false, field: "mobile" });
  });
});
