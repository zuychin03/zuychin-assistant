import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted origin: ship the traced server bundle, not the repo.
  output: "standalone",
  poweredByHeader: false,
  // Page-data collection defaults to one worker per core and exhausts RAM on
  // the 16 GB build machine. Raise on a dedicated build runner.
  // proxyClientMaxBodySize is Next's default, stated because NEXT_BODY_LIMIT in src/lib/http/limits.ts
  // must match it: over it Next silently passes only the first 10 MB to the route.
  experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS ?? 2), proxyClientMaxBodySize: "10mb" },
  serverExternalPackages: ["pdfkit", "fontkit", "pdfjs-dist", "ogg-opus-decoder"],
  // Pin the workspace root to this project so an unrelated lockfile elsewhere
  // on the machine doesn't get picked up as the root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
