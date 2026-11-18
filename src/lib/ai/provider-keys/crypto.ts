import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_API_KEY_LENGTH = 8;
export const MAX_API_KEY_LENGTH = 512;

export interface DerivedKey {
    encryptionKey: Buffer;
    /** Names the master key in stored rows without revealing it. */
    ref: string;
}

export function deriveKey(master: Buffer): DerivedKey {
    const salt = Buffer.alloc(0);
    return {
        encryptionKey: Buffer.from(hkdfSync("sha256", master, salt, "zuychin provider keys v1 encryption", 32)),
        ref: Buffer.from(hkdfSync("sha256", master, salt, "zuychin provider keys v1 fingerprint", 8)).toString("hex"),
    };
}

// Binds a ciphertext to its row, so one copied onto another provider fails to decrypt.
function additionalData(providerId: string, ref: string): Buffer {
    return Buffer.from(`provider-key:${FORMAT}:${providerId}:${ref}`, "utf8");
}

export function encryptApiKey(key: DerivedKey, providerId: string, apiKey: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key.encryptionKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(providerId, key.ref));
    const sealed = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(".");
}

/** Throws on a wrong master key, a changed row or an unknown format. */
export function decryptApiKey(key: DerivedKey, providerId: string, stored: string): string {
    const [format, ivText, tagText, sealedText, ...rest] = stored.split(".");
    if (format !== FORMAT || rest.length || !ivText || !tagText || !sealedText) throw new Error("Unknown stored key format.");
    const iv = Buffer.from(ivText, "base64url"), tag = Buffer.from(tagText, "base64url"), sealed = Buffer.from(sealedText, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !sealed.length) throw new Error("Unknown stored key format.");
    const decipher = createDecipheriv("aes-256-gcm", key.encryptionKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(providerId, key.ref));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8");
}

/** A pasted key, trimmed, or null when it cannot be an API key (spaces inside, control characters, wrong length). */
export function normaliseApiKey(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const key = raw.trim();
    return key.length >= MIN_API_KEY_LENGTH && key.length <= MAX_API_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export function lastFour(apiKey: string): string {
    return apiKey.slice(-4);
}
