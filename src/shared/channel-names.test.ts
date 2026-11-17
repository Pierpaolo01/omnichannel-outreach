import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNELS } from "../domain/social-channels.ts";

/**
 * "One implementation, two instances" (ADR 0004 13.2), held mechanically: outside the registry, no source file names a
 * message-request channel, by its key or its platform name, in code. Every per-channel difference is read from
 * `SOCIAL_CHANNELS`, `MESSAGE_REQUEST_COLUMNS` or `messageRequestRecord`, or is a key TypeScript forces into an exhaustive
 * record, so a new channel is a compile error where it needs an entry, never another channel's words. The allowed files: the
 * registry itself, the channel's account normaliser (one function per channel by contract), the migrations (SQL history,
 * which names a channel it adds) and the icon set (one drawing per name).
 */
const ROOT = path.join(import.meta.dirname, "..");
const ALLOWED = new Set(["domain/social-channels.ts", "domain/social-account.ts", "server/persistence/migrations.ts", "web/icons.tsx"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The code of a file, its comments removed: a comment may name a channel; code may not. */
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("no message-request channel is named in code outside the registry (ADR 0004 13.2)", () => {
  const words = MESSAGE_REQUEST_CHANNELS.flatMap((c) => [c, SOCIAL_CHANNELS[c].name]);
  test(`the names ${words.join(", ")} appear only in the registry, the normaliser, the migrations and the icons`, () => {
    const found: string[] = [];
    for (const file of sources(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      codeOf(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(line))) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(found).toEqual([]);
  });
});
