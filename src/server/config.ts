import path from "node:path";

/**
 * Where the SQLite database lives. Always outside the repository: prospect records must never
 * be committable. OUTREACH_DATA_DIR overrides the default. The development profile (`pnpm dev`,
 * `pnpm seed:dev`) uses its own directory, so fictitious seed data never mixes with real imports.
 */
export function resolveDataDir(input: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  projectRoot: string;
  profile?: "app" | "development";
}): string {
  const { env, home, projectRoot, profile = "app" } = input;
  const base = env["XDG_DATA_HOME"] || path.join(home, ".local", "share");
  const name = profile === "development" ? "omnichannel-outreach-dev" : "omnichannel-outreach";
  const dir = path.resolve(env["OUTREACH_DATA_DIR"] || path.join(base, name));
  const relative = path.relative(path.resolve(projectRoot), dir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`OUTREACH_DATA_DIR ${dir} is inside the repository. Choose a directory outside it.`);
  }
  return dir;
}

export const DATABASE_FILE = "outreach.sqlite";
