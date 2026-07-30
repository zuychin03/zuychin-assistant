import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TOTP } from "otpauth";
import { authOwnerName, authSecret, totpIssuer } from "./config";

function encryptionKey() {
    return createHash("sha256").update(`zuychin-totp:${authSecret()}`).digest();
}

export function validPassword(password: unknown) {
    const expected = process.env.ACCESS_PASSWORD;
    if (!expected || typeof password !== "string") return false;
    const left = Buffer.from(password);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function encryptTotpSecret(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptTotpSecret(ciphertext: string) {
    const data = Buffer.from(ciphertext, "base64url");
    if (data.length < 29) throw new Error("Invalid stored authenticator secret.");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

export function createTotp(secret?: string) {
    return new TOTP({
        issuer: totpIssuer(),
        label: authOwnerName(),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret,
    });
}

export function validTotpCode(ciphertext: string, code: unknown) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
    return createTotp(decryptTotpSecret(ciphertext)).validate({ token: code, window: 1 }) !== null;
}
