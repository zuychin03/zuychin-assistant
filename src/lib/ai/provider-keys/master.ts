import { readFileSync } from "node:fs";
import { join } from "node:path";

// systemd LoadCredential= names; the files live under $CREDENTIALS_DIRECTORY, readable only by the service user.
export const MASTER_CREDENTIAL = "provider-keys";
export const PREVIOUS_CREDENTIAL = "provider-keys-previous";
export const MASTER_ENV = "PROVIDER_KEYS_SECRET";
export const PREVIOUS_ENV = "PROVIDER_KEYS_SECRET_PREVIOUS";

export type MasterSource = "credential" | "env";
export type MasterKeyState =
    | { ok: true; key: Buffer; source: MasterSource }
    | { ok: false; reason: "missing" | "invalid"; source: MasterSource | null };

export interface MasterKeys {
    current: MasterKeyState;
    /** Set only during a rotation, and only when valid. */
    previous: Buffer | null;
}

type ReadFile = (path: string) => string;
type Env = Readonly<Record<string, string | undefined>>;

/** 32 bytes as base64 (`openssl rand -base64 32`); URL-safe base64 is accepted too. */
export function decodeMasterKey(raw: string): Buffer | null {
    const text = raw.trim();
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
    const bytes = Buffer.from(text, "base64");
    return bytes.length === 32 ? bytes : null;
}

function readCredential(env: Env, name: string, readFile: ReadFile): string | null {
    const dir = env.CREDENTIALS_DIRECTORY;
    if (!dir) return null;
    try {
        return readFile(join(dir, name));
    } catch {
        return null;
    }
}

function resolve(env: Env, credential: string, envName: string, readFile: ReadFile): MasterKeyState {
    const fromCredential = readCredential(env, credential, readFile);
    const [raw, source]: [string | undefined, MasterSource] = fromCredential !== null ? [fromCredential, "credential"] : [env[envName], "env"];
    if (!raw?.trim()) return { ok: false, reason: "missing", source: null };
    const key = decodeMasterKey(raw);
    return key ? { ok: true, key, source } : { ok: false, reason: "invalid", source };
}

/** The credential file wins over the env var, so a box with both uses the file. */
export function readMasterKeys(env: Env = process.env, readFile: ReadFile = (path) => readFileSync(path, "utf8")): MasterKeys {
    const current = resolve(env, MASTER_CREDENTIAL, MASTER_ENV, readFile);
    const previous = resolve(env, PREVIOUS_CREDENTIAL, PREVIOUS_ENV, readFile);
    return { current, previous: previous.ok ? previous.key : null };
}
