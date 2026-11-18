/**
 * Copy rendered in pieces for the Before launch preview (ticket 12c): the same merge-field rule
 * as `render` in sequence/copy.ts, which the handover uses, but keeping which text is the lead's
 * own value, a fallback, or a field the lead lacks with no fallback. Joined, the pieces are
 * exactly what `render` sends (copy-preview.test.ts checks that against `render`).
 */
import { mergeParts, type MergeData } from "./sequence/copy.ts";

export interface Segment {
  readonly text: string;
  readonly kind: "literal" | "value" | "fallback" | "missing";
  readonly field?: string;
}

/** The copy in pieces, its tokens read by the parser `render` uses (`mergeParts`), so the two cannot disagree. */
export function renderSegments(text: string, data: MergeData): Segment[] {
  return mergeParts(text).map((part): Segment => {
    if ("literal" in part) return { text: part.literal, kind: "literal" };
    const { field, fallback } = part.use;
    const value = data[field.trim()]?.trim();
    if (value) return { text: value, kind: "value", field };
    if (fallback !== null) return { text: fallback, kind: "fallback", field };
    return { text: "", kind: "missing", field };
  });
}

/** Fields with no fallback that this lead lacks, in order of first use. */
export const missingFields = (segments: readonly Segment[]): string[] => [...new Set(segments.filter((s) => s.kind === "missing").map((s) => s.field ?? ""))];
