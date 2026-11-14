import { expect, test } from "@playwright/test";
import { SCREENS, seedData, type SeedData } from "./screens.ts";

/**
 * Standing check: no route or state scrolls sideways or clips content, at laptop widths and
 * down to a phone. Both the page and every scrollable or clipping element inside it are measured.
 */
const WIDTHS = [1440, 1024, 768, 390] as const;

let data: SeedData;
test.beforeAll(async ({ request }) => {
  data = await seedData(request);
});

for (const width of WIDTHS) {
  for (const screen of SCREENS) {
    test(`${screen.name} fits without sideways scrolling at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await screen.open(page, data);
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const problems: string[] = [];
        const describe = (el: Element) => {
          const text = el.textContent.trim().slice(0, 40);
          return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}> "${text}"`;
        };
        if (document.documentElement.scrollWidth > viewport) {
          problems.push(`page is ${document.documentElement.scrollWidth}px wide in a ${viewport}px viewport`);
        }
        // Screen-reader-only text (including responsive sr-only) is clipped to a 1px box on purpose.
        const visuallyHidden = (el: Element) => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const r = node.getBoundingClientRect();
            if (r.width <= 1 && r.height <= 1 && getComputedStyle(node).position === "absolute") return true;
          }
          return false;
        };
        for (const el of document.querySelectorAll("body *")) {
          if (["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(el.tagName) || visuallyHidden(el)) continue;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) continue;
          if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
            problems.push(`${describe(el)} needs ${el.scrollWidth}px but has ${el.clientWidth}px`);
          }
          if (box.right > viewport + 1 || box.left < -1) problems.push(`${describe(el)} reaches past the viewport edge`);
        }
        return problems;
      });
      expect(overflow).toEqual([]);

      // The canvas draws the stored arrangement at every width (council on 10121d3, item 2): each track
      // under the track it starts after (or Launch), tracks that start at one point side by side in a
      // row or sharing an indent in the outline, never as a chain; and Launch stays in view.
      const arrangement = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]');
        const match = /\/campaigns\/([^/?]+)/.exec(location.pathname);
        if (!canvas || !match) return [];
        const response = await fetch(`/api/campaigns/${match[1]}/sequence`);
        if (!response.ok) return [];
        type Track = { id: string; removed: boolean; branch: string; start: { kind: string; trackId?: string } };
        const tracks = ((await response.json()) as { definition: { tracks: Track[] } }).definition.tracks.filter((t) => !t.removed && t.branch === "main");
        const stacked = canvas.dataset["layout"] === "stacked";
        const launch = canvas.querySelector('[data-testid="launch-point"]');
        const box = (id: string | undefined) => (id === undefined ? launch : document.getElementById(`track-node-${id}`))?.getBoundingClientRect() ?? null;
        const parentOf = (t: Track) => (t.start.kind === "after" ? t.start.trackId : undefined);
        const problems: string[] = [];
        for (const t of tracks) {
          const b = box(t.id);
          const p = box(parentOf(t));
          if (!b || !p) {
            problems.push(`${t.id} or its parent is not drawn`);
            continue;
          }
          if (b.top < p.bottom - 1) problems.push(`${t.id} is not below ${parentOf(t) ?? "Launch"}`);
          // Past the depth the panel can indent, a track sits at its parent's indent and its label names
          // the parent (review bot on 7401eb2).
          const el = document.getElementById(`track-node-${t.id}`);
          const named = el?.closest("ul")?.dataset["outline"] === "named";
          if (stacked && named) {
            const pill = el.parentElement?.querySelector(":scope > span")?.textContent.toLowerCase() ?? "";
            const parentTitle = document.getElementById(`track-node-${parentOf(t) ?? ""}`)?.getAttribute("aria-label")?.split(":")[0]?.toLowerCase() ?? "?";
            if (!pill.includes(parentTitle)) problems.push(`${t.id} is drawn at its parent's indent, but its label "${pill}" does not name ${parentTitle}`);
            if (Math.abs(b.left - p.left) > 1) problems.push(`${t.id} is neither indented under ${parentOf(t) ?? "Launch"} nor at its indent`);
          } else if (stacked && b.left <= p.left + 4) problems.push(`${t.id} is not indented under ${parentOf(t) ?? "Launch"}`);
          const siblings = tracks.filter((x) => parentOf(x) === parentOf(t)).map((x) => box(x.id)).filter((x): x is DOMRect => x !== null);
          if (stacked && siblings.some((x) => Math.abs(x.left - b.left) > 1)) problems.push(`${t.id} does not share an indent with the tracks that start at the same point`);
          if (!stacked && siblings.some((x) => Math.abs(x.top - b.top) > 1)) problems.push(`${t.id} is not in one row with the tracks that start at the same point`);
          const centre = (p.left + p.right) / 2;
          if (!stacked && !(Math.min(...siblings.map((x) => x.left)) <= centre && centre <= Math.max(...siblings.map((x) => x.right)))) problems.push(`${t.id}'s row does not hang under ${parentOf(t) ?? "Launch"}`);
        }
        // Every node, label and connector stays inside the canvas panel, and every node's content inside
        // the node, at every width and depth (review bot on 7401eb2).
        const panel = canvas.getBoundingClientRect();
        const drawn = [...canvas.querySelectorAll<HTMLElement>('[id^="track-node-"], ul[data-outline], ul[data-outline] > li > span')];
        for (const el of drawn) {
          const r = el.getBoundingClientRect();
          if (r.left < panel.left - 1 || r.right > panel.right + 1) problems.push(`${el.id || el.textContent.slice(0, 30)} crosses the canvas panel's edge (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(panel.left)}–${Math.round(panel.right)})`);
          if (el.id && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.id}'s content needs ${el.scrollWidth}px but the node is ${el.clientWidth}px`);
        }
        const area = launch?.closest<HTMLElement>(".overflow-auto");
        if (launch && area && tracks.length > 0) {
          const before = area.scrollTop;
          area.scrollTop = area.scrollHeight;
          const l = launch.getBoundingClientRect();
          const a = area.getBoundingClientRect();
          if (l.top < a.top - 1 || l.bottom > a.bottom + 1) problems.push("Launch scrolls out of view in the canvas");
          area.scrollTop = before;
        }
        return problems;
      });
      expect(arrangement).toEqual([]);
    });
  }
}
