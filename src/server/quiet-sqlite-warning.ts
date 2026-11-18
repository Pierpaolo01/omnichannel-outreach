/**
 * Loaded with `node --import` before the app. node:sqlite is still experimental in Node 22 and
 * warns once on load; this drops only that warning, so every other experimental warning prints.
 */
const emitWarning = process.emitWarning.bind(process);

function isSqliteWarning(warning: string | Error, typeOrOptions: unknown): boolean {
  const text = typeof warning === "string" ? warning : warning.message;
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions
        ? String(typeOrOptions.type)
        : warning instanceof Error
          ? warning.name
          : "";
  return type === "ExperimentalWarning" && /SQLite/i.test(text);
}

process.emitWarning = function quietSqlite(this: unknown, warning: string | Error, ...rest: unknown[]): void {
  if (isSqliteWarning(warning, rest[0])) return;
  Reflect.apply(emitWarning, process, [warning, ...rest]);
};
