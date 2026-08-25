/** Identity reported to MCP clients during `initialize`. */
export const SERVER_NAME = "dawmain-mcp-server";
export const SERVER_VERSION = "0.1.0";

/**
 * Optional shared-secret auth. When `MCP_BEARER_TOKEN` is set the endpoint
 * requires `Authorization: Bearer <token>`; when it is unset the endpoint is
 * public.
 *
 * A shared secret is deliberately simple. For real OAuth 2.1 (RFC 9728
 * protected-resource metadata, CIMD clients) swap this out for
 * `withMcpAuth` + `protectedResourceHandler` from `mcp-handler`.
 */
export function getBearerToken(): string | undefined {
  const token = process.env.MCP_BEARER_TOKEN?.trim();
  return token ? token : undefined;
}

/** Timing-safe-ish comparison that does not leak length via early exit. */
export function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** e-Sbírka registered-API key (header `esel-api-access-key`). Optional — the
 * client falls back to the keyless SPA gateway when unset. */
export function getEsbirkaApiKey(): string | undefined {
  const key = process.env.ESBIRKA_API_KEY?.trim();
  return key ? key : undefined;
}

/**
 * e-Sbírka API base. Live-verified 2026-08: api.e-sbirka.gov.cz answers with
 * the key; the pre-migration host api.e-sbirka.cz returns 200 with a non-JSON
 * body. Override via env if DIA moves the host again.
 */
export function getEsbirkaApiBase(): string {
  return (process.env.ESBIRKA_API_BASE?.trim() || "https://api.e-sbirka.gov.cz").replace(/\/+$/, "");
}

/** Keyless gateway of the e-Sbírka SPA — same paths and response shapes. */
export const ESBIRKA_CACHE_BASE = "https://e-sbirka.gov.cz/sbr-cache";
