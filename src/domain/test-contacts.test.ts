import { describe, expect, test } from "vitest";
import { contactsUnsaved, parseTestContacts } from "./test-contacts.ts";

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

describe("what the page has unsaved is decided by the server's own reading (review bot on 55d6ac6)", () => {
  const stored = { email: "alex.own@personal-mail.example", mobile: "+44 7700 900456" };
  test("an unspaced mobile and an address with capitals, as saved, are not unsaved changes", () => {
    expect(contactsUnsaved({ email: "Alex.Own@Personal-Mail.example", mobile: "+447700900456" }, stored)).toBe(false);
    expect(contactsUnsaved({ email: " alex.own@personal-mail.example ", mobile: "+44 7700 900456" }, stored)).toBe(false);
  });
  test("another contact, a cleared one, or one that cannot be read is unsaved", () => {
    expect(contactsUnsaved({ email: "alex.other@personal-mail.example", mobile: "+447700900456" }, stored)).toBe(true);
    expect(contactsUnsaved({ email: "", mobile: "+447700900456" }, stored)).toBe(true);
    expect(contactsUnsaved({ email: "alex at home", mobile: "+447700900456" }, stored)).toBe(true);
    expect(contactsUnsaved({ email: "", mobile: "" }, { email: null, mobile: null })).toBe(false);
  });
});

describe("the test LinkedIn profile is compared by its key too (ticket 24b)", () => {
  const stored = { email: null, mobile: null, linkedin: "https://www.linkedin.com/in/fictional-user-test-profile" };
  test("the same profile typed another way is saved; another one, or one cleared, is not", () => {
    expect(contactsUnsaved({ email: "", mobile: "", linkedin: "http://linkedin.com/in/Fictional-User-Test-Profile/" }, stored)).toBe(false);
    expect(contactsUnsaved({ email: "", mobile: "", linkedin: "https://www.linkedin.com/in/fictional-other" }, stored)).toBe(true);
    expect(contactsUnsaved({ email: "", mobile: "", linkedin: "" }, stored)).toBe(true);
  });
});
