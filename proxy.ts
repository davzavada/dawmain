import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk's proxy is what makes `auth()` work on the server: in the MCP route
 * (OAuth tokens), in the Vlastní zdroje and Zotero API routes (web session)
 * and on the operator page. Nowhere else: the pages are static and read the
 * account in the browser (ClerkProvider, app/_zdroje/clerk-bridge.tsx), so
 * the proxy only cost them time — a function call before every page, and
 * for a signed-in user whose one-minute session token had lapsed, Clerk's
 * handshake: two redirects through Clerk before the page even started.
 * clerkMiddleware() without protect() only attaches the auth state — it
 * never blocks — so the routes it covers decide for themselves.
 *
 * Env is checked inline (not via src/mcp/config) so this file stays
 * runtime-agnostic: without keys clerkMiddleware() would throw on every
 * request, so fall back to a no-op — the MCP endpoint then runs on the
 * shared access code alone and still fails closed on Vercel (see
 * src/mcp/auth.ts), and the Vlastní zdroje routes answer "unavailable".
 */
const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.CLERK_SECRET_KEY?.trim(),
);

export default clerkConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // The API routes (MCP, /api/files/*, /api/zotero/*, webhooks, cron) — except
    // /api/status: public, static and served by the CDN, which a proxy in front
    // would turn into a function call per request (app/api/status/route.ts).
    "/((?!api/status(?:/|$))(?:api|trpc).*)",
    // The operator page and its Server Functions (auth() on the server); :path* includes the page itself.
    "/vlastni-zdroje/provoz/:path*",
    // Clerk's own auto-proxy path.
    "/__clerk/:path*",
  ],
};
