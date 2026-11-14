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
 */
export function useFocusRescue(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let inside = false;
    const onIn = () => {
      inside = true;
    };
    const onOut = (e: FocusEvent) => {
      // Focus moved on purpose to somewhere else on the page: not ours to rescue.
      if (e.relatedTarget instanceof Node && !container.contains(e.relatedTarget)) inside = false;
    };
    const rescue = () => {
      const active = document.activeElement;
      const lost = active === null || active === document.body || (active instanceof HTMLElement && container.contains(active) && (active.matches(":disabled") || !active.isConnected));
      if (!inside || !lost) return;
      const usable = (el: Element): el is HTMLElement => el instanceof HTMLElement && !el.matches(":disabled") && el.getClientRects().length > 0;
      const ranked = [...container.querySelectorAll("[data-rescue]")].filter(usable).sort((a, b) => Number(a.dataset["rescue"]) - Number(b.dataset["rescue"]));
      const target = ranked[0] ?? [...container.querySelectorAll("a[href], button, input, select, textarea")].find(usable);
      target?.focus();
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
