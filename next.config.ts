import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude Node.js-only packages from the build bundle.
  // discord.js and deps are runtime-only (started via instrumentation.ts)
  // and cannot be bundled by Turbopack.
  serverExternalPackages: [
    "discord.js",
    "@discordjs/ws",
    "@discordjs/rest",
    "@discordjs/collection",
    "zlib-sync",
    "erlpack",
    "bufferutil",
    "utf-8-validate",
  ],
};

export default nextConfig;
