import { describe, expect, test } from "vitest";
import { LINKEDIN_EMITTED } from "../../test/support/generated-linkedin.ts";
import { LINKEDIN_FEATURES, LINKEDIN_OTHER_FEATURES } from "../../test/support/linkedin-chunks.ts";

/**
 * Every behaviour name the generated LinkedIn runs can report is registered, with no run (review bot on 56030c4: a name
 * emitted by one seed of the search and registered nowhere failed the search's shard instead of this suite). The fixed
 * seeds' run still fails on any name it reaches that is not registered, as strictly as before.
 */
describe("the generated LinkedIn runs' behaviour names", () => {
  test("each name a run can report is in exactly one registry, and each registered name can be reported", () => {
    const registered = [...LINKEDIN_FEATURES, ...LINKEDIN_OTHER_FEATURES];
    expect(LINKEDIN_FEATURES.filter((f) => LINKEDIN_OTHER_FEATURES.includes(f))).toEqual([]);
    expect([...registered].sort()).toEqual([...LINKEDIN_EMITTED].sort());
  });
});
