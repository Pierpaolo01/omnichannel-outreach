import { INSTANTLY_BASE_URL, READ_OPERATIONS, type InstantlyError } from "./api.ts";

/**
 * A thin HTTP client for Instantly's API v2. It adds the bearer key and an explicit User-Agent (a
 * request without one is refused with 403, access handoff in issue 28), bounds every request, keeps
 * `GET /api/v2/emails` inside its documented 20 calls a minute
 * (https://developer.instantly.ai/getting-started/rate-limit), and refuses every write unless it was
 * constructed with `writes: true`. The refusal happens before any request is built, so with writes
 * off nothing but reads can leave the machine.
 */

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type InstantlyResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | { readonly ok: false; readonly status: number; readonly body: InstantlyError | null }
  /** No answer: the request timed out, the connection failed, or the local /emails budget is spent (no request was made). */
  | { readonly ok: false; readonly status: "timeout" | "network" | "budget" };

export class WritesDisabled extends Error {
  constructor(method: string, path: string) {
    super(`Instantly writes are off: ${method} ${path} was not sent.`);
    this.name = "WritesDisabled";
  }
}

export interface InstantlyClientOptions {
  readonly apiKey: string;
  readonly fetch: Fetch;
  /** Real provider writes. Off unless the runtime setting turns them on. */
  readonly writes: boolean;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

const USER_AGENT = "omnichannel-outreach/0.1 (+instantly-adapter)";
const EMAILS_PATH = "/api/v2/emails";
const EMAILS_PER_MINUTE = 20;
const MINUTE = 60_000;

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export class InstantlyClient {
  readonly writes: boolean;
  private readonly options: InstantlyClientOptions;
  /** Start instants of the /emails calls made in the last minute. */
  private emailCalls: number[] = [];

  constructor(options: InstantlyClientOptions) {
    this.options = options;
    this.writes = options.writes;
  }

  /** /emails calls still allowed in the current minute. */
  emailCallsLeft(): number {
    const since = this.options.now() - MINUTE;
    this.emailCalls = this.emailCalls.filter((t) => t > since);
    return EMAILS_PER_MINUTE - this.emailCalls.length;
  }

  get<T>(path: string, query: Query): Promise<InstantlyResult<T>> {
    return this.send<T>("GET", path, query, undefined);
  }

  post<T>(path: string, body: unknown): Promise<InstantlyResult<T>> {
    return this.send<T>("POST", path, {}, body);
  }

  patch<T>(path: string, body: unknown): Promise<InstantlyResult<T>> {
    return this.send<T>("PATCH", path, {}, body);
  }

  delete<T>(path: string): Promise<InstantlyResult<T>> {
    return this.send<T>("DELETE", path, {}, undefined);
  }

  private async send<T>(method: string, path: string, query: Query, body: unknown): Promise<InstantlyResult<T>> {
    const read = method === "GET" || READ_OPERATIONS.some((op) => op.method === method && op.path === path);
    if (!read && !this.writes) throw new WritesDisabled(method, path);
    if (method === "GET" && path === EMAILS_PATH) {
      if (this.emailCallsLeft() <= 0) return { ok: false, status: "budget" };
      this.emailCalls.push(this.options.now());
    }
    const url = new URL(path, this.options.baseUrl ?? INSTANTLY_BASE_URL);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.apiKey}`, "user-agent": USER_AGENT, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.options.timeoutMs ?? 20_000);
    });
    try {
      const init: RequestInit = { method, headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response = await Promise.race([this.options.fetch(url.toString(), init), timedOut]);
      if (response === "timeout") return { ok: false, status: "timeout" };
      const parsed: unknown = await response.json().catch(() => null);
      if (response.ok) return { ok: true, status: response.status, body: parsed as T };
      return { ok: false, status: response.status, body: isError(parsed) ? parsed : null };
    } catch {
      return { ok: false, status: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isError(value: unknown): value is InstantlyError {
  return typeof value === "object" && value !== null && "statusCode" in value && "message" in value;
}
