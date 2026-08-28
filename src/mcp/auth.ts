import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { generateProtectedResourceMetadata, getPublicOrigin } from "mcp-handler";
import { getAuthKitIssuer, getBearerToken, tokenMatches } from "./config";

/**
 * Endpoint auth: two credentials are accepted, checked in this order.
 *
 * 1. The shared secret (`MCP_BEARER_TOKEN`) — the original access-code scheme,
 *    kept so existing connector configs survive the OAuth rollout.
 * 2. An OAuth 2.1 access token issued by WorkOS AuthKit (`AUTHKIT_DOMAIN`) —
 *    a JWT verified against the issuer's public JWKS. AuthKit handles the
 *    whole authorization-server side (dynamic client registration, PKCE,
 *    the hosted login page with whatever methods are enabled in WorkOS,
 *    refresh), so this server never talks to WorkOS — it only checks
 *    signatures.
 */

/**
 * Header names the shared secret is accepted from. `Authorization: Bearer <t>`
 * is the canonical form; the alternatives exist because some connector UIs
 * (e.g. the claude.ai custom-connector dialog) reserve the Authorization name
 * for OAuth and only offer preset header names.
 */
const TOKEN_HEADERS = ["authorization", "x-api-key", "cf-aig-authorization"];

/** Every candidate token the request carries, "Bearer " prefix stripped. */
function extractTokens(request: Request): string[] {
  const candidates: string[] = [];
  for (const name of TOKEN_HEADERS) {
    const raw = request.headers.get(name)?.trim();
    if (!raw) continue;
    // Accept the value with or without a "Bearer " prefix in every header.
    candidates.push(raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw);
  }
  return candidates;
}

/**
 * Whether unauthenticated requests must be rejected. On Vercel always — a
 * blank, misspelled or environment-scoped variable would otherwise silently
 * publish the whole tool surface, on production and on every preview URL
 * alike, with nothing to notice it by. Locally only once an auth method is
 * actually configured, so `npm run dev` stays anonymous.
 */
export function authRequired(): boolean {
  return Boolean(process.env.VERCEL || getBearerToken() || getAuthKitIssuer());
}

/** What the deployment accepts — surfaced by `dawmain_ping`. */
export type AuthMode = "oauth+token" | "oauth" | "token" | "open";

export function authMode(): AuthMode {
  const oauth = Boolean(getAuthKitIssuer());
  const token = Boolean(getBearerToken());
  if (oauth && token) return "oauth+token";
  if (oauth) return "oauth";
  if (token) return "token";
  return "open";
}

/**
 * Maps verified AuthKit JWT claims onto the SDK's AuthInfo. Pure — the
 * signature/issuer/expiry checks happen in `verifyAuthKitToken`.
 *
 * AuthKit access tokens carry `sub` (the WorkOS user id) and `sid` (session);
 * scopes arrive as a space-separated `scope` string per RFC 6749 when the
 * client requested any. The registered OAuth client id is not guaranteed a
 * claim name across issuers, so `client_id` / `azp` are tried before falling
 * back to a fixed label.
 */
export function authInfoFromClaims(claims: JWTPayload, token: string): AuthInfo {
  const scopes =
    typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(claims.scopes)
        ? claims.scopes.filter((s): s is string => typeof s === "string")
        : [];
  const clientId =
    typeof claims.client_id === "string"
      ? claims.client_id
      : typeof claims.azp === "string"
        ? claims.azp
        : "authkit";
  return {
    token,
    clientId,
    scopes,
    expiresAt: claims.exp,
    extra: {
      method: "oauth",
      userId: claims.sub,
      ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}),
    },
  };
}

/**
 * Remote JWKS, cached per warm instance (jose additionally caches the keys
 * and refetches on rotation). Keyed by issuer so an env change after a
 * redeploy can't serve stale keys.
 */
let jwksCache: { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksCache?.issuer !== issuer) {
    jwksCache = { issuer, jwks: createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`)) };
  }
  return jwksCache.jwks;
}

/** Verifies an AuthKit-issued JWT; undefined on any failure (→ 401). */
export async function verifyAuthKitToken(token: string): Promise<AuthInfo | undefined> {
  const issuer = getAuthKitIssuer();
  if (!issuer) return undefined;
  try {
    // AuthKit signs with RS256; the issuer check ties the token to OUR
    // AuthKit environment, not just any WorkOS-signed JWT.
    const { payload } = await jwtVerify(token, jwksFor(issuer), { issuer, algorithms: ["RS256"] });
    return authInfoFromClaims(payload, token);
  } catch (error) {
    // Invalid/expired tokens are the normal rejection path and stay quiet;
    // anything else (JWKS unreachable, DNS) is operational and worth a line.
    if (!(error instanceof joseErrors.JOSEError)) {
      console.warn("AuthKit token verification failed unexpectedly:", error);
    }
    return undefined;
  }
}

/**
 * The `verifyToken` callback for `withMcpAuth`. Checks EVERY header the
 * shared secret may ride in, not just the first: a client that also sends an
 * unrelated Authorization header must not be locked out when the real token
 * rides in x-api-key (the reason those fallbacks exist). Only the
 * Authorization bearer value is tried against AuthKit — that is where OAuth
 * clients put access tokens.
 */
export async function verifyRequestAuth(
  request: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const expected = getBearerToken();
  if (expected) {
    for (const candidate of extractTokens(request)) {
      if (tokenMatches(expected, candidate)) {
        return { token: candidate, clientId: "shared-token", scopes: [], extra: { method: "shared-token" } };
      }
    }
  }
  if (bearerToken) return verifyAuthKitToken(bearerToken);
  return undefined;
}

const METADATA_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

/**
 * RFC 9728 protected-resource metadata — how an MCP client that got a 401
 * finds the authorization server to log in with. Served at both well-known
 * paths (root and path-inserted /api/mcp variant) because clients derive
 * either. 404 while OAuth is unconfigured, so clients fall back to plain
 * bearer headers instead of attempting a login that cannot work.
 */
export function protectedResourceMetadata(request: Request): Response {
  const issuer = getAuthKitIssuer();
  if (!issuer) {
    return new Response(
      JSON.stringify({ error: "not_configured", message: "OAuth is not enabled on this deployment." }),
      { status: 404, headers: { "content-type": "application/json", ...METADATA_CORS_HEADERS } },
    );
  }
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [issuer],
    // The resource identifier is the MCP endpoint itself, not the site root —
    // clients compare it against the URL they connected to (RFC 8707).
    resourceUrl: `${getPublicOrigin(request)}/api/mcp`,
    additionalMetadata: {
      resource_name: "Dawmain",
      bearer_methods_supported: ["header"],
    },
  });
  return new Response(JSON.stringify(metadata), {
    headers: {
      "content-type": "application/json",
      "cache-control": "max-age=3600",
      ...METADATA_CORS_HEADERS,
    },
  });
}
