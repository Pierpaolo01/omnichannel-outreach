import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../shared/api.ts";

export type Loadable<T> =
  | { readonly state: "loading"; readonly previous: T | null }
  | { readonly state: "error"; readonly message: string; readonly notFound: boolean }
  | { readonly state: "ready"; readonly data: T };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The per-file problems of a rejected import, when the server sent them. */
export function exportProblems(error: unknown): { file: string; message: string }[] {
  if (!(error instanceof ApiRequestError) || !isApiError(error.body)) return [];
  return [...(error.body.error.problems ?? [])];
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const { error } = value;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string";
}

export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(response.status, isApiError(body) ? body.error.message : `The server answered ${response.status}.`);
  }
  return body;
}

type Settled<T> =
  | { readonly key: string; readonly ok: true; readonly data: T }
  | { readonly key: string; readonly ok: false; readonly message: string; readonly notFound: boolean };

/** Sends JSON and returns the parsed body. A non-2xx answer throws with the server's message. */
export async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(response.status, isApiError(json) ? json.error.message : `The server answered ${response.status}.`, json);
  }
  return json;
}

/** Replaces a resource with a JSON body and returns the parsed answer. A non-2xx answer throws with the server's message. */
export async function putJson(path: string, body: unknown, options: { keepalive?: boolean } = {}): Promise<unknown> {
  const response = await fetch(path, {
    method: "PUT",
    ...(options.keepalive ? { keepalive: true } : {}),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(response.status, isApiError(json) ? json.error.message : `The server answered ${response.status}.`, json);
  }
  return json;
}

/**
 * Loads one resource. While a new path loads, the last result stays available as `previous`.
 * The server's JSON is trusted to match the shared API types: both sides compile from
 * src/shared/api.ts.
 */
export function useApi<T>(path: string): { result: Loadable<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const key = `${path}#${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    getJson(path, controller.signal)
      .then((data) => setSettled({ key, ok: true, data: data as T }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({
          key,
          ok: false,
          message: error instanceof Error ? error.message : "The request failed.",
          notFound: error instanceof ApiRequestError && error.status === 404,
        });
      });
    return () => controller.abort();
  }, [path, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  let result: Loadable<T>;
  if (settled?.key !== key) result = { state: "loading", previous: settled?.ok ? settled.data : null };
  else if (settled.ok) result = { state: "ready", data: settled.data };
  else result = { state: "error", message: settled.message, notFound: settled.notFound };
  return { result, retry };
}
