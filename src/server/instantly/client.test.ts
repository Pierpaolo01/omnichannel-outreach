import { describe, expect, test } from "vitest";
import { InstantlyClient, WritesDisabled } from "./client.ts";

/** A fetch that records each request and answers 200 with an empty page. */
function recordingFetch(answer: () => Promise<Response> = () => Promise.resolve(Response.json({ items: [] }))) {
  const calls: { method: string; url: string; headers: Headers; body: string | null }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ method: init?.method ?? "GET", url: input instanceof Request ? input.url : input.toString(), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null });
    return answer();
  };
  return { calls, fetch };
}

const client = (fetch: ReturnType<typeof recordingFetch>["fetch"], writes = false, now = () => 0) =>
  new InstantlyClient({ apiKey: "test-key-not-real", fetch, writes, now, timeoutMs: 50 });

describe("the Instantly client", () => {
  test("a read carries the bearer key and an explicit User-Agent, and encodes its query", async () => {
    const f = recordingFetch();
    const result = await client(f.fetch).get("/api/v2/emails", { eaccount: "a@x.example,b@x.example", sort_order: "asc", preview_only: false, lead: undefined });
    expect(result).toEqual({ ok: true, status: 200, body: { items: [] } });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.instantly.ai/api/v2/emails?eaccount=a%40x.example%2Cb%40x.example&sort_order=asc&preview_only=false");
    expect(call.headers.get("authorization")).toBe("Bearer test-key-not-real");
    // A request without a User-Agent is refused with 403 (access handoff, issue 28).
    expect(call.headers.get("user-agent")).toMatch(/^omnichannel-outreach\//);
  });

  test("with writes off, every write is refused before any request leaves the machine", async () => {
    const f = recordingFetch();
    const c = client(f.fetch);
    await expect(c.post("/api/v2/leads/add", { campaign_id: "c", leads: [], idempotency_key: "k" })).rejects.toBeInstanceOf(WritesDisabled);
    await expect(c.post("/api/v2/campaigns", { name: "x" })).rejects.toBeInstanceOf(WritesDisabled);
    await expect(c.patch("/api/v2/campaigns/c1", { name: "x" })).rejects.toBeInstanceOf(WritesDisabled);
    await expect(c.delete("/api/v2/leads/l1")).rejects.toBeInstanceOf(WritesDisabled);
    expect(f.calls).toHaveLength(0);
    // The one documented read that takes POST is still a read.
    await c.post("/api/v2/leads/list", { campaign: "c", limit: 100 });
    expect(f.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual(["POST /api/v2/leads/list"]);
    expect(c.writes).toBe(false);
  });

  test("with writes on, a write is sent as JSON", async () => {
    const f = recordingFetch();
    await client(f.fetch, true).post("/api/v2/leads/add", { campaign_id: "c", leads: [], idempotency_key: "k" });
    expect(f.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(f.calls[0]?.body ?? "null")).toEqual({ campaign_id: "c", leads: [], idempotency_key: "k" });
  });

  test("GET /emails keeps inside its documented 20 calls a minute, shared by every caller", async () => {
    let now = 0;
    const f = recordingFetch();
    const c = client(f.fetch, false, () => now);
    for (let i = 0; i < 20; i++) expect((await c.get("/api/v2/emails", {})).ok).toBe(true);
    expect(await c.get("/api/v2/emails", {})).toEqual({ ok: false, status: "budget" });
    expect(c.emailCallsLeft()).toBe(0);
    // Other endpoints are not held by the /emails budget.
    expect((await c.get("/api/v2/accounts", {})).ok).toBe(true);
    now = 60_001;
    expect((await c.get("/api/v2/emails", {})).ok).toBe(true);
    expect(f.calls.filter((x) => new URL(x.url).pathname === "/api/v2/emails")).toHaveLength(21);
  });

  test("an error answer keeps its documented body; a hang becomes a timeout; a dropped connection is a network failure", async () => {
    const error = await client(recordingFetch(() => Promise.resolve(Response.json({ statusCode: 402, error: "Payment Required", message: "no plan" }, { status: 402 }))).fetch).get("/api/v2/accounts", {});
    expect(error).toEqual({ ok: false, status: 402, body: { statusCode: 402, error: "Payment Required", message: "no plan" } });

    const hang = await client(recordingFetch(() => new Promise<Response>(() => undefined)).fetch).get("/api/v2/accounts", {});
    expect(hang).toEqual({ ok: false, status: "timeout" });

    const dropped = await client(recordingFetch(() => Promise.reject(new TypeError("fetch failed"))).fetch).get("/api/v2/accounts", {});
    expect(dropped).toEqual({ ok: false, status: "network" });
  });
});
