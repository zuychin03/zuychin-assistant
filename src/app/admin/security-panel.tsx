"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { Check, Fingerprint, KeyRound, LockKeyhole, ShieldCheck, Smartphone } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";

interface Passkey { credentialId: string; deviceType: string; backedUp: boolean; }
interface TotpSetup { qrCode: string; secret: string; }

export default function SecurityPanel() {
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [passkeys, setPasskeys] = useState<Passkey[]>([]);
    const [totpEnabled, setTotpEnabled] = useState(false);
    const [setup, setSetup] = useState<TotpSetup | null>(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState<"passkey" | "totp" | "verify" | null>(null);

    const load = async () => {
        const [passkeyResponse, totpResponse] = await Promise.all([fetch("/api/auth/passkey"), fetch("/api/auth/totp")]);
        if (passkeyResponse.ok) {
            const data = await passkeyResponse.json() as { passkeys?: Passkey[] };
            setPasskeys(data.passkeys ?? []);
        }
        if (totpResponse.ok) {
            const data = await totpResponse.json() as { enabled?: boolean };
            setTotpEnabled(data.enabled === true);
        }
    };

    useEffect(() => { void load(); }, []);

    const addPasskey = async () => {
        setBusy("passkey");
        setMessage("");
        try {
            const optionsResponse = await fetch("/api/auth/passkey", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "registration-options", password }),
            });
            const options = await optionsResponse.json();
            if (!optionsResponse.ok) { setMessage(options.error ?? "Could not start passkey registration."); return; }
            const response = await startRegistration({ optionsJSON: options });
            const verifyResponse = await fetch("/api/auth/passkey", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "registration-verify", response }),
            });
            const verified = await verifyResponse.json();
            setMessage(verifyResponse.ok ? "Passkey added successfully." : verified.error ?? "Passkey verification failed.");
            if (verifyResponse.ok) void load();
        } catch { setMessage("Passkey setup was cancelled or failed."); }
        finally { setBusy(null); }
    };

    const beginTotp = async () => {
        setBusy("totp");
        setMessage("");
        try {
            const response = await fetch("/api/auth/totp", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup", password }),
            });
            const data = await response.json();
            if (!response.ok) { setMessage(data.error ?? "Could not start authenticator setup."); return; }
            setSetup(data as TotpSetup);
        } catch { setMessage("Could not start authenticator setup."); }
        finally { setBusy(null); }
    };

    const verifyTotp = async () => {
        setBusy("verify");
        setMessage("");
        try {
            const response = await fetch("/api/auth/totp", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", password, code }),
            });
            const data = await response.json();
            setMessage(response.ok ? "Authenticator recovery is enabled." : data.error ?? "Verification failed.");
            if (response.ok) { setTotpEnabled(true); setSetup(null); setCode(""); }
        } catch { setMessage("Authenticator verification failed."); }
        finally { setBusy(null); }
    };

    const protection = passkeys.length > 0 && totpEnabled ? "Strong" : passkeys.length > 0 ? "Good" : "Needs setup";

    return <div style={styles.shell}>
        <div style={styles.hero}>
            <div style={styles.heroIcon}><ShieldCheck size={22} /></div>
            <div style={{ flex: 1 }}>
                <div style={styles.eyebrow}>Account protection</div>
                <h2 style={styles.title}>Security controls</h2>
                <p style={styles.description}>Keep a biometric sign-in method and a recovery method ready before you need them.</p>
            </div>
            <div style={{ ...styles.protection, ...(protection === "Needs setup" ? styles.protectionWarn : {}) }}>
                <span style={styles.statusDot} /> {protection}
            </div>
        </div>

        <div style={styles.confirmation}>
            <div style={styles.confirmHeader}>
                <LockKeyhole size={16} />
                <div>
                    <div style={styles.confirmTitle}>Confirm before changing security</div>
                    <div style={styles.confirmCopy}>Your password is used only to approve this action.</div>
                </div>
            </div>
            <input
                style={styles.passwordInput}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Current password"
                autoComplete="current-password"
            />
        </div>

        <div style={styles.grid}>
            <section style={styles.card}>
                <div style={styles.cardHead}>
                    <div style={{ ...styles.cardIcon, color: "#7aa2ff" }}><Fingerprint size={18} /></div>
                    <div style={{ flex: 1 }}><h3 style={styles.cardTitle}>Passkeys</h3><p style={styles.cardCopy}>Biometric sign-in with your device.</p></div>
                    <span style={styles.count}>{passkeys.length}</span>
                </div>
                <div style={styles.tip}>For dependable access, register a passkey on at least two devices.</div>
                <button style={styles.primaryButton} onClick={() => void addPasskey()} disabled={!password || busy !== null}>
                    <Fingerprint size={14} /> {busy === "passkey" ? "Adding passkey..." : "Add a passkey"}
                </button>
                <div style={styles.passkeyList}>
                    {passkeys.map((passkey) => <div key={passkey.credentialId} style={styles.passkeyRow}>
                        <Check size={13} color="#31d07f" /><span>{passkey.deviceType} passkey</span><span style={styles.passkeyMeta}>{passkey.backedUp ? "Synced" : "Device-bound"}</span>
                    </div>)}
                    {passkeys.length === 0 && <div style={styles.empty}>No passkeys registered yet.</div>}
                </div>
            </section>

            <section style={styles.card}>
                <div style={styles.cardHead}>
                    <div style={{ ...styles.cardIcon, color: "#c792ea" }}><Smartphone size={18} /></div>
                    <div style={{ flex: 1 }}><h3 style={styles.cardTitle}>Authenticator recovery</h3><p style={styles.cardCopy}>A six-digit fallback for account recovery.</p></div>
                    <span style={{ ...styles.state, ...(totpEnabled ? styles.stateOn : styles.stateOff) }}>{totpEnabled ? "Enabled" : "Optional"}</span>
                </div>
                {totpEnabled ? <div style={styles.enabled}><Check size={14} /> Authenticator recovery is ready.</div> : <>
                    <div style={styles.tip}>Use an authenticator app as a fallback alongside passkeys, not as their replacement.</div>
                    <button style={styles.secondaryButton} onClick={() => void beginTotp()} disabled={!password || busy !== null}>
                        <KeyRound size={14} /> {busy === "totp" ? "Starting setup..." : "Set up authenticator"}
                    </button>
                </>}
                {setup && <div style={styles.setup}>
                    <div style={styles.qrFrame}><img src={setup.qrCode} alt="Authenticator setup QR code" width={156} height={156} /></div>
                    <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={styles.setupTitle}>Scan, then confirm the code</div>
                        <div style={styles.manualKey}>Manual key <code>{setup.secret}</code></div>
                        <div style={styles.verifyRow}>
                            <input style={styles.codeInput} inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" autoComplete="one-time-code" />
                            <button style={styles.primaryButton} onClick={() => void verifyTotp()} disabled={code.length !== 6 || busy !== null}>{busy === "verify" ? "Verifying..." : "Verify"}</button>
                        </div>
                    </div>
                </div>}
            </section>
        </div>
        {message && <div style={styles.message} role="status">{message}</div>}
    </div>;
}

const styles: Record<string, React.CSSProperties> = {
    shell: { display: "flex", flexDirection: "column", gap: 14 },
    hero: { display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 2px" },
    heroIcon: { width: 42, height: 42, display: "grid", placeItems: "center", flexShrink: 0, borderRadius: 15, color: "#31d07f", background: "color-mix(in srgb, #31d07f 13%, transparent)", border: "1px solid color-mix(in srgb, #31d07f 28%, transparent)" },
    eyebrow: { color: "var(--color-text-muted)", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.9, textTransform: "uppercase" },
    title: { margin: "2px 0 0", fontSize: 16, fontWeight: 850, letterSpacing: "-0.025em" },
    description: { margin: "4px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--color-text-muted)" },
    protection: { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, padding: "6px 8px", borderRadius: 999, color: "#31d07f", background: "color-mix(in srgb, #31d07f 12%, transparent)", fontSize: 11, fontWeight: 800 },
    protectionWarn: { color: "#e8b34b", background: "color-mix(in srgb, #e8b34b 12%, transparent)" },
    statusDot: { width: 6, height: 6, borderRadius: "50%", background: "currentColor" },
    confirmation: { display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 14, color: "var(--color-text-primary)", background: "color-mix(in srgb, var(--color-background) 54%, transparent)", border: "1px solid color-mix(in srgb, var(--color-border) 55%, transparent)" },
    confirmHeader: { display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 },
    confirmTitle: { fontSize: 12.5, fontWeight: 750 },
    confirmCopy: { marginTop: 2, fontSize: 11.5, lineHeight: 1.4, color: "var(--color-text-muted)" },
    passwordInput: { width: "100%", minWidth: 0, boxSizing: "border-box", padding: "9px 10px", borderRadius: 9, color: "var(--color-text-primary)", background: "var(--color-surface)", border: "1px solid var(--color-border)", font: "inherit", fontSize: 12 },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 },
    card: { padding: 14, borderRadius: 17, background: "color-mix(in srgb, var(--color-background) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--color-border) 55%, transparent)" },
    cardHead: { display: "flex", gap: 10, alignItems: "flex-start" },
    cardIcon: { width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 11, background: "color-mix(in srgb, var(--color-surface) 75%, transparent)", border: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)" },
    cardTitle: { margin: 0, fontSize: 13.5, fontWeight: 800 },
    cardCopy: { margin: "3px 0 0", fontSize: 11.5, color: "var(--color-text-muted)" },
    count: { minWidth: 22, padding: "4px 7px", borderRadius: 999, textAlign: "center", color: "#7aa2ff", background: "color-mix(in srgb, #7aa2ff 12%, transparent)", fontSize: 11, fontWeight: 800 },
    state: { padding: "4px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 800 },
    stateOn: { color: "#31d07f", background: "color-mix(in srgb, #31d07f 12%, transparent)" },
    stateOff: { color: "var(--color-text-muted)", background: "color-mix(in srgb, var(--color-border) 22%, transparent)" },
    tip: { minHeight: 35, margin: "12px 0", fontSize: 11.5, lineHeight: 1.45, color: "var(--color-text-muted)" },
    primaryButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 33, padding: "8px 10px", border: 0, borderRadius: 10, color: "white", background: "var(--color-primary)", font: "inherit", fontSize: 12, fontWeight: 750, cursor: "pointer" },
    secondaryButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 33, padding: "8px 10px", borderRadius: 10, color: "#c792ea", background: "color-mix(in srgb, #c792ea 10%, transparent)", border: "1px solid color-mix(in srgb, #c792ea 30%, transparent)", font: "inherit", fontSize: 12, fontWeight: 750, cursor: "pointer" },
    passkeyList: { display: "flex", flexDirection: "column", gap: 6, marginTop: 12 },
    passkeyRow: { display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 9, color: "var(--color-text-muted)", background: "color-mix(in srgb, var(--color-surface) 55%, transparent)", fontSize: 11.5 },
    passkeyMeta: { marginLeft: "auto", fontSize: 10.5, color: "var(--color-text-muted)" },
    empty: { padding: "8px 0 0", color: "var(--color-text-muted)", fontSize: 11.5 },
    enabled: { display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14, padding: "8px 9px", borderRadius: 10, color: "#31d07f", background: "color-mix(in srgb, #31d07f 10%, transparent)", fontSize: 11.5, fontWeight: 700 },
    setup: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 14, paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)" },
    qrFrame: { display: "grid", placeItems: "center", padding: 7, borderRadius: 12, background: "white" },
    setupTitle: { fontSize: 12.5, fontWeight: 750 },
    manualKey: { marginTop: 5, color: "var(--color-text-muted)", fontSize: 11, wordBreak: "break-all" },
    verifyRow: { display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" },
    codeInput: { width: 104, padding: "8px 9px", borderRadius: 9, color: "var(--color-text-primary)", background: "var(--color-surface)", border: "1px solid var(--color-border)", font: "inherit", fontSize: 12, letterSpacing: 1 },
    message: { padding: "9px 10px", borderRadius: 10, color: "var(--color-text-muted)", background: "color-mix(in srgb, var(--color-background) 55%, transparent)", fontSize: 12, lineHeight: 1.4 },
};
