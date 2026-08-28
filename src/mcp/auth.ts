import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from "@clerk/mcp-tools/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getPublicOrigin } from "mcp-handler";
import { clerkConfigured, getBearerToken, getClerkPublishableKey, tokenMatches } from "./config";

/**
 * Endpoint auth: two credentials are accepted, checked in this order.
 *
 * 1. The shared secret (`MCP_BEARER_TOKEN`) — the original access-code scheme,
 *    kept so existing connector configs survive the OAuth rollout.
 * 2. An OAuth 2.1 access token issued by Clerk — verified through Clerk's
 *    backend (which is why `CLERK_SECRET_KEY` must be set alongside the
 *    publishable key). Clerk handles the whole authorization-server side
 *    (dynamic client registration, PKCE, the hosted sign-in page with
 *    whatever methods are enabled in the Clerk dashboard, refresh); this
 *    server only verifies the tokens it is handed.
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
  return Boolean(process.env.VERCEL || getBearerToken() || clerkConfigured());
}

/** What the deployment accepts — surfaced by `dawmain_ping`. */
export type AuthMode = "oauth+token" | "oauth" | "token" | "open";

export function authMode(): AuthMode {
  const oauth = clerkConfigured();
  const token = Boolean(getBearerToken());
  if (oauth && token) return "oauth+token";
  if (oauth) return "oauth";
  if (token) return "token";
  return "open";
}

/**
 * The `verifyToken` callback for `withMcpAuth`. Checks EVERY header the
 * shared secret may ride in, not just the first: a client that also sends an
 * unrelated Authorization header must not be locked out when the real token
 * rides in x-api-key (the reason those fallbacks exist). Only the
 * Authorization bearer value is tried against Clerk — that is where OAuth
 * clients put access tokens; `auth()` reads it from the request context the
 * Clerk proxy (proxy.ts) attached.
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
  if (bearerToken && clerkConfigured()) {
    try {
      const clerkAuth = await auth({ acceptsToken: "oauth_token" });
      return verifyClerkToken(clerkAuth, bearerToken) ?? undefined;
    } catch (error) {
      // An invalid token surfaces as `undefined` above, not a throw — a throw
      // means something operational (Clerk unreachable, proxy.ts not running
      // on this route) and is worth a log line. Either way: 401.
      console.warn("Clerk token verification failed unexpectedly:", error);
      return undefined;
    }
  }
  return undefined;
}

const METADATA_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

function notConfigured(): Response {
  return new Response(
    JSON.stringify({ error: "not_configured", message: "OAuth is not enabled on this deployment." }),
    { status: 404, headers: { "content-type": "application/json", ...METADATA_CORS_HEADERS } },
  );
}

/**
 * RFC 9728 protected-resource metadata — how an MCP client that got a 401
 * finds the authorization server (Clerk, derived from the publishable key)
 * to log in with. Served at both well-known paths (root and path-inserted
 * /api/mcp variant) because clients derive either. 404 while OAuth is
 * unconfigured, so clients fall back to plain bearer headers instead of
 * attempting a login that cannot work.
 */
export function protectedResourceMetadata(request: Request): Response {
  const publishableKey = getClerkPublishableKey();
  if (!publishableKey || !clerkConfigured()) return notConfigured();
  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey,
    // The resource identifier is the MCP endpoint itself, not the site root —
    // clients compare it against the URL they connected to (RFC 8707).
    resourceUrl: `${getPublicOrigin(request)}/api/mcp`,
    properties: {
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

/**
 * RFC 8414 authorization-server metadata, proxied from Clerk at our origin —
 * a compatibility shim for MCP clients that skip the protected-resource step
 * and look for the authorization server on the resource's own domain.
 */
export async function authorizationServerMetadata(): Promise<Response> {
  const publishableKey = getClerkPublishableKey();
  if (!publishableKey || !clerkConfigured()) return notConfigured();
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return new Response(JSON.stringify(metadata), {
    headers: {
      "content-type": "application/json",
      "cache-control": "max-age=3600",
      ...METADATA_CORS_HEADERS,
    },
  });
}
