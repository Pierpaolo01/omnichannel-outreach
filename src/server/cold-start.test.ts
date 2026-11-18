import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/**
 * Two applications started at the same instant on an empty data folder (ticket 20a; the verifier on 2f7cd20): exactly
 * one takes the worker's lease and the other is refused as a second process; neither fails with "database is locked".
 * Repeated over fresh folders, since the race is a matter of timing.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "test/support/cold-start.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function start(dir: string, at: number): Promise<{ result: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", path.join(root, "src/server/quiet-sqlite-warning.ts"), script, dir, String(at)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1) ?? "") as { result: string; message?: string });
      } catch {
        reject(new Error(`no answer from a start: ${out}`));
      }
    });
  });
}

test("two cold starts at once on an empty data folder: one runs, the other is refused as a second process", async () => {
  for (let round = 0; round < 6; round++) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cold-start-"));
    dirs.push(dir);
    const at = Date.now() + 1500;
    const results = await Promise.all([start(dir, at), start(dir, at)]);
    expect(results.filter((r) => r.result === "error")).toEqual([]);
    expect(results.map((r) => r.result).sort()).toEqual(["ok", "refused"]);
  }
}, 120_000);
