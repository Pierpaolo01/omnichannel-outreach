import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** Browser tests run against the production build, with a throwaway database outside the repo. */
const port = 4320;
const dataDir = path.join(os.tmpdir(), "omnichannel-outreach-e2e");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    // RECORD_DEMO=1 records a watchable video of the demonstration for pull request evidence.
    video: process.env["RECORD_DEMO"] ? { mode: "on", size: { width: 1360, height: 900 } } : "off",
    launchOptions: { slowMo: process.env["RECORD_DEMO"] ? 350 : 0 },
  },
  // The demonstration runs first on the empty database; every other test builds on its data.
  projects: [
    {
      name: "demonstration",
      testMatch: "demonstration.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } },
    },
    {
      name: "chromium",
      testIgnore: "demonstration.spec.ts",
      dependencies: ["demonstration"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } },
    },
  ],
  webServer: {
    command: `rm -rf "${dataDir}" && pnpm build && node --no-warnings=ExperimentalWarning src/server/main.ts`,
    url: `http://127.0.0.1:${port}/api/campaigns`,
    env: { NODE_ENV: "production", OUTREACH_PORT: String(port), OUTREACH_DATA_DIR: dataDir },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
