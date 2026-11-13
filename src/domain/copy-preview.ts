/**
 * Copy rendered in pieces for the Before launch preview (ticket 12c): the same merge-field rule
 * as `render` in sequence/copy.ts, which the handover uses, but keeping which text is the lead's
 * own value, a fallback, or a field the lead lacks with no fallback. Joined, the pieces are
 * exactly what `render` sends (copy-preview.test.ts checks that against `render`).
 */
import type { MergeData } from "./sequence/copy.ts";

export interface Segment {
  readonly text: string;
  readonly kind: "literal" | "value" | "fallback" | "missing";
  readonly field?: string;
}

/** The token syntax of sequence/copy.ts: `{{field}}` or `{{field|fallback}}`. */
const TOKEN = /\{\{\s*([^}|]*?)\s*(?:\|([^}]*))?\}\}/g;

export function renderSegments(text: string, data: MergeData): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  const literal = (to: number) => {
    if (to > last) out.push({ text: text.slice(last, to), kind: "literal" });
  };
  for (const m of text.matchAll(TOKEN)) {
    literal(m.index);
    const field = (m[1] ?? "").trim();
    const value = data[field]?.trim();
    if (value) out.push({ text: value, kind: "value", field });
    else if (m[2] !== undefined) out.push({ text: m[2], kind: "fallback", field });
    else out.push({ text: "", kind: "missing", field });
    last = m.index + m[0].length;
  }
  literal(text.length);
  return out;
}

/** Fields with no fallback that this lead lacks, in order of first use. */
export const missingFields = (segments: readonly Segment[]): string[] => [...new Set(segments.filter((s) => s.kind === "missing").map((s) => s.field ?? ""))];
