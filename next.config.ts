import type { NextConfig } from "next";

/**
 * Security headers. Everywhere: HSTS, no framing (the Vlastní zdroje modal with
 * its delete and confirm buttons opens over any page, so clickjacking
 * protection cannot stop at one path) and no MIME sniffing. On the
 * Vlastní zdroje pages and API and the Zotero API: no referrer to other
 * sites and no caching of private responses anywhere between the server
 * and the browser.
 */
const everywhere = [
  // Browsers that reached the site over https once never try plain http again.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];
const privateArea = [
  ...everywhere,
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Cache-Control", value: "private, no-store" },
];

/**
 * The public https origin (PUBLIC_URL, read at build like the rest of this
 * file), or null. Cloudflare answers plain http too and hands the request
 * on with `X-Forwarded-Proto: http` (https ones say https — captured on the
 * home server, 2026-11-20); those are sent to https here, so the site does
 * not depend on a switch in the Cloudflare dashboard. A request without the
 * header (the LAN, the deploy check on its side port) is left alone.
 */
const httpsOrigin = /^https:\/\/[a-z0-9.-]+$/i.test((process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, ""))
  ? (process.env.PUBLIC_URL as string).trim().replace(/\/+$/, "")
  : null;

const nextConfig: NextConfig = {
  async redirects() {
    if (!httpsOrigin) return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "header", key: "x-forwarded-proto", value: "http" }],
        destination: `${httpsOrigin}/:path*`,
        permanent: true,
      },
    ];
  },
  // The server (deploy/web/deploy.sh) builds with NEXT_OUTPUT=standalone to
  // get a self-contained .next/standalone/server.js; a plain `npm run build`
  // for `next start` leaves it unset. A per-release deploymentId comes from
  // NEXT_DEPLOYMENT_ID, which Next reads itself.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // The MCP route is pure server code — nothing to prerender.
  poweredByHeader: false,
  // dawmain_guide reads the research manual from the repository tree at
  // call time (src/mcp/tools/guide.ts); the file is not imported anywhere,
  // so the function bundle would not carry it without this.
  outputFileTracingIncludes: {
    "/api/mcp": ["./skills/dawmain-reserse/SKILL.md"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: everywhere },
      { source: "/soubory", headers: privateArea },
      { source: "/soubory/:path*", headers: privateArea },
      { source: "/zotero", headers: privateArea },
      { source: "/vlastni-zdroje", headers: privateArea },
      { source: "/vlastni-zdroje/:path*", headers: privateArea },
      { source: "/api/files/:path*", headers: privateArea },
      { source: "/api/zotero/:path*", headers: privateArea },
    ];
  },
};

export default nextConfig;
