import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { openSqliteStore } from "./sqlite-store.ts";
import { CONVERSATION_INPUT_TABLES, CONVERSATION_INPUTS, CONVERSATION_LOOKUP_TABLES, CONVERSATION_PAIRS_QUERY } from "./sqlite-engine-store.ts";

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
    // Column by column: every column listed is one the query reads, and each table's update trigger watches exactly its list.
    for (const [table, columns] of Object.entries(CONVERSATION_INPUTS)) {
      if (columns === "*") continue;
      for (const c of columns) expect(sql.includes(`.${c}`) || sql.includes(` ${c} `), `${table}.${c} is read by the ownership query`).toBe(true);
      const update = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'conversations_%' AND sql LIKE '%AFTER UPDATE%'").all(table) as { sql: string }[]).map((r) => r.sql);
      expect(update, table).toHaveLength(1);
      const watchedColumns = /AFTER UPDATE OF ([a-z_, ]+) ON/.exec(update[0]!)?.[1]?.split(",").map((c) => c.trim()).sort();
      expect(watchedColumns, table).toEqual([...columns].sort());
    }
  });

  test("a write to a column the ownership rule does not read moves no version", () => {
    const store = openSqliteStore(":memory:", () => 0);
    const db = (store.engine as unknown as { db: DatabaseSync }).db;
    const total = () => (db.prepare("SELECT COALESCE(SUM(seq), 0) AS s FROM conversation_versions").get() as { s: number }).s;
    db.exec("INSERT INTO reply_events (event_id, inbox, address, at_wall, received_wall, state, last_counted_wall) VALUES ('sms:r2', '+447700900801', '+447700900811', 0, 0, 'pending', 0)");
    const before = total();
    db.exec("UPDATE reply_events SET waited_ms = 5, last_counted_wall = 7 WHERE event_id = 'sms:r2'");
    expect(total()).toBe(before);
  });

  test("every write to a reply moves its pair's destination: its state, its number, its mobile, and a delete (the re-check of 8c85b2f, item 3)", () => {
    const store = openSqliteStore(":memory:", () => 0);
    const db = (store.engine as unknown as { db: DatabaseSync }).db;
    const version = (key: string) => (db.prepare("SELECT seq FROM conversation_versions WHERE recipient_key = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;
    db.exec("INSERT INTO reply_events (event_id, inbox, address, at_wall, received_wall, state, last_counted_wall) VALUES ('sms:r1', '+447700900801', '+447700900811', 0, 0, 'pending', 0)");
    expect(version("+447700900811")).toBe(1);
    db.exec("UPDATE reply_events SET inbox = '+447700900802' WHERE event_id = 'sms:r1'");
    expect(version("+447700900811")).toBe(3);
    db.exec("UPDATE reply_events SET address = '+447700900812' WHERE event_id = 'sms:r1'");
    expect([version("+447700900811"), version("+447700900812")]).toEqual([4, 1]);
    db.exec("DELETE FROM reply_events WHERE event_id = 'sms:r1'");
    expect(version("+447700900812")).toBe(2);
    // Another destination's version never moves.
    expect(version("+447700900899")).toBe(0);
  });
});
