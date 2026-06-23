import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit", "fontkit"],
  // Pin the workspace root to this project so an unrelated lockfile elsewhere
  // on the machine doesn't get picked up as the root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
