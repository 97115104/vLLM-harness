import type { NextConfig } from "next";

const API_URL = process.env.API_URL || "http://localhost:3001";

const config: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      { source: "/v1/:path*",           destination: `${API_URL}/v1/:path*` },
      { source: "/api/health",          destination: `${API_URL}/health` },
      { source: "/api/setup/:path*",    destination: `${API_URL}/setup/:path*` },
      { source: "/api/admin/:path*",    destination: `${API_URL}/admin/:path*` },
    ];
  },
};

export default config;
