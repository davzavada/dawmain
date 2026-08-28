import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MCP route is pure server code — nothing to prerender.
  poweredByHeader: false,
};

export default nextConfig;
