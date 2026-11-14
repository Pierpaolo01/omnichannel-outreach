/**
 * Message copy with merge fields: `{{first_name}}`, or `{{first_name|there}}` with a fallback.
 * Copy renders at the handover (ADR 0003 5.5), so a lead always gets the copy current then.
 */

export const MERGE_FIELDS = ["first_name", "last_name", "full_name", "title", "company", "city"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** A lead's values for the merge fields; a missing or blank value is absent. */
export type MergeData = Readonly<Partial<Record<string, string>>>;

const TOKEN = /\{\{\s*([^}|]*?)\s*(?:\|([^}]*))?\}\}/g;

export interface MergeUse {
  readonly field: string;
  readonly fallback: string | null;
}

export function mergeUses(text: string): MergeUse[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ field: m[1] ?? "", fallback: m[2] ?? null }));
}

/** `text` in order as literal pieces and merge-field uses, read as rendering reads them. */
export function mergeParts(text: string): ({ readonly literal: string } | { readonly use: MergeUse })[] {
  const out: ({ readonly literal: string } | { readonly use: MergeUse })[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push({ literal: text.slice(last, m.index) });
    out.push({ use: { field: m[1] ?? "", fallback: m[2] ?? null } });
    last = m.index + m[0].length;
  }
  if (text.length > last) out.push({ literal: text.slice(last) });
  return out;
}

/**
 * Rewrites each merge-field use in `text`: `rewrite` returns the new token, or null to keep it. The
 * editor changes fallbacks through this, so it reads tokens exactly as rendering does.
 */
export function rewriteMergeUses(text: string, rewrite: (use: MergeUse) => string | null): string {
  return text.replace(TOKEN, (all, field: string, fallback: string | undefined) => rewrite({ field, fallback: fallback ?? null }) ?? all);
}

export type Rendered = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly missing: readonly string[] };

/** Renders `text` for one lead. Fails, naming the fields, when a field without fallback is missing. */
export function render(text: string, data: MergeData): Rendered {
  const missing: string[] = [];
  const out = text.replace(TOKEN, (_all, field: string, fallback: string | undefined) => {
    const value = data[field.trim()]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing.push(field.trim());
    return "";
  });
  return missing.length > 0 ? { ok: false, missing: [...new Set(missing)] } : { ok: true, text: out };
}
