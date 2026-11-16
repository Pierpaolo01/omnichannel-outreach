import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { openSqliteStore } from "./sqlite-store.ts";
import { CONVERSATION_INPUT_TABLES, CONVERSATION_LOOKUP_TABLES, CONVERSATION_PAIRS_QUERY } from "./sqlite-engine-store.ts";

/**
 * The conversations' version and the ownership rule read the same list (ADR 0004, "The conversations' version"; the re-check
 * of dd3969c, item 1): every table the ownership query reads a fact from moves the version by trigger, and the query reads
 * nothing else but names and the lead's destinations. A table added to the query without its trigger fails here.
 */
describe("the conversations' version follows every input of the ownership rule", () => {
  test("every table the ownership query reads is an input with a version trigger, or a lookup", () => {
    const sql = CONVERSATION_PAIRS_QUERY.replace(/--[^\n]*/g, "");
    const read = [...new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()))].sort();
    const known: readonly string[] = [...CONVERSATION_INPUT_TABLES, ...CONVERSATION_LOOKUP_TABLES];
    expect(read.filter((t) => !known.includes(t))).toEqual([]);
    expect(CONVERSATION_INPUT_TABLES.filter((t) => !read.includes(t))).toEqual([]);
    const store = openSqliteStore(":memory:", () => 0);
    const db = (store.engine as unknown as { db: DatabaseSync }).db;
    const watched = new Set((db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'conversations_%'").all() as { tbl_name: string }[]).map((r) => r.tbl_name));
    expect(CONVERSATION_INPUT_TABLES.filter((t) => !watched.has(t))).toEqual([]);
  });
});
