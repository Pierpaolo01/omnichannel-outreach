import { test } from "vitest";
import { runLinkedin } from "../../test/support/generated-linkedin.ts";
test("one", async () => { const r = await runLinkedin(24000 + Number(process.env["O"] ?? 0)); console.info(r.problems.join("\n")); }, 600_000);
