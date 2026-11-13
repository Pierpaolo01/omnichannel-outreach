import { describe, expect, test } from "vitest";
import { describeEntry } from "./activity.tsx";

describe("what the timeline says of a track that ended on a bad address (re-check B14)", () => {
  test("it says what the stored ending says, and does not claim another campaign marked the address", () => {
    // Stored: the email track failed on a bad destination, with no bounce event of this campaign's.
    // That is true of another campaign's bounce, and of this campaign's bounce observed before
    // migration 10, which kept no event. The entry claims neither.
    const said = describeEntry({ campaign: { id: "c1", name: "Autumn physio" }, at: "2026-11-02T09:05:00.000Z", kind: "address_bad", to: "sam@harbour.example" });
    expect(said.title).toBe("Email track ended");
    expect(said.body).toBe("sam@harbour.example is marked wrong, so nothing more is sent to it.");
  });
});
