import assert from "node:assert/strict";
import test from "node:test";
import { buildCouncilAdapterEnv, credentialValues, redactCredentials } from "./council-adapter-env.mts";

await test("adapter overrides cannot restore credentials or Node preloads, regardless of case", () => {
    const base = { Path: "fixture-bin", HOME: "fixture-home", NODE_OPTIONS: "--env-file=private.env", AUTH_SESSION_SECRET: "fixture-session", CUSTOM_OLD: "not-inherited" };
    const env = buildCouncilAdapterEnv(base, {
        pAtH: "replacement-bin", home: null, CUSTOM_MODE: "offline", CODEX_CONFIG: { plugins: {} },
        nOdE_oPtIoNs: "--require=private.cjs", NODE_PATH: "private-modules", npm_config_node_options: "--import=private.mjs",
        MCP_API_KEY: "override-shared", mcp_council_host_key: "override-host", Council_Probe_Mcp_Key: "override-probe",
        next_public_supabase_url: "https://fixture.invalid", Supabase_Service_Role_Key: "override-service",
        SESSION_COOKIE: "override-session", access_password: "override-access", CHAT_API_KEY: "override-chat",
        CRON_SECRET: "override-cron", VAPID_PRIVATE_KEY: "override-vapid", GOOGLE_REFRESH_TOKEN: "override-refresh",
        GOOGLE_CLIENT_ID: "override-google", DISCORD_BOT_TOKEN: "override-discord", TELEGRAM_BOT_TOKEN: "override-telegram",
        GITHUB_VAULT_TOKEN: "override-vault", OTHER_API_KEY: "override-unknown", SAFE_ALIAS: "fixture-session",
    });
    assert.deepEqual(env, { pAtH: "replacement-bin", CUSTOM_MODE: "offline", CODEX_CONFIG: '{"plugins":{}}' });
    assert.equal(base.Path, "fixture-bin");
    assert.equal(base.HOME, "fixture-home");
});

await test("vendor credentials require an explicit adapter override", () => {
    const base = { OPENAI_API_KEY: "inherited-openai", ANTHROPIC_API_KEY: "inherited-anthropic", CLAUDE_CODE_OAUTH_TOKEN: "inherited-claude" };
    assert.deepEqual(buildCouncilAdapterEnv(base), {});
    assert.deepEqual(buildCouncilAdapterEnv(base, { ANTHROPIC_API_KEY: "chosen-vendor-key", CLAUDE_CONFIG_DIR: "fixture-config" }), {
        ANTHROPIC_API_KEY: "chosen-vendor-key", CLAUDE_CONFIG_DIR: "fixture-config",
    });
    assert.deepEqual(buildCouncilAdapterEnv({ AUTH_SESSION_SECRET: "same-application-secret" }, { OPENAI_API_KEY: "same-application-secret" }), {});
});

await test("redaction covers known application, vendor and named credentials before truncation", () => {
    const values = credentialValues({ AUTH_SESSION_SECRET: "fixture-secret", OPENAI_API_KEY: "fixture-secret-longer", Path: "keep-path" });
    const output = redactCredentials(`fixture-secret-longer fixture-secret zck_${"b".repeat(64)} keep-path`, values);
    assert.equal(output, "[REDACTED] [REDACTED] [REDACTED] keep-path");
});
