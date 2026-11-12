/**
 * Request guard for a server that only ever runs on this machine. Prospect records must not be
 * readable or writable from another site:
 * - Host must be localhost or 127.0.0.1, so a DNS-rebinding page cannot reach the API;
 * - a request that changes data must come from this app's own pages, not another site;
 * - a JSON route must receive JSON, which a cross-site form or no-cors fetch cannot send.
 */
export const ALLOWED_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1"];

export interface GuardedRequest {
  readonly method: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly contentType: string | null;
}

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly status: 403 | 415; readonly message: string };

const CHANGES_DATA = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return "";
  }
}

/** Host check alone, for every request the server answers (pages and API). */
export function checkHost(host: string | null): GuardResult {
  if (host && ALLOWED_HOSTNAMES.includes(hostnameOf(host))) return { ok: true };
  return { ok: false, status: 403, message: "This app only answers on localhost or 127.0.0.1." };
}

export function checkApiRequest(request: GuardedRequest): GuardResult {
  const host = checkHost(request.host);
  if (!host.ok) return host;
  if (!CHANGES_DATA.has(request.method.toUpperCase())) return { ok: true };

  if (request.secFetchSite && !["same-origin", "none"].includes(request.secFetchSite)) {
    return { ok: false, status: 403, message: "Changes must come from this app's own pages." };
  }
  if (request.origin) {
    let originHost = "";
    try {
      originHost = new URL(request.origin).hostname;
    } catch {
      originHost = "";
    }
    if (!ALLOWED_HOSTNAMES.includes(originHost)) {
      return { ok: false, status: 403, message: "Changes must come from this app's own pages." };
    }
  }
  const type = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, status: 415, message: "Send the request as application/json." };
  }
  return { ok: true };
}
