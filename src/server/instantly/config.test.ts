import { describe, expect, test } from "vitest";
import { instantlyRuntime } from "./config.ts";

const files = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;

describe("the Instantly runtime settings", () => {
  test("no key, no provider: the app runs with no connected email sender", () => {
    expect(instantlyRuntime({}, files({}))).toBeNull();
    expect(instantlyRuntime({ OUTREACH_RUNTIME_ENV: "/nowhere" }, files({}))).toBeNull();
  });

  test("the key comes from the environment, or from the credentials file the environment names", () => {
    expect(instantlyRuntime({ INSTANTLY_API_KEY: "env-key" }, files({}))).toEqual({ apiKey: "env-key", writes: false, resetZone: "UTC" });
    const file = "# local credentials\nexport INSTANTLY_API_KEY='file-key'\nSCRAPER_PEOPLE_CSV=/somewhere\n";
    expect(instantlyRuntime({ OUTREACH_RUNTIME_ENV: "/creds" }, files({ "/creds": file }))).toEqual({ apiKey: "file-key", writes: false, resetZone: "UTC" });
  });

  test("real writes are on only when the run's environment says exactly so, never from the credentials file", () => {
    expect(instantlyRuntime({ INSTANTLY_API_KEY: "k", OUTREACH_INSTANTLY_WRITES: "on" }, files({}))?.writes).toBe(true);
    for (const value of ["1", "true", "ON", "yes", ""]) expect(instantlyRuntime({ INSTANTLY_API_KEY: "k", OUTREACH_INSTANTLY_WRITES: value }, files({}))?.writes).toBe(false);
    expect(instantlyRuntime({ OUTREACH_RUNTIME_ENV: "/creds" }, files({ "/creds": "INSTANTLY_API_KEY=k\nOUTREACH_INSTANTLY_WRITES=on\n" }))?.writes).toBe(false);
  });

  test("the limit reset zone defaults to UTC and refuses a zone that does not exist", () => {
    expect(instantlyRuntime({ INSTANTLY_API_KEY: "k", INSTANTLY_LIMIT_RESET_ZONE: "America/New_York" }, files({}))?.resetZone).toBe("America/New_York");
    expect(() => instantlyRuntime({ INSTANTLY_API_KEY: "k", INSTANTLY_LIMIT_RESET_ZONE: "Mars/Olympus" }, files({}))).toThrow(/INSTANTLY_LIMIT_RESET_ZONE/);
  });
});
