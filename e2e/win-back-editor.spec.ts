import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Campaign, SequenceView } from "../src/shared/api.ts";
import { WITH_A_BRANCH, WITH_A_CALL, phoneTrack } from "./screens.ts";
import { fixture } from "./support.ts";

/**
 * Ticket 16b, as the user uses it, by keyboard: a phone track's declined path, and the win-back branch
 * on the canvas, added, arranged, edited and removed through the editor's one save path. All data is
 * fictitious; nothing is sent.
 */
async function campaign(page: Page, name: string, definition = WITH_A_CALL): Promise<string> {
  const created = await page.request.post("/api/campaigns", { data: { name, businessesCsv: readFileSync(fixture("businesses-run1.csv"), "utf8"), peopleCsv: readFileSync(fixture("people-run1.csv"), "utf8") } });
  const id = ((await created.json()) as { campaign: Campaign }).campaign.id;
  expect((await page.request.put(`/api/campaigns/${id}/sequence`, { data: definition })).status()).toBe(200);
  return id;
}
const saved = (page: Page) => expect(page.getByTestId("inspector").getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
const stored = async (page: Page, id: string) => ((await (await page.request.get(`/api/campaigns/${id}/sequence`)).json()) as SequenceView).definition;

test.describe("the declined path and the win-back branch in the campaign editor (ticket 16b)", () => {
  test("by keyboard: choose a path, build the branch, arrange it, offer win back, and take it apart again", async ({ page }) => {
    const id = await campaign(page, "Win back by keyboard");
    await page.goto(`/campaigns/${id}?track=call`);
    const inspector = page.getByTestId("inspector");
    const paths = inspector.getByRole("radiogroup", { name: "If they decline on the call" });

    // Continue, by arrow key from Stop; saved through the one save path, and said on the phone track's node.
    await paths.getByRole("radio", { name: /^Stop/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(paths.getByRole("radio", { name: /^Continue/ })).toBeChecked();
    await saved(page);
    expect((await stored(page, id)).tracks.find((t) => t.id === "call")?.declinedPath).toBe("continue");
    await expect(page.getByRole("button", { name: /^Phone track: / })).toContainText("If declined: continue other channels");
    // Win back is not offered until the branch has a track.
    await expect(paths.getByRole("radio", { name: /^Win back/ })).toBeDisabled();

    // The empty branch says what it is, and adds an email track: focus lands on its first subject.
    const box = page.getByTestId("win-back-branch");
    await expect(box).toContainText("No tracks yet.");
    await page.getByRole("button", { name: "Add a win-back email track" }).focus();
    await page.keyboard.press("Enter");
    await expect(inspector.getByRole("heading", { name: "Win-back email track" })).toBeVisible();
    await expect(page.getByLabel("Email 1 subject")).toBeFocused();
    await page.keyboard.type("Another way to fill evenings");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Understood, {{first_name|there}}. One last idea, then I will leave it.");
    await saved(page);
    // It starts when the lead enters the branch, and only its own branch's tracks are offered to start after.
    await expect(page.getByLabel("How this track starts")).toHaveValue("entry");
    await expect(page.getByLabel("How this track starts").locator("option")).toHaveText(["When the lead enters win-back"]);

    // Back on the phone track: win back can now be chosen, and the dashed edge is drawn to the branch.
    await page.getByRole("button", { name: /^Phone track: / }).focus();
    await page.keyboard.press("Enter");
    await paths.getByRole("radio", { name: /^Continue/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(paths.getByRole("radio", { name: /^Win back/ })).toBeChecked();
    await saved(page);
    await expect(inspector.getByRole("list", { name: "The win-back branch’s tracks" })).toContainText("Win-back email track · 1 email");
    await expect(page.locator('[data-edge-from="call"]')).toHaveCount(1);
    expect((await stored(page, id)).tracks.find((t) => t.id === "call")?.declinedPath).toBe("win_back");

    // The branch's own Add offers email and SMS only: no phone track in win-back.
    await page.getByRole("button", { name: "Add win-back track" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveText(["Email track", "SMS track"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(inspector.getByRole("heading", { name: "Win-back SMS track" })).toBeVisible();
    await expect(page.getByLabel("Text 1 message")).toBeFocused();
    await page.keyboard.type("Hi {{first_name|there}}, no pressure: one last thought on evening bookings.");
    // After the win-back email track, plus 2 days; the main sequence's tracks are never offered.
    const starts = page.getByLabel("How this track starts");
    await expect(starts.locator("option")).toHaveText(["When the lead enters win-back", "After the win-back email track"]);
    await starts.selectOption({ label: "After the win-back email track" });
    await page.getByLabel("Days after that track finishes").fill("2");
    await saved(page);
    await expect(box.getByRole("list", { name: "Tracks after the win-back email track" }).getByRole("button", { name: /^Win-back SMS track: / })).toBeVisible();
    const arranged = await stored(page, id);
    const email = arranged.tracks.find((t) => t.branch === "win_back" && t.channel === "email")!;
    expect(arranged.tracks.find((t) => t.branch === "win_back" && t.channel === "sms")).toMatchObject({ start: { kind: "after", trackId: email.id, delayDays: 2 } });

    // Removing: the SMS track goes (focus to the branch's Add); the last track is refused while win back is chosen.
    await page.getByRole("button", { name: "Remove this win-back SMS track" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Add win-back track" })).toBeFocused();
    await page.getByRole("button", { name: /^Win-back email track: / }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Remove this win-back email track" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "The phone track's declined path is win back, but the win-back branch has no tracks: add a track to it, or choose stop or continue." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove this win-back email track" })).toBeFocused();
    expect((await stored(page, id)).tracks.some((t) => t.branch === "win_back" && !t.removed)).toBe(true);

    // Stop instead, then the last branch track goes and the branch is empty again.
    await page.getByRole("button", { name: /^Phone track: / }).focus();
    await page.keyboard.press("Enter");
    await paths.getByRole("radio", { name: /^Win back/ }).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(paths.getByRole("radio", { name: /^Stop/ })).toBeChecked();
    await page.getByRole("button", { name: /^Win-back email track: / }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Remove this win-back email track" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Add a win-back email track" })).toBeFocused();
    await expect(box).toContainText("No tracks yet.");
    await expect(page.locator("[data-edge-from]")).toHaveCount(0);
    await expect.poll(async () => {
      const def = await stored(page, id);
      return [def.tracks.find((t) => t.id === "call")?.declinedPath, def.tracks.filter((t) => t.branch === "win_back" && !t.removed).length];
    }).toEqual(["stop", 0]);
  });

  test("a branch track opens in the same inspector as any track of its channel: its copy, sender and window save like the main sequence's", async ({ page }) => {
    const id = await campaign(page, "A branch track's inspector", WITH_A_BRANCH);
    await page.goto(`/campaigns/${id}?track=wb-email`);
    const inspector = page.getByTestId("inspector");
    await expect(inspector.getByRole("heading", { name: "Win-back email track" })).toBeVisible();
    await expect(inspector.getByText("No connected sender inbox.")).toBeVisible();
    await page.getByLabel("Email 1 subject").fill("A different idea for {{company}}");
    await inspector.getByRole("button", { name: "Saturday" }).click();
    await saved(page);
    const track = (await stored(page, id)).tracks.find((t) => t.id === "wb-email")!;
    expect(track.steps[0]?.subject).toBe("A different idea for {{company}}");
    expect(track.window.map((w) => w.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(track.branch).toBe("win_back");
  });

  test("Before launch names a branch track's blocker and opens it; Copy for a lead shows the branch's messages, undated", async ({ page }) => {
    const id = await campaign(page, "A branch in Before launch", WITH_A_BRANCH);
    await page.goto(`/campaigns/${id}/before-launch`);
    const blocker = page.getByRole("listitem").filter({ hasText: "The win-back SMS track has no connected sender number" });
    await expect(blocker).toBeVisible();
    const copy = page.getByRole("region", { name: "If they decline: the win-back branch" });
    await expect(copy.getByRole("list", { name: "The win-back branch’s messages" }).getByRole("listitem")).toHaveCount(3);
    await expect(copy.getByRole("listitem").first()).toContainText("Only if they decline");
    await blocker.getByRole("button", { name: "Open track" }).click();
    await expect(page.getByTestId("inspector").getByRole("heading", { name: "Win-back SMS track" })).toBeVisible();
  });

  test("Copy for a lead says how a lead can enter the branch, from the server: by the declined path, only if chosen for one lead, or never (council on aaf82b7)", async ({ page }) => {
    const branchTracks = WITH_A_BRANCH.tracks.filter((t) => t.branch === "win_back");
    const cases = [
      { name: "Win back by path", tracks: WITH_A_BRANCH.tracks, label: "Only if they decline", sentence: "These go only if this lead declines on a call and moves to the branch" },
      { name: "Win back by choice only", tracks: WITH_A_BRANCH.tracks.map((t) => (t.id === "call" ? { ...t, declinedPath: "continue" as const } : t)), label: "Only if chosen for them", sentence: "No phone track’s declined path is win back, so these go only if win back is chosen for this lead" },
      { name: "Win back never", tracks: [...WITH_A_CALL.tracks.filter((t) => t.channel !== "call").map((t) => (t.start.kind === "after" && t.start.trackId === "call" ? { ...t, start: { kind: "entry" as const } } : t)), ...branchTracks], label: "Never sent", sentence: "The campaign has no phone track to decline on, so no lead can enter the win-back branch: these are never sent." },
    ];
    for (const c of cases) {
      const id = await campaign(page, c.name, { ...WITH_A_BRANCH, tracks: c.tracks });
      await page.goto(`/campaigns/${id}/before-launch`);
      const copy = page.getByRole("region", { name: "If they decline: the win-back branch" });
      await expect(copy.getByText(c.sentence, { exact: false })).toBeVisible();
      const labels = await copy.getByRole("list", { name: "The win-back branch’s messages" }).getByRole("listitem").allTextContents();
      expect([c.name, labels.length > 0, labels.every((l) => l.includes(c.label))]).toEqual([c.name, true, true]);
    }
  });

  test("the branch never makes the canvas scroll sideways, at any width between the laptop sizes, with the inspector open (review bot on 8147ba6)", async ({ page }) => {
    // The bot's case: one phone track is the whole main sequence, so the tracks are drawn side by side.
    const onlyACall = { ...WITH_A_CALL, tracks: [phoneTrack("call", { kind: "entry" })] };
    const empty = await campaign(page, "Branch width, empty", onlyACall);
    const one = await campaign(page, "Branch width, one track", { ...onlyACall, tracks: [...onlyACall.tracks, WITH_A_BRANCH.tracks.find((t) => t.id === "wb-email")!] });
    const overflow: string[] = [];
    for (const id of [empty, one]) {
      for (let width = 1020; width <= 1440; width += 20) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/campaigns/${id}?track=call`);
        await page.getByTestId("win-back-branch").waitFor();
        const sideways = await page.getByTestId("canvas").evaluate((canvas) => {
          const area = canvas.querySelector<HTMLElement>(".overflow-auto");
          return area ? area.scrollWidth - area.clientWidth : 0;
        });
        if (sideways > 1) overflow.push(`${id === empty ? "empty branch" : "one branch track"} at ${width}px: ${sideways}px sideways`);
      }
    }
    expect(overflow).toEqual([]);
  });
});
