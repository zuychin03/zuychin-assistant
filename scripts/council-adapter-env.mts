export type AdapterEnvOverrides = Record<string, string | Record<string, unknown> | null>;

const runtimeNames = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "HOMEDRIVE", "HOMEPATH",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
    "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI", "TZ", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "NODE_ENV", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NPM_CONFIG_CACHE", "NPM_CONFIG_PREFIX",
    "CODEX_HOME", "CODEX_CONFIG", "CODEX_PROFILE", "DISABLE_MCP_CONFIG_FILTERING", "CLAUDE_CONFIG_DIR", "CLAUDECODE",
]);
const vendorCredentials = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
const blockedNames = /^(?:(?:NEXT_PUBLIC_)?SUPABASE|AUTH_|ACCESS_|CHAT_|CRON_|(?:NEXT_PUBLIC_)?VAPID_|GOOGLE_|DISCORD_|TELEGRAM_|GITHUB_VAULT_|MCP_|COUNCIL_|ZUYCHIN_|NODE_OPTIONS$|NODE_PATH$|NPM_CONFIG_NODE_OPTIONS$)|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|SERVICE_ROLE|SESSION)(?:_|$)/;

export function credentialValues(...environments: (Record<string, string | undefined> | AdapterEnvOverrides)[]): string[] {
    return [...new Set(environments.flatMap((env) => Object.entries(env)
        .filter(([name, value]) => typeof value === "string" && value.length > 0 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|GOOGLE_CLIENT_ID/i.test(name))
        .map(([, value]) => value as string)))].sort((a, b) => b.length - a.length);
}

export function buildCouncilAdapterEnv(base: Record<string, string | undefined>, overrides: AdapterEnvOverrides = {}): NodeJS.ProcessEnv {
    const merged = new Map<string, { name: string; value: string; explicit: boolean }>();
    for (const [name, value] of Object.entries(base)) {
        if (value !== undefined) merged.set(name.toUpperCase(), { name, value, explicit: false });
    }
    for (const [name, value] of Object.entries(overrides)) {
        const canonical = name.toUpperCase();
        if (value === null) merged.delete(canonical);
        else merged.set(canonical, { name, value: typeof value === "string" ? value : JSON.stringify(value), explicit: true });
    }
    const blockedValues = credentialValues(Object.fromEntries(Object.entries(base).filter(([name]) => !vendorCredentials.has(name.toUpperCase()))),
        Object.fromEntries(Object.entries(overrides).filter(([name]) => !vendorCredentials.has(name.toUpperCase()))));
    return Object.fromEntries([...merged].filter(([name, entry]) =>
        (runtimeNames.has(name) || (entry.explicit && (vendorCredentials.has(name) || !blockedNames.test(name))))
        && !blockedValues.some((secret) => entry.value.includes(secret)))
        .map(([, entry]) => [entry.name, entry.value])) as NodeJS.ProcessEnv;
}

export function redactCredentials(value: string, secrets: readonly string[]): string {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result.replace(/zck_[0-9a-f]{64}/gi, "[REDACTED]");
}
