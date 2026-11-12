import { existsSync, realpathSync } from "node:fs";
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
  /** Resolves symlinks of an existing path; injectable for tests. */
  realpath?: (existing: string) => string;
}): string {
  const { env, home, projectRoot, profile = "app", realpath = defaultRealpath } = input;
  const real = (p: string) => canonical(p, realpath);
  const base = env["XDG_DATA_HOME"] || path.join(home, ".local", "share");
  const appDir = path.resolve(env["OUTREACH_DATA_DIR"] || path.join(base, "omnichannel-outreach"));
  const dir =
    profile === "development"
      ? path.resolve(env["OUTREACH_DEV_DATA_DIR"] || path.join(base, "omnichannel-outreach-dev"))
      : appDir;
  // Compare real directories, through symlinks and aliases such as /tmp and /private/tmp.
  if (profile === "development") {
    const devReal = real(dir);
    for (const app of [appDir, path.join(base, "omnichannel-outreach")]) {
      const appReal = real(app);
      if (devReal === appReal || inside(appReal, devReal) || inside(devReal, appReal)) {
        throw new Error(`The development data directory ${dir} is or contains the app's data directory. Choose another OUTREACH_DEV_DATA_DIR.`);
      }
    }
  }
  if (inside(real(projectRoot), real(dir))) {
    throw new Error(`The data directory ${dir} is inside the repository. Choose a directory outside it.`);
  }
  return dir;
}

function defaultRealpath(existing: string): string {
  return realpathSync.native(existing);
}

/** The real path: symlinks resolved on the deepest part that exists, the rest appended. */
function canonical(target: string, realpath: (existing: string) => string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.resolve(target);
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpath(existing), ...rest);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const DATABASE_FILE = "outreach.sqlite";
