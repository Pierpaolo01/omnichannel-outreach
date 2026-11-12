import path from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where the SQLite database lives. Always outside the repository: prospect records must never be
 * committable.
 * - The app profile (`pnpm start`) uses OUTREACH_DATA_DIR, by default
 *   ~/.local/share/omnichannel-outreach.
 * - The development profile (`pnpm dev`, `pnpm seed:dev`) uses OUTREACH_DEV_DATA_DIR, by default
 *   ~/.local/share/omnichannel-outreach-dev. It never reads OUTREACH_DATA_DIR and refuses to
 *   resolve to the app's directory, so a seed reset can never touch real data.
 */
export function resolveDataDir(input: {
  env: Env;
  home: string;
  projectRoot: string;
  profile?: "app" | "development";
}): string {
  const { env, home, projectRoot, profile = "app" } = input;
  const base = env["XDG_DATA_HOME"] || path.join(home, ".local", "share");
  const appDir = path.resolve(env["OUTREACH_DATA_DIR"] || path.join(base, "omnichannel-outreach"));
  const dir =
    profile === "development"
      ? path.resolve(env["OUTREACH_DEV_DATA_DIR"] || path.join(base, "omnichannel-outreach-dev"))
      : appDir;
  if (profile === "development" && (dir === appDir || dir === path.resolve(path.join(base, "omnichannel-outreach")))) {
    throw new Error(`The development data directory ${dir} is the app's data directory. Choose another OUTREACH_DEV_DATA_DIR.`);
  }
  if (inside(projectRoot, dir)) {
    throw new Error(`The data directory ${dir} is inside the repository. Choose a directory outside it.`);
  }
  return dir;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const DATABASE_FILE = "outreach.sqlite";
