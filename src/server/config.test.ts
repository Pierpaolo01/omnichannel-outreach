import { describe, expect, test } from "vitest";
import { resolveDataDir } from "./config.ts";

const project = "/work/omnichannel-outreach";

describe("resolveDataDir", () => {
  test("defaults to the user's data directory, outside the repository", () => {
    expect(resolveDataDir({ env: {}, home: "/Users/someone", projectRoot: project })).toBe(
      "/Users/someone/.local/share/omnichannel-outreach",
    );
    expect(resolveDataDir({ env: { XDG_DATA_HOME: "/data" }, home: "/Users/someone", projectRoot: project })).toBe(
      "/data/omnichannel-outreach",
    );
  });

  test("keeps development data apart from the app's data", () => {
    expect(resolveDataDir({ env: {}, home: "/Users/someone", projectRoot: project, profile: "development" })).toBe(
      "/Users/someone/.local/share/omnichannel-outreach-dev",
    );
  });

  test("honours OUTREACH_DATA_DIR", () => {
    expect(resolveDataDir({ env: { OUTREACH_DATA_DIR: "/tmp/outreach-e2e" }, home: "/h", projectRoot: project })).toBe(
      "/tmp/outreach-e2e",
    );
  });

  test("refuses a data directory inside the repository, so prospect records cannot be committed", () => {
    expect(() =>
      resolveDataDir({ env: { OUTREACH_DATA_DIR: `${project}/data` }, home: "/h", projectRoot: project }),
    ).toThrow(/inside the repository/);
    expect(() => resolveDataDir({ env: { OUTREACH_DATA_DIR: project }, home: "/h", projectRoot: project })).toThrow();
  });

  test("the development profile never reads OUTREACH_DATA_DIR, so a seed reset cannot reach real data", () => {
    const env = { OUTREACH_DATA_DIR: "/Users/someone/real-outreach" };
    expect(resolveDataDir({ env, home: "/Users/someone", projectRoot: project, profile: "development" })).toBe(
      "/Users/someone/.local/share/omnichannel-outreach-dev",
    );
  });

  test("the development profile refuses the app's data directory, however it is named", () => {
    const home = "/Users/someone";
    for (const env of [
      { OUTREACH_DEV_DATA_DIR: "/Users/someone/.local/share/omnichannel-outreach" },
      { OUTREACH_DEV_DATA_DIR: "/srv/outreach", OUTREACH_DATA_DIR: "/srv/outreach/" },
    ]) {
      expect(() => resolveDataDir({ env, home, projectRoot: project, profile: "development" })).toThrow(/app's data directory/);
    }
  });
});
