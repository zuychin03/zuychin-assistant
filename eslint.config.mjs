import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "src-tauri/target/**",
    "src-tauri/gen/**",
    "next-env.d.ts",
    // standalone node scripts (CommonJS, not part of the next app)
    "discord-bot/**",
    "stt-service/**",
    "test-google-auth.js",
    // Gitignored design-review workspace: repo copies and their builds, not source.
    ".impeccable/**",
    // Gitignored agent worktrees: other checkouts of this repo and their builds.
    ".claude/**",
  ]),
]);

export default eslintConfig;
