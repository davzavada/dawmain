import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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

export default clerkConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  // Only the MCP endpoint needs Clerk, plus Clerk's own auto-proxy path.
  matcher: ["/(api|trpc)(.*)", "/__clerk/:path*"],
};
