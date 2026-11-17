import { SourceError, asSourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";

/**
 * Slov-Lex (www.slov-lex.sk) — the Slovak legal portal: Zbierka zákonov SR,
 * eLegislatíva (legislative processes) and súdne rozhodnutia. The SPA reads
 * a public, keyless API gateway; act texts are static HTML. Shared base for
 * slovlex-predpisy, slovlex-lp and slovlex-judikatura (docs/research/slovlex.md).
 *
 * Spring quirk: a missing required parameter redirects to the secured /error
 * page and comes back as 401 (WWW-Authenticate: Basic), not 400 — so a 401
 * means our request shape drifted, never "unavailable".
 */

export const SLOVLEX_GATEWAY = "https://api-gateway.slov-lex.sk";
export const SLOVLEX_STATIC = "https://static.slov-lex.sk/static";
export const SLOVLEX_WEB = "https://www.slov-lex.sk";

export const SLOVLEX_ZBIERKA = "Slov-Lex (Zbierka zákonov SR)";
export const SLOVLEX_LP = "Slov-Lex (eLegislatíva)";
export const SLOVLEX_SUDY = "Slov-Lex (súdne rozhodnutia)";

/**
 * GET (or POST with a JSON body) one gateway endpoint and parse its JSON.
 * 404 → NOT_FOUND, 401 → PARSE_DRIFT (Spring's missing-parameter answer),
 * other non-2xx and a non-JSON body → UPSTREAM_ERROR / PARSE_DRIFT.
 * POST is not retried unless `retry: true` (the filter POSTs are idempotent).
 */
export async function slovlexJson<T>(
  source: string,
  url: string,
  init: { method?: "POST"; body?: unknown; retry?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const post = init.method === "POST";
  const response = await fetchUpstream(source, url, {
    method: post ? "POST" : "GET",
    headers: {
      accept: "application/json",
      ...(post ? { "content-type": "application/json" } : {}),
    },
    body: post ? JSON.stringify(init.body ?? {}) : undefined,
    ...(init.retry !== undefined ? { retry: init.retry } : {}),
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
  });
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError(source, "NOT_FOUND", `Slov-Lex has nothing at ${url} (HTTP 404).`, "Check the identifier (year, number, id) — it comes from the matching search tool.");
  }
  if (response.status === 401) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError(
      source,
      "PARSE_DRIFT",
      `Slov-Lex answered HTTP 401 for ${url}. Slov-Lex odpovídá 401, když chybí povinný parametr: tvar požadavku se rozešel.`,
      "The API changed the parameters it requires — run dawmain_probe_sources; retrying will not help.",
    );
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError(source, "UPSTREAM_ERROR", `Slov-Lex answered HTTP ${response.status} for ${url}.`, "Try again in a minute; if it persists, run dawmain_probe_sources.");
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw asSourceError(source, error);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new SourceError(
      source,
      "PARSE_DRIFT",
      `Slov-Lex answered ${url} with a non-JSON body.`,
      "The service answered, but not with its API data — run dawmain_probe_sources; retrying will not help.",
    );
  }
}

/** "/SK/ZZ/1964/40" or, with a version (YYYYMMDD, "vyhlasene_znenie"), "/SK/ZZ/1964/40/20260731". */
export function actIri(year: number, number: number, version?: string): string {
  return `/SK/ZZ/${year}/${number}${version ? `/${version}` : ""}`;
}

/**
 * "40/1964", "40/1964 Zb.", "325/2025 Z. z.", "/SK/ZZ/1964/40" (with or
 * without a trailing version) → {year, number}; anything else → null.
 */
export function parseActCitation(input: string): { year: number; number: number } | null {
  const text = input.replace(/ /g, " ").trim();
  const iri = /(?:^|\/)SK\/ZZ\/(\d{4})\/(\d+)(?:\/[^/\s]+)?\/?$/i.exec(text);
  if (iri) return { year: Number(iri[1]), number: Number(iri[2]) };
  const citation = /^(?:č\.\s*)?(\d+)\s*\/\s*(\d{4})(?:\s*(?:Zb\.|Z\.\s*z\.|Sb\.))?$/i.exec(text);
  if (citation) return { year: Number(citation[2]), number: Number(citation[1]) };
  return null;
}

/** Today's date as YYYY-MM-DD in Europe/Prague (= Bratislava's zone). */
export function todayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
