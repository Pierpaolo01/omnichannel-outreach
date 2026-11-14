import { expect, test } from "vitest";
import { isLoopbackAddress } from "./guard.ts";

test("only loopback addresses may be listened on", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) expect(isLoopbackAddress(host)).toBe(true);
  for (const host of ["0.0.0.0", "192.168.1.20", "::", "example.com", "127.0.0.1.example.com"]) expect(isLoopbackAddress(host)).toBe(false);
});
