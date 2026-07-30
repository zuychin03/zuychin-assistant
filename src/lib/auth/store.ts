import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { AUTH_OWNER_ID } from "./config";

export type PasskeyRecord = {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    createdAt: string;
    lastUsedAt: string | null;
};

type ChallengePurpose = "passkey_auth" | "passkey_register" | "totp_recovery";

export async function listPasskeys(): Promise<PasskeyRecord[]> {
    const { data, error } = await supabase
        .from("auth_passkeys")
        .select("credential_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at")
        .eq("user_id", AUTH_OWNER_ID)
        .order("created_at", { ascending: true });
    if (error) throw new Error(`Could not load passkeys: ${error.message}`);
    return (data ?? []).map((row) => ({
        credentialId: row.credential_id,
        publicKey: row.public_key,
        counter: Number(row.counter),
        transports: Array.isArray(row.transports) ? row.transports : [],
        deviceType: row.device_type,
        backedUp: row.backed_up,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    }));
}

export async function findPasskey(credentialId: string) {
    const { data, error } = await supabase
        .from("auth_passkeys")
        .select("credential_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at")
        .eq("credential_id", credentialId)
        .eq("user_id", AUTH_OWNER_ID)
        .maybeSingle();
    if (error) throw new Error(`Could not read passkey: ${error.message}`);
    if (!data) return null;
    return {
        credentialId: data.credential_id,
        publicKey: data.public_key,
        counter: Number(data.counter),
        transports: Array.isArray(data.transports) ? data.transports : [],
        deviceType: data.device_type as PasskeyRecord["deviceType"],
        backedUp: data.backed_up,
        createdAt: data.created_at,
        lastUsedAt: data.last_used_at,
    } satisfies PasskeyRecord;
}

export async function savePasskey(passkey: Omit<PasskeyRecord, "createdAt" | "lastUsedAt">) {
    const { error } = await supabase.from("auth_passkeys").insert({
        user_id: AUTH_OWNER_ID,
        credential_id: passkey.credentialId,
        public_key: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports,
        device_type: passkey.deviceType,
        backed_up: passkey.backedUp,
    });
    if (error) throw new Error(`Could not save passkey: ${error.message}`);
}

export async function updatePasskeyUse(credentialId: string, counter: number) {
    const { error } = await supabase
        .from("auth_passkeys")
        .update({ counter, last_used_at: new Date().toISOString() })
        .eq("credential_id", credentialId)
        .eq("user_id", AUTH_OWNER_ID);
    if (error) throw new Error(`Could not update passkey: ${error.message}`);
}

export async function deletePasskey(credentialId: string) {
    const { error } = await supabase
        .from("auth_passkeys")
        .delete()
        .eq("credential_id", credentialId)
        .eq("user_id", AUTH_OWNER_ID);
    if (error) throw new Error(`Could not remove passkey: ${error.message}`);
}

export async function createChallenge(purpose: ChallengePurpose, challenge: string) {
    const id = randomUUID();
    const { error } = await supabase.from("auth_challenges").insert({
        id,
        user_id: AUTH_OWNER_ID,
        purpose,
        challenge,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) throw new Error(`Could not create authentication challenge: ${error.message}`);
    return id;
}

export async function getChallenge(id: string, purpose: ChallengePurpose) {
    const { data, error } = await supabase
        .from("auth_challenges")
        .select("challenge, attempts")
        .eq("id", id)
        .eq("purpose", purpose)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (error) throw new Error(`Could not load authentication challenge: ${error.message}`);
    return data ? { challenge: data.challenge, attempts: Number(data.attempts) } : null;
}

export async function consumeChallenge(id: string, purpose: ChallengePurpose) {
    const { error } = await supabase.from("auth_challenges").delete().eq("id", id).eq("purpose", purpose);
    if (error) throw new Error(`Could not consume authentication challenge: ${error.message}`);
}

export async function registerFailedChallengeAttempt(id: string) {
    const { data, error } = await supabase
        .from("auth_challenges")
        .select("attempts")
        .eq("id", id)
        .maybeSingle();
    if (error || !data) return;
    if (Number(data.attempts) >= 4) {
        await supabase.from("auth_challenges").delete().eq("id", id);
        return;
    }
    await supabase.from("auth_challenges").update({ attempts: Number(data.attempts) + 1 }).eq("id", id);
}

export async function getTotpConfig() {
    const { data, error } = await supabase
        .from("auth_totp")
        .select("secret_ciphertext, enabled_at")
        .eq("user_id", AUTH_OWNER_ID)
        .maybeSingle();
    if (error) throw new Error(`Could not load authenticator-app settings: ${error.message}`);
    return data ? { ciphertext: data.secret_ciphertext, enabled: Boolean(data.enabled_at) } : null;
}

export async function saveTotpConfig(ciphertext: string) {
    const { error } = await supabase.from("auth_totp").upsert({
        user_id: AUTH_OWNER_ID,
        secret_ciphertext: ciphertext,
        enabled_at: null,
        updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Could not save authenticator-app settings: ${error.message}`);
}

export async function enableTotp() {
    const { error } = await supabase
        .from("auth_totp")
        .update({ enabled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", AUTH_OWNER_ID);
    if (error) throw new Error(`Could not enable authenticator-app recovery: ${error.message}`);
}
