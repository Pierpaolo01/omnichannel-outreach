import { useEffect, useRef, type RefObject } from "react";

/**
 * Keyboard focus is never left on the page body (ADR 0003 4.4.1 by way of docs/agents/ui.md): when
 * a control the user had focused inside `container` is removed, replaced or disabled, focus goes to
 * the best control left, by `data-rescue` rank (lower first, then page order), else the first
 * control in the container. Ranks used on Calls and Today:
 *   1 Open the next call · 2 a retry, or the next kept refusal's Dismiss · 3 the chosen number ·
 *   4 another good number · 5 Back to Today, Start calling.
 * A transition with a destination of its own (the next call's number after an outcome, and so on)
 * places focus first; this only catches what would otherwise fall to the body.
 *
 * A list whose entries a read can remove (`data-rescue-list`, each entry `data-rescue-item` with a stable key, such as
 * Needs attention on Today; verifier on PR 58) keeps focus in the list: the entry that took the focused one's place, or
 * the next one after it as the list stood when focus entered it, else the previous one, else the list's heading
 * (`data-rescue-heading`). With nothing left to focus, `data-rescue-fallback` (Today's greeting) takes it.
 */
export function useFocusRescue(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let inside = false;
    /** The list entry focus was last in: its list, its key, and the list's keys at that moment, in order. */
    let entry: { list: string; key: string; keys: string[] } | null = null;
    const onIn = (e: FocusEvent) => {
      inside = true;
      const item = e.target instanceof Element ? e.target.closest("[data-rescue-item]") : null;
      const list = item?.closest("[data-rescue-list]");
      entry =
        item && list
          ? { list: list.getAttribute("data-rescue-list") ?? "", key: item.getAttribute("data-rescue-item") ?? "", keys: [...list.querySelectorAll("[data-rescue-item]")].map((el) => el.getAttribute("data-rescue-item") ?? "") }
          : null;
    };
    const onOut = (e: FocusEvent) => {
      // Focus moved on purpose to somewhere else on the page: not ours to rescue.
      if (e.relatedTarget instanceof Node && !container.contains(e.relatedTarget)) inside = false;
    };
    const rescue = () => {
      const active = document.activeElement;
      const lost = active === null || active === document.body || (active instanceof HTMLElement && container.contains(active) && (active.matches(":disabled") || !active.isConnected));
      if (!inside || !lost) return;
      const usable = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && !el.matches(":disabled") && el.getClientRects().length > 0;
      const target = inList(usable) ?? ranked(usable) ?? [...container.querySelectorAll("[data-rescue-fallback]")].find(usable);
      target?.focus();
    };
    const ranked = (usable: (el: Element | null | undefined) => el is HTMLElement): HTMLElement | undefined => {
      const byRank = [...container.querySelectorAll("[data-rescue]")].filter(usable).sort((a, b) => Number(a.dataset["rescue"]) - Number(b.dataset["rescue"]));
      return byRank[0] ?? [...container.querySelectorAll("a[href], button, input, select, textarea")].find(usable);
    };
    /** Within the list focus was in: the same entry, the next, the previous, then its heading. */
    const inList = (usable: (el: Element | null | undefined) => el is HTMLElement): HTMLElement | undefined => {
      if (!entry) return undefined;
      const was = entry;
      const list = [...container.querySelectorAll("[data-rescue-list]")].find((el) => el.getAttribute("data-rescue-list") === was.list);
      if (!list) return undefined;
      const control = (key: string) => {
        const item = [...list.querySelectorAll("[data-rescue-item]")].find((el) => el.getAttribute("data-rescue-item") === key);
        return item?.querySelector("a[href], button, input, select, textarea");
      };
      const at = was.keys.indexOf(was.key);
      const order = [was.key, ...was.keys.slice(at + 1), ...was.keys.slice(0, Math.max(at, 0)).reverse()];
      for (const key of order) {
        const c = control(key);
        if (usable(c)) return c;
      }
      const heading = list.querySelector("[data-rescue-heading]");
      return usable(heading) ? heading : undefined;
    };
    // A pointer press outside a control is the user putting focus down: not a loss to rescue.
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("a[href], button, input, select, textarea, label")) inside = false;
    };
    document.addEventListener("pointerdown", onPointer);
    const observer = new MutationObserver(() => queueMicrotask(rescue));
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
    container.addEventListener("focusin", onIn);
    container.addEventListener("focusout", onOut);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointer);
      container.removeEventListener("focusin", onIn);
      container.removeEventListener("focusout", onOut);
    };
  }, []);
  return ref;
}
