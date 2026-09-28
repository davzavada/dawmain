import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk's proxy is what makes `auth()` work: in the MCP route (OAuth
 * tokens), in the Vlastní zdroje API routes (web session) and on every page,
 * because the header shows the signed-in account menu site-wide.
 * clerkMiddleware() without protect() only attaches the auth state — it
 * never redirects or blocks — so public pages and the /.well-known
 * metadata route handlers behave as before.
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
    // Clerk's standard Next.js matcher: every page, skipping Next internals
    // and static files (unless one is named in a search param).
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|md)).*)",
    // Always the API routes (MCP, /api/files/*, webhooks, cron).
    "/(api|trpc)(.*)",
    // Clerk's own auto-proxy path.
    "/__clerk/:path*",
  ],
};
