import type { DatabaseSync } from "node:sqlite";

/**
 * Adds a channel to every CHECK that lists the social channels (ADR 0004 13.2): a sender account's channel, a reply's, the
 * stopping reply's on enrollments and test runs, and a pair's. SQLite cannot change a CHECK, so each table whose CHECK lists
 * `linkedin` is rebuilt by its documented procedure, its own text with the channel added: the triggers and views that name
 * it are dropped first and made again after, from their stored text, and its indexes are made again. `also` lists further
 * exact substitutions in the tables' text, made in the same rebuild. Run inside a migration with `rebuildsTables`. Facebook's
 * migration is one call of it.
 */
export function addChannel(db: DatabaseSync, channel: string, also: readonly { readonly from: string; readonly to: string }[] = []): void {
  if (!/^[a-z]+$/.test(channel)) throw new Error(`not a channel name: ${channel}`);
  const lists = /\b((?:stop_reply_)?channel IN \()([^)]*'linkedin'[^)]*)\)/g;
  const listsSome = new RegExp(lists.source);
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY rowid")
    .all()
    .map((r) => ({ name: String(r["name"]), sql: String(r["sql"]) }))
    .filter((t) => listsSome.test(t.sql) || also.some((a) => t.sql.includes(a.from)));
  if (tables.length === 0) return;
  const names = tables.map((t) => t.name);
  const mentions = (sql: string) => names.some((n) => new RegExp(`\\b${n}\\b`).test(sql));
  const dependants = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger', 'view', 'index') AND sql IS NOT NULL ORDER BY rowid")
    .all()
    .map((r) => ({ type: String(r["type"]), name: String(r["name"]), table: String(r["tbl_name"]), sql: String(r["sql"]) }))
    .filter((d) => names.includes(d.table) || (d.type !== "index" && mentions(d.sql)));
  for (const d of dependants.filter((x) => x.type === "trigger")) db.exec(`DROP TRIGGER ${d.name}`);
  for (const d of dependants.filter((x) => x.type === "view")) db.exec(`DROP VIEW ${d.name}`);
  for (const table of tables) {
    let sql = table.sql.replace(lists, (_all, head: string, items: string) => (items.includes(`'${channel}'`) ? `${head}${items})` : `${head}${items}, '${channel}')`));
    for (const a of also) sql = sql.split(a.from).join(a.to);
    const rebuilt = `${table.name}__with_${channel}`;
    const create = sql.replace(new RegExp(`^CREATE TABLE "?${table.name}"?`), `CREATE TABLE ${rebuilt}`);
    if (create === sql) throw new Error(`cannot rebuild ${table.name}: its text does not start as expected`);
    db.exec(create);
    db.exec(`INSERT INTO ${rebuilt} SELECT * FROM ${table.name} ORDER BY rowid`);
    db.exec(`DROP TABLE ${table.name}`);
    db.exec(`ALTER TABLE ${rebuilt} RENAME TO ${table.name}`);
  }
  for (const d of dependants.filter((x) => x.type === "index")) db.exec(d.sql);
  for (const d of dependants.filter((x) => x.type === "view")) db.exec(d.sql);
  for (const d of dependants.filter((x) => x.type === "trigger")) db.exec(d.sql);
}
