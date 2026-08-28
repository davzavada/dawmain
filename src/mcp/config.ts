import { timingSafeEqual } from "node:crypto";

/** Identity reported to MCP clients during `initialize`. */
export const SERVER_NAME = "dawmain-mcp-server";
export const SERVER_VERSION = "0.1.0";

/**
 * Optional shared-secret auth. When `MCP_BEARER_TOKEN` is set the endpoint
 * accepts `Authorization: Bearer <token>` — alongside, not instead of, OAuth
 * (see `getAuthKitIssuer`), so existing access codes keep working while
 * clients migrate to the OAuth login.
 */
export function getBearerToken(): string | undefined {
  const token = process.env.MCP_BEARER_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * OAuth 2.1 via WorkOS AuthKit. `AUTHKIT_DOMAIN` holds the AuthKit domain
 * from the WorkOS dashboard — `https://<slug>.authkit.app` or a custom auth
 * domain; a bare hostname is accepted too. When set, /api/mcp accepts
 * AuthKit-issued JWT access tokens and the RFC 9728 protected-resource
 * metadata advertises this issuer so MCP clients can discover the login.
 * The server only verifies signatures against the issuer's public JWKS —
 * no WorkOS API key is needed anywhere.
 */
export function getAuthKitIssuer(): string | undefined {
  const raw = process.env.AUTHKIT_DOMAIN?.trim();
  if (!raw) return undefined;
  const url = raw.includes("://") ? raw : `https://${raw}`;
  return url.replace(/\/+$/, "");
}

/**
 * Constant-time comparison of the token bytes. Length is compared first — as
 * `crypto.timingSafeEqual` itself requires equal-length buffers — so the check
 * reveals whether the length matched, never which bytes did.
 */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
