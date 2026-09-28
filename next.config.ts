import type { NextConfig } from "next";

/**
 * Security headers. Everywhere: no framing (the Vlastní zdroje modal with
 * its delete and confirm buttons opens over any page, so clickjacking
 * protection cannot stop at one path) and no MIME sniffing. On the
 * Vlastní zdroje pages and API: no referrer to other sites and no caching
 * of private responses anywhere between the server and the browser.
 */
const everywhere = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];
const privateArea = [
  ...everywhere,
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Cache-Control", value: "private, no-store" },
];

const nextConfig: NextConfig = {
  // The MCP route is pure server code — nothing to prerender.
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: everywhere },
      { source: "/vlastni-zdroje", headers: privateArea },
      { source: "/vlastni-zdroje/:path*", headers: privateArea },
      { source: "/api/files/:path*", headers: privateArea },
    ];
  },
};

export default nextConfig;
