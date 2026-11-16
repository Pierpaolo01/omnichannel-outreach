import { expect, test, type Page } from "@playwright/test";
import type { NeedsAttention, TodayView } from "../src/shared/api.ts";
import { fakeCapacityApp } from "./fake-provider.ts";
import { callbackWithNoGoodNumber, carriedAndOverdue, focused, freshCalls, logElsewhere, logWithMouse, openCalls } from "./screens.ts";
import { respond, serverError } from "./mocks.ts";

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
    // Verifier on PR 58 (a06cdfc): a retry that loads into an empty Today removes the only control left.
    name: "Today, nothing loaded, then nothing to call and nothing needing you",
    open: async (page) => {
      const f = await fakeCapacityApp("rescue-empty-today");
      if (f.harness.clock < TUESDAY_9) await f.harness.advanceTo(TUESDAY_9);
      await page.route("**/api/today*", serverError);
      await page.clock.setFixedTime(f.harness.clock);
      await page.goto(f.url);
      await page.getByText("Today’s calls didn’t load.").waitFor();
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

/** Tuesday 10 November 2026 09:00 UTC: the capacity app's inbox has reset and sent the waiting email. */
const TUESDAY_9 = Date.parse("2026-11-10T09:00:00Z");

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

// ---------------------------------------------------------------------------------------------
// Needs attention entries that a refresh removes (verifier on PR 58, a06cdfc): focus goes to the next surviving entry in
// the list, else the previous one, else the list's heading. Never the page body.

/** Where the focused element is: a Needs attention entry's key, its heading, the body, or something else. */
const whereFocus = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    if (a.id === "needs-attention") return "heading";
    const item = a.closest("[data-rescue-item]");
    return item ? `entry ${item.getAttribute("data-rescue-item")}` : `${a.tagName} ${a.textContent.trim().slice(0, 40)}`;
  });

test("the verifier's case: the last entry's link is focused when capacity resets and the entry goes; focus moves to the list's heading", async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fakeCapacityApp("rescue-capacity-clears");
  await page.clock.setFixedTime(f.harness.clock);
  await page.goto(f.url);
  const link = page.getByRole("link", { name: /^Open .*’s record$/ });
  await link.waitFor();
  // By keyboard, as the verifier reached it.
  for (let i = 0; i < 20 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await f.harness.advanceTo(TUESDAY_9);
  await page.clock.setFixedTime(f.harness.clock);
  // The page reads again when the window regains focus (useLiveToday).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Nothing needs you.")).toBeVisible();
  await expect.poll(() => whereFocus(page)).toBe("heading");
});

type Reads = { today: TodayView; attention: NeedsAttention };

/**
 * How to remove one Needs attention entry from the reads, by the prefix of its key (`AttentionItem.key`). An entry kind
 * the page shows and this table does not know fails the scan below, so a new kind is covered by default.
 */
const REMOVE: Readonly<Record<string, (r: Reads, rest: string) => Reads>> = {
  "overdue-callbacks": (r) => ({ ...r, today: { ...r.today, overdueCallbacks: [] } }),
  "carried-over": (r) => ({ ...r, today: { ...r.today, carriedOver: 0, carriedOverLastDay: 0 } }),
  "sending-interrupted": (r) => ({ ...r, attention: { ...r.attention, sendingInterrupted: null } }),
  provider: (r, rest) => ({ ...r, attention: { ...r.attention, waitingOnProvider: r.attention.waitingOnProvider.filter((x) => x.channel !== rest) } }),
  sender: (r, rest) => ({ ...r, attention: { ...r.attention, senderProblems: r.attention.senderProblems.filter((x) => x.accountId !== rest) } }),
  wait: (r, rest) => ({ ...r, attention: { ...r.attention, accountWaits: r.attention.accountWaits.filter((x) => x.accountId !== rest) } }),
  stalled: (r, rest) => ({ ...r, attention: { ...r.attention, stalledInboxes: r.attention.stalledInboxes.filter((x) => x.accountId !== rest) } }),
  held: (r, rest) => ({ ...r, attention: { ...r.attention, heldCapacity: r.attention.heldCapacity.filter((x) => x.accountId !== rest) } }),
  // One entry per campaign and hold reason (the reviews of faac357, item 5): `tracks-<campaign>-<reason>`.
  tracks: (r, rest) => ({ ...r, attention: { ...r.attention, heldTracks: r.attention.heldTracks.filter((x) => `${x.campaign.id}-${x.reason}` !== rest) } }),
  capacity: (r, rest) => ({ ...r, attention: { ...r.attention, waitingForCapacity: r.attention.waitingForCapacity.filter((x) => x.campaign.id !== rest) } }),
  anomaly: (r) => ({ ...r, attention: { ...r.attention, anomalies: [] } }),
  "no-usable-channel": (r) => ({ ...r, attention: { ...r.attention, noUsableChannel: [] } }),
};

function removeEntry(reads: Reads, key: string): Reads {
  const exact = REMOVE[key];
  if (exact) return exact(reads, "");
  const dash = key.indexOf("-");
  const remove = REMOVE[key.slice(0, dash)];
  if (!remove) throw new Error(`Needs attention shows an entry kind the focus scan cannot remove: "${key}". Add it to REMOVE.`);
  return remove(reads, key.slice(dash + 1));
}

/** Every entry kind at once, two of the kinds that can repeat, over a calls app's real reads with an overdue callback and carried calls. */
function everyKind(r: Reads): Reads {
  const at = r.today.asOf;
  const lead = (i: number) => ({ person: { id: `person-${i}`, name: `Lead ${i}` }, company: { id: "company-1", name: "Harbour Lane Physio" }, campaign: { id: `campaign-${i}`, name: `Campaign ${i}` } });
  return {
    today: r.today,
    attention: {
      ...r.attention,
      sendingInterrupted: { since: at, cause: "providers_unreachable", lastFailedRead: null, lastRoundFailedAt: null },
      waitingOnProvider: [{ channel: "email", since: at, sends: 3 }, { channel: "sms", since: null, sends: 1 }],
      senderProblems: [{ accountId: "sms-1", channel: "sms", label: "+44 7700 900999", problem: "disconnected" }, { accountId: "inbox-2", channel: "email", label: "alex@northlight-mail.example", problem: "sending_off" }],
      accountWaits: [{ accountId: "inbox-3", reason: "quota", until: null }],
      stalledInboxes: [{ accountId: "inbox-4", holding: ["x"] }],
      heldCapacity: [{ accountId: "inbox-5", held: 1, capacity: 30, sentToday: 4, work: [] }],
      heldTracks: [{ person: { id: "p1", name: "Pat Oneil" }, company: { id: "c1", name: "Harbour Lane Physio" }, campaign: { id: "k1", name: "Clinics, London" }, enrollmentId: "e9", trackId: "t1", channel: "email", reason: "unresolved", owners: [] }],
      waitingForCapacity: [1, 2].map((i) => ({ ...lead(i), enrollmentId: `e-${i}`, campaignId: `campaign-${i}`, trackId: "t1", stepId: "s1", channel: "email" as const, dueAt: at, accountIds: ["inbox-a"], resetsAt: at })),
      anomalies: [{ what: "Something odd.", at }],
      noUsableChannel: [{ ...lead(3), enrollmentId: "n-1", campaignId: "campaign-3", endedAt: at, channels: [{ channel: "email", why: "missing", owners: [] }] }],
    },
  };
}

test("standing scan: removing any Needs attention entry by a refresh moves focus to the next entry, else the previous, else the heading", async ({ context }) => {
  test.setTimeout(240_000);
  const f = await carriedAndOverdue("rescue-attention-scan");
  /** Opens Today on the reads `shape` gives; `drop` then takes effect on the next read. */
  const open = async (page: Page, drop: { key: string | null }) => {
    let base: Reads | null = null;
    const reads = async (route: Parameters<Parameters<Page["route"]>[1]>[0]): Promise<Reads> => {
      if (!base) {
        const today = (await (await route.fetch({ url: `${f.url}/api/today` })).json()) as TodayView;
        const attention = (await (await route.fetch({ url: `${f.url}/api/needs-attention` })).json()) as NeedsAttention;
        base = everyKind({ today, attention });
      }
      return drop.key ? removeEntry(base, drop.key) : base;
    };
    await page.route("**/api/today", async (route) => respond(route, (await reads(route)).today));
    await page.route("**/api/needs-attention", async (route) => respond(route, (await reads(route)).attention));
    await page.clock.setFixedTime(f.harness.clock);
    await page.goto(f.url);
    await page.getByText("Something odd.").waitFor();
  };
  const first = await context.newPage();
  await open(first, { key: null });
  const keys = await first.locator("[data-rescue-item]").evaluateAll((els) => els.map((el) => ({ key: el.getAttribute("data-rescue-item") ?? "", linked: el.querySelector("a[href]") !== null })));
  await first.close();
  // Every kind the read can give is on the page.
  expect(keys.map((k) => k.key.replace(/-(email|sms|sms-1|inbox-\d|unresolved|campaign-\d|k\d-[a-z_]+)$/, ""))).toEqual(
    expect.arrayContaining(["overdue-callbacks", "carried-over", "sending-interrupted", "provider", "sender", "wait", "stalled", "held", "tracks", "capacity", "anomaly-0", "no-usable-channel"]),
  );
  for (const [j, k] of keys.entries()) {
    if (!k.linked) continue;
    const drop = { key: null as string | null };
    const page = await context.newPage();
    await open(page, drop);
    await page.locator(`[data-rescue-item="${k.key}"] a[href]`).focus();
    drop.key = k.key;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(`[data-rescue-item="${k.key}"]`)).toHaveCount(0);
    const left = await page.locator("[data-rescue-item]").evaluateAll((els) => els.filter((el) => el.querySelector("a[href]")).map((el) => el.getAttribute("data-rescue-item") ?? ""));
    const after = keys.slice(j + 1).find((x) => left.includes(x.key));
    const before = keys.slice(0, j).reverse().find((x) => left.includes(x.key));
    const expected = after ? `entry ${after.key}` : before ? `entry ${before.key}` : "heading";
    await expect.poll(() => whereFocus(page), { message: `after removing ${k.key}` }).toBe(expected);
    await page.close();
  }
});
