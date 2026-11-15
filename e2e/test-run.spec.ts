import { expect, test, type Page } from "@playwright/test";
import type { CampaignDefinition } from "../src/domain/sequence/definition.ts";
import { fakeTestRunApp, OWN_TEST_EMAIL, OWN_TEST_MOBILE, type FakeTestRunApp } from "./fake-provider.ts";

/**
 * Ticket 21's demonstration (recorded with RECORD_DEMO=1), on the fake providers with fictitious contacts: test contacts
 * (a lead's refused), Run test, the test email and texts received on the fake test contact, a test call logged Not
 * interested that takes the canvas's win-back path, a repeat after an edit stopped by a reply from the test email, and a
 * launch with the "no test since the last edit" warning. EVIDENCE_DIR=<dir> saves screenshots there, in both themes.
 */

const MIN = 60_000;

const linger = async (page: Page) => {
  if (process.env["RECORD_DEMO"]) await page.waitForTimeout(2_000);
};

async function at(page: Page, f: FakeTestRunApp, path: string): Promise<void> {
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url + path);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["EVIDENCE_DIR"];
  if (!dir) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: `${dir}/${name}-${theme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const sentTo = (f: FakeTestRunApp, destination: string) => [...f.harness.fake.deliveryLog, ...f.harness.sms.deliveryLog].filter((d) => d.destination === destination);

test("test contacts, Run test, the test call's win-back path, a reply stopping a repeat after an edit, and a launch with the warning", async ({ page }) => {
  test.setTimeout(240_000);
  const f = await fakeTestRunApp("demonstration");
  const tab = `/campaigns/${f.campaign}/test-run`;

  await test.step("the Test run tab before any test: no contacts yet", async () => {
    await at(page, f, tab);
    await expect(page.getByRole("heading", { name: "No test yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run test" })).toBeDisabled();
    await shot(page, "01-test-contacts-empty");
    await linger(page);
  });

  await test.step("a lead's email is refused as a test contact; the user's own are saved", async () => {
    await page.getByLabel("Your email").fill("amira@harbourlanephysio.example");
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("This email belongs to a lead. Test contacts must be your own.")).toBeVisible();
    await shot(page, "02-test-contact-refused");
    await linger(page);
    await page.getByLabel("Your email").fill(OWN_TEST_EMAIL);
    await page.getByLabel("Your mobile, for texts and the test call").fill("+44 7700 900456");
    await page.getByRole("button", { name: "Save contacts" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run test" })).toBeEnabled();
    await shot(page, "03-test-contacts-saved");
    await linger(page);
  });

  await test.step("Run test: the emails and texts arrive on the test contacts, a minute apart, and nothing goes to a lead", async () => {
    await page.getByLabel("Copy written for").selectOption({ label: "Amira Hassan" });
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await f.harness.advanceTo(f.harness.clock + 30_000);
    await at(page, f, tab);
    await expect(page.getByText("In about 1 min").first()).toBeVisible();
    await shot(page, "04-test-running");
    await linger(page);
    await f.harness.advanceTo(f.harness.clock + 3 * MIN);
    expect(sentTo(f, OWN_TEST_EMAIL).map((d) => d.stepId)).toEqual(["s1", "s2"]);
    expect(sentTo(f, OWN_TEST_MOBILE).map((d) => d.stepId)).toEqual(["m1", "m2"]);
    expect(sentTo(f, OWN_TEST_EMAIL)[0]?.rendered.body).toContain("Hi Amira,");
    expect([...f.harness.fake.deliveryLog, ...f.harness.sms.deliveryLog].every((d) => d.subjectId.startsWith("test-"))).toBe(true);
    await at(page, f, tab);
    await expect(page.getByText("On your Calls list")).toBeVisible();
    await shot(page, "05-test-sends-and-call");
    await linger(page);
  });

  await test.step("the test call is on the Calls list; Not interested takes the canvas's win-back path", async () => {
    await at(page, f, "/calls");
    await expect(page.getByText(/To your test mobile/).first()).toBeVisible();
    await shot(page, "06-test-call-on-the-list");
    await linger(page);
    await page.getByRole("group", { name: "Call outcome" }).getByRole("button", { name: "Not interested", exact: true }).click();
    await linger(page);
    await page.getByRole("button", { name: /^Log/ }).first().click();
    await f.harness.advanceTo(f.harness.clock + 3 * MIN);
    expect(sentTo(f, OWN_TEST_EMAIL).map((d) => d.stepId)).toEqual(["s1", "s2", "w1"]);
    await at(page, f, tab);
    await expect(page.getByRole("heading", { name: /Finished: every step ran/ })).toBeVisible();
    await expect(page.getByText(/Logged \d\d:\d\d: Not interested/)).toBeVisible();
    await shot(page, "07-test-finished-win-back");
    await linger(page);
  });

  await test.step("an edit: the warning returns; the repeat is stopped by a reply from the test email", async () => {
    const stored = (await f.harness.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${f.campaign}/sequence`)).body.definition;
    await f.harness.request("PUT", `/api/campaigns/${f.campaign}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === "email" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, subject: "Evening bookings for {{company}}" } : s)) } : t)) });
    await at(page, f, tab);
    await expect(page.getByText("No test since the last edit. That’s optional: you can launch without one.")).toBeVisible();
    await page.getByRole("button", { name: "Run test again" }).click();
    await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
    await f.harness.advanceTo(f.harness.clock + 30_000);
    expect(f.harness.fake.prospectReplies(OWN_TEST_EMAIL)).toBe(true);
    await f.harness.advanceTo(f.harness.clock + 2 * MIN);
    await at(page, f, tab);
    await expect(page.getByRole("heading", { name: /Stopped by your reply/ })).toBeVisible();
    expect(sentTo(f, OWN_TEST_EMAIL).filter((d) => d.stepId === "s2")).toHaveLength(1);
    await shot(page, "08-test-stopped-by-reply");
    await linger(page);
  });

  await test.step("another edit, and a launch with the warning: it never blocks", async () => {
    const stored = (await f.harness.request<{ definition: CampaignDefinition }>("GET", `/api/campaigns/${f.campaign}/sequence`)).body.definition;
    await f.harness.request("PUT", `/api/campaigns/${f.campaign}/sequence`, { ...stored, tracks: stored.tracks.map((t) => (t.id === "sms" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, body: `${s.body} Thanks!` } : s)) } : t)) });
    await at(page, f, `/campaigns/${f.campaign}/before-launch`);
    await expect(page.getByText("No test run since your last edit")).toBeVisible();
    await expect(page.getByText("You haven’t run a test since your last edit; that’s optional.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Run test first" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch campaign" })).toBeEnabled();
    await shot(page, "09-before-launch-warning");
    await linger(page);
    await page.getByRole("button", { name: "Launch campaign" }).click();
    await expect(page.getByText(/^Launched /).first()).toBeVisible();
    await shot(page, "11-launched-with-the-warning");
    await linger(page);
  });
});

test("the Test run tab at 390 px", async ({ page }) => {
  const f = await fakeTestRunApp("narrow");
  await f.harness.request("PUT", `/api/campaigns/${f.campaign}/test-contacts`, { email: OWN_TEST_EMAIL, mobile: OWN_TEST_MOBILE });
  await page.setViewportSize({ width: 390, height: 844 });
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await page.getByRole("button", { name: "Run test" }).click();
  await f.harness.advanceTo(f.harness.clock + 30_000);
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  await shot(page, "10-test-running-390");
});

test("contacts saved as typed in another form show as stored, and Run test is offered (review bot on 55d6ac6)", async ({ page }) => {
  const f = await fakeTestRunApp("normalized");
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await page.getByLabel("Your email").fill("Alex.Own@Personal-Mail.example");
  await page.getByLabel("Your mobile, for texts and the test call").fill("+447700900456");
  await page.getByRole("button", { name: "Save contacts" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByLabel("Your email")).toHaveValue(OWN_TEST_EMAIL);
  await expect(page.getByLabel("Your mobile, for texts and the test call")).toHaveValue("+44 7700 900456");
  await expect(page.getByRole("button", { name: "Save contacts" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run test" })).toBeEnabled();
  await expect(page.getByText("Save your contacts to run a test with them.")).toHaveCount(0);
  // Typing the stored mobile in another form is not a change either.
  await page.getByLabel("Your mobile, for texts and the test call").fill("+447700900456");
  await expect(page.getByRole("button", { name: "Run test" })).toBeEnabled();
});

test("a reload while Run test waits shows it pending, never the test before it, and sends the same request until answered (verifier F3 on 55d6ac6)", async ({ page }) => {
  const f = await fakeTestRunApp("reload-while-starting");
  const c = `/api/campaigns/${f.campaign}`;
  await f.harness.request("PUT", `${c}/test-contacts`, { email: OWN_TEST_EMAIL, mobile: "" });
  const first = (await f.harness.request<{ definitionVersion: number; leads: { id: string }[] }>("GET", `${c}/test-runs`)).body;
  const ran = (await f.harness.request<{ run: { id: string } }>("POST", `${c}/test-runs`, { requestId: "earlier", renderAs: first.leads[0]?.id ?? "", expect: { definitionVersion: first.definitionVersion } })).body;
  await f.harness.request("POST", `/api/test-runs/${ran.run.id}/stop`, { requestId: "earlier-stop" });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const bodies: string[] = [];
  await page.route("**/api/campaigns/*/test-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postData() ?? "");
    await gate;
    await route.continue().catch(() => undefined);
  });
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await expect(page.getByRole("heading", { name: /^Stopped/ })).toBeVisible();
  await page.getByRole("button", { name: "Run test again" }).click();
  await expect(page.getByRole("heading", { name: "Starting a test…" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Starting a test…" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Stopped/ })).toHaveCount(0);
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toBe(bodies[0]);
  release();
  await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Started at/ })).toBeVisible();
  expect((await f.harness.request<{ run: { id: string; running: boolean } }>("GET", `${c}/test-runs`)).body.run.running).toBe(true);
});

test("focus stays with what happened: Saved after Save contacts, the result after Run and Stop (verifier F4 on 55d6ac6)", async ({ page }) => {
  const f = await fakeTestRunApp("focus");
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await page.getByLabel("Your email").fill(OWN_TEST_EMAIL);
  // Saved with the button, which is disabled while the save waits: focus goes to the line that says what happened.
  await page.getByRole("button", { name: "Save contacts" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Saved.")).toBeFocused();
  await page.getByRole("button", { name: "Run test" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The test started. Its steps are on the right.")).toBeFocused();
  await page.getByRole("button", { name: "Stop test" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The test is stopped. Nothing more goes to your test contacts.")).toBeFocused();
});

test("a second save while one waits goes after its answer, and the fields and the server keep the newest contact; focus stays where the user types (review bot on ffa202c; verifier R1 and item 16)", async ({ page }) => {
  const f = await fakeTestRunApp("save-race");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const puts: { body: string; at: number }[] = [];
  let answered = 0;
  await page.route("**/api/campaigns/*/test-contacts", async (route) => {
    puts.push({ body: route.request().postData() ?? "", at: answered });
    if (puts.length === 1) await gate;
    await route.continue();
    answered++;
  });
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  const email = page.getByLabel("Your email");
  await email.fill("alex.first@personal-mail.example");
  await email.press("Enter");
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await email.fill("alex.second@personal-mail.example");
  await email.press("Enter");
  // One save in flight: the second waits for the first's answer.
  await expect.poll(() => puts.length).toBe(1);
  release();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]?.at).toBe(1);
  expect(JSON.parse(puts[1]?.body ?? "{}")).toMatchObject({ email: "alex.second@personal-mail.example" });
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(email).toHaveValue("alex.second@personal-mail.example");
  expect((await f.harness.request<{ contacts: { email: string } }>("GET", `/api/campaigns/${f.campaign}/test-runs`)).body.contacts.email).toBe("alex.second@personal-mail.example");
  // The user kept typing in the field while it saved: focus stayed there.
  await expect(email).toBeFocused();
});

test("after Run test's answer, the run it started shows while the next read is on its way, never the run before it (verifier re-check, item 15)", async ({ page }) => {
  const f = await fakeTestRunApp("answer-until-read");
  const c = `/api/campaigns/${f.campaign}`;
  await f.harness.request("PUT", `${c}/test-contacts`, { email: OWN_TEST_EMAIL, mobile: "" });
  const first = (await f.harness.request<{ definitionVersion: number; leads: { id: string }[] }>("GET", `${c}/test-runs`)).body;
  const ran = (await f.harness.request<{ run: { id: string } }>("POST", `${c}/test-runs`, { requestId: "before", renderAs: first.leads[0]?.id ?? "", expect: { definitionVersion: first.definitionVersion } })).body;
  await f.harness.request("POST", `/api/test-runs/${ran.run.id}/stop`, { requestId: "before-stop" });
  await at(page, f, `/campaigns/${f.campaign}/test-run`);
  await expect(page.getByRole("heading", { name: /^Stopped/ })).toBeVisible();
  let posted = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/campaigns/*/test-runs", async (route) => {
    if (route.request().method() === "POST") {
      posted = true;
      return route.continue();
    }
    if (posted) await gate;
    return route.continue();
  });
  await page.getByRole("button", { name: "Run test again" }).click();
  await expect(page.getByRole("button", { name: "Test running" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Started at/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Stopped/ })).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: /^Started at/ })).toBeVisible();
});
