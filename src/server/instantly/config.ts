type Env = Readonly<Record<string, string | undefined>>;

export interface InstantlyRuntime {
  readonly apiKey: string;
  /** Real provider writes (campaigns, leads, deletions). Off unless `OUTREACH_INSTANTLY_WRITES=on`. */
  readonly writes: boolean;
  /** The zone Instantly's daily limits reset in (ADR 0002 S5); UTC until the user reports another. */
  readonly resetZone: string;
}

/**
 * The Instantly settings of one run, or null when no key is configured (the app then has no email
 * sender, and every email track meets launch blocker 3).
 *
 * - `INSTANTLY_API_KEY`, or `OUTREACH_RUNTIME_ENV` naming the owner-only credentials file that holds
 *   it (`KEY=value` lines). The key is never logged.
 * - `OUTREACH_INSTANTLY_WRITES=on` in the run's own environment turns real writes on. Nothing else
 *   does: not another spelling, and not the credentials file.
 * - `INSTANTLY_LIMIT_RESET_ZONE`, default UTC.
 */
export function instantlyRuntime(env: Env, readFile: (path: string) => string | null): InstantlyRuntime | null {
  const file = env["OUTREACH_RUNTIME_ENV"] ? parseEnvFile(readFile(env["OUTREACH_RUNTIME_ENV"]) ?? "") : {};
  const apiKey = env["INSTANTLY_API_KEY"] || file["INSTANTLY_API_KEY"];
  if (!apiKey) return null;
  const resetZone = env["INSTANTLY_LIMIT_RESET_ZONE"] || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: resetZone });
  } catch {
    throw new Error(`INSTANTLY_LIMIT_RESET_ZONE=${resetZone} is not a time zone.`);
  }
  return { apiKey, writes: env["OUTREACH_INSTANTLY_WRITES"] === "on", resetZone };
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    out[line.slice(0, eq).trim()] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}
