"use client";

import type { ErrorBody } from "@/src/files/web-types";

/**
 * fetch() wrappers for the Vlastní zdroje API: JSON in, JSON out, the
 * server's Czech message on failure (it never contains content), a fixed
 * Czech message when the network or the server fails without one.
 */

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; body: ErrorBody | null };

export const NETWORK_ERROR = "Spojení se serverem se nepodařilo. Zkontrolujte připojení a zkuste to znovu.";
const SERVER_ERROR = "Server teď neodpovídá. Zkuste to prosím za chvíli.";

export async function api<T>(url: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
      headers: init.json === undefined ? undefined : { "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    return { ok: false, status: 0, error: NETWORK_ERROR, body: null };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const err = body && typeof body === "object" && typeof (body as ErrorBody).error === "string" ? (body as ErrorBody) : null;
  return { ok: false, status: res.status, error: err?.error ?? (res.status === 401 ? "Přihlaste se prosím." : SERVER_ERROR), body: err };
}
