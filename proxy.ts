import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

/**
 * Clerk's proxy is what makes `auth()` work in the MCP route. Env is checked
 * inline (not via src/mcp/config) so this file stays runtime-agnostic:
 * without keys clerkMiddleware() would throw on every request, so fall back
 * to a no-op — the endpoint then runs on the shared access code alone and
 * still fails closed on Vercel (see src/mcp/auth.ts).
 */
const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.CLERK_SECRET_KEY?.trim(),
);

const clerk = clerkConfigured ? clerkMiddleware() : undefined;

/**
 * Whatever Clerk's middleware throws (a dropped connection to Clerk while it
 * inspects the token, a handshake it cannot finish) must not surface as a
 * Vercel FUNCTION_INVOCATION_FAILED on the MCP endpoint — the route verifies
 * every token on its own through Clerk's backend and fails closed without
 * this proxy (src/mcp/auth.ts), so letting the request through is safe. The
 * cause is logged; the client gets the route's 401/response, not a crash.
 */
export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!clerk) return NextResponse.next();
  try {
    return await clerk(request, event);
  } catch (error) {
    console.warn("Clerk proxy failed; passing the request to the route's own verification:", error);
    return NextResponse.next();
  }
}

export const config = {
  // Only the MCP endpoint needs Clerk, plus Clerk's own auto-proxy path.
  matcher: ["/(api|trpc)(.*)", "/__clerk/:path*"],
};
