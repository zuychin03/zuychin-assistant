import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted origin: ship the traced server bundle, not the repo.
  output: "standalone",
  // Page-data collection defaults to one worker per core and exhausts RAM on
  // the 16 GB build machine. Raise on a dedicated build runner.
  experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS ?? 2) },
  serverExternalPackages: ["pdfkit", "fontkit"],
  // Pin the workspace root to this project so an unrelated lockfile elsewhere
  // on the machine doesn't get picked up as the root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
