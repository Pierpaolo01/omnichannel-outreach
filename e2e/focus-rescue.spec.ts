import { expect, test, type Page } from "@playwright/test";
import { callbackWithNoGoodNumber, carriedAndOverdue, focused, freshCalls, logElsewhere, logWithMouse, openCalls } from "./screens.ts";
import { serverError } from "./mocks.ts";

/**
 * Standing check (re-check on b15a769, item 10): every enabled button on the Calls and Today pages,
 * in each state that has its own buttons, is found on the page (not from a hand list), activated by
 * keyboard, and must leave focus on a control, never the page body. Each button gets a fresh app and
 * page. Requests failed on purpose to reach a state are let through before activating, so a retry
 * succeeds. Links are left out: following one goes to another page.
 */
interface Setup {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
}

const ready = (name: string) => async (page: Page) => {
  const f = await freshCalls("ready", name);
  await page.goto(`${f.url}/calls`);
  await page.getByText(/^Calling hours /).waitFor();
};

const SETUPS: readonly Setup[] = [
  { name: "Calls, a call ready", open: ready("rescue-ready") },
  {
    name: "Calls, an outcome chosen",
    open: async (page) => {
      await ready("rescue-chosen")(page);
      await page.getByRole("button", { name: "No answer", exact: true }).click();
    },
  },
  {
    name: "Calls, the call logged in another window",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-away");
      await page.goto(`${f.url}/calls`);
      await page.getByText(/^Calling hours /).waitFor();
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "voicemail", t.numberId);
      await logWithMouse(page, "No answer");
      await page.getByRole("button", { name: "Open the next call" }).waitFor();
    },
  },
  {
    name: "Calls, an outcome from a closed tab not logged",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-record");
      const t = await focused(f);
      await logElsewhere(f, t.taskId, "interested", t.numberId);
      await page.addInitScript(([taskId, numberId]) => {
        const body = { requestId: "left-by-a-closed-tab", outcome: "no_answer", numberId, note: "Front desk.", noteScope: "person" };
        window.localStorage.setItem("outreach.calls.outbox.left-by-a-closed-tab", JSON.stringify({ v: 2, taskId, who: "Amira Hassan", body }));
      }, [t.taskId, t.numberId] as const);
      await page.goto(`${f.url}/calls`);
      await page.getByRole("button", { name: "Dismiss" }).waitFor();
    },
  },
  {
    name: "Calls, an outcome not confirmed yet",
    open: async (page) => {
      await ready("rescue-unconfirmed")(page);
      await page.route("**/api/call-tasks/*/outcome", (route) => route.abort());
      await logWithMouse(page, "No answer");
      await page.getByRole("button", { name: "Try again now" }).waitFor();
    },
  },
  {
    name: "Calls, the call didn't load",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-task-error");
      await page.route("**/api/call-tasks/*", (route) => (route.request().method() === "GET" ? serverError(route) : route.continue()));
      await page.goto(`${f.url}/calls`);
      await page.getByText("This call didn’t load.").waitFor();
    },
  },
  {
    name: "Calls, the list didn't load",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-queue-error");
      await page.route("**/api/calls*", serverError);
      await page.goto(`${f.url}/calls`);
      await page.getByText("The call list didn’t load.").waitFor();
    },
  },
  // Ticket 15b.
  {
    name: "Calls, a redial chosen",
    open: async (page) => {
      await ready("rescue-redial")(page);
      await page.getByRole("button", { name: "No answer", exact: true }).click();
      await page.getByRole("checkbox", { name: /Call again tomorrow/ }).check();
    },
  },
  {
    name: "Calls, a callback time entered",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-callback");
      await openCalls(page, f);
      await page.getByRole("button", { name: "Callback requested", exact: true }).click();
      await page.getByLabel("Their time", { exact: true }).fill("15:30");
    },
  },
  { name: "Calls, an overdue callback", open: async (page) => openCalls(page, await carriedAndOverdue("rescue-overdue")) },
  { name: "Calls, a callback with no good number left", open: async (page) => openCalls(page, await callbackWithNoGoodNumber("rescue-q13")) },
  {
    name: "Today, an overdue callback",
    open: async (page) => {
      await openCalls(page, await carriedAndOverdue("rescue-today-overdue"), "/");
      await page.getByText("Tom’s callback is overdue").waitFor();
    },
  },
  {
    name: "Today, nothing loaded",
    open: async (page) => {
      const f = await freshCalls("ready", "rescue-today-error");
      await page.route("**/api/today*", serverError);
      await page.goto(f.url);
      await page.getByText("Today’s calls didn’t load.").waitFor();
    },
  },
];

const buttons = (page: Page) => page.locator("main button:enabled");

for (const setup of SETUPS) {
  test(`${setup.name}: every button leaves focus on a control`, async ({ context }) => {
    const first = await context.newPage();
    await setup.open(first);
    const names = await buttons(first).evaluateAll((els) => els.map((el) => el.textContent.trim()));
    await first.close();
    expect(names.length).toBeGreaterThan(0);
    for (const [i, name] of names.entries()) {
      const page = await context.newPage();
      await setup.open(page);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const button = buttons(page).nth(i);
      await button.focus();
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const where = await page.evaluate(() => (document.activeElement === document.body ? "body" : `${document.activeElement?.tagName} ${document.activeElement?.textContent.trim().slice(0, 40) ?? ""}`));
      expect(where, `after "${name}"`).not.toBe("body");
      await page.close();
    }
  });
}
