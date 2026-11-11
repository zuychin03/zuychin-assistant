"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { Check, Fingerprint, KeyRound, LockKeyhole, ShieldCheck, Smartphone } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";

interface Passkey { credentialId: string; deviceType: string; backedUp: boolean; }
interface TotpSetup { qrCode: string; secret: string; }

export default function SecurityPanel() {
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [passkeys, setPasskeys] = useState<Passkey[]>([]);
    const [totpEnabled, setTotpEnabled] = useState(false);
    const [setup, setSetup] = useState<TotpSetup | null>(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState<"passkey" | "totp" | "verify" | null>(null);

    const load = async () => {
        setLoaded(false);
        setLoadError(false);
        try {
            const [passkeyResponse, totpResponse] = await Promise.all([fetch("/api/auth/passkey"), fetch("/api/auth/totp")]);
            if (!passkeyResponse.ok || !totpResponse.ok) throw new Error();
            const [keys, totp] = await Promise.all([passkeyResponse.json(), totpResponse.json()]);
            setPasskeys(keys.passkeys ?? []); setTotpEnabled(totp.enabled === true); setLoaded(true);
        } catch { setLoadError(true); }
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

    const protection = loadError ? "Unavailable" : !loaded ? "Checking…" : passkeys.length > 0 && totpEnabled ? "Strong" : passkeys.length > 0 ? "Good" : "Needs setup";
    const protectionTone = loadError || protection === "Needs setup" ? "warning" : loaded ? "success" : undefined;

    return <div style={styles.shell}>
        <div className="panel-head" style={{ marginBottom: 0 }}>
            <ShieldCheck size={16} />
            <div className="panel-heading">
                <h2>Security controls</h2>
                <p>Keep a biometric sign-in method and a recovery method ready before you need them.</p>
            </div>
            <div className="pill" data-tone={protectionTone} role="status">
                <span style={styles.statusDot} /> {protection}
            </div>
        </div>

        {loadError && <div role="alert" className="notice" data-tone="danger"><span>Could not load security status.</span> <button type="button" className="btn" onClick={() => void load()}>Retry status</button></div>}
        <div className="box" style={styles.confirmation}>
            <div style={styles.confirmHeader}>
                <LockKeyhole size={16} style={styles.icon} />
                <div>
                    <div style={styles.label}>Confirm before changing security</div>
                    <div className="meta">Your password is used only to approve this action.</div>
                </div>
            </div>
            <label htmlFor="security-password" style={styles.label}>Current password</label>
            <input
                id="security-password"
                className="field"
                style={styles.passwordInput}
                aria-label="Current password for security changes"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Current password"
                autoComplete="current-password"
                disabled={busy !== null}
            />
        </div>

        <div style={styles.grid}>
            <section className="box">
                <div style={styles.cardHead}>
                    <Fingerprint size={16} style={styles.icon} />
                    <div style={{ flex: 1, minWidth: 0 }}><h3 style={styles.cardTitle}>Passkeys</h3><p className="meta">Biometric sign-in with your device.</p></div>
                    <span className="pill">{loaded && !loadError ? passkeys.length : "—"}</span>
                </div>
                <div className="meta" style={styles.tip}>For dependable access, register a passkey on at least two devices.</div>
                <button className="btn" data-tone="primary" onClick={() => void addPasskey()} disabled={!password || busy !== null || !loaded || loadError}>
                    <Fingerprint size={14} /> {busy === "passkey" ? "Adding passkey..." : "Add a passkey"}
                </button>
                <div className="list" style={styles.passkeyList}>
                    {passkeys.map((passkey) => <div key={passkey.credentialId} className="row" style={styles.passkeyRow}>
                        <Check size={13} style={styles.ok} /><span>{passkey.deviceType} passkey</span><span className="meta" style={styles.passkeyMeta}>{passkey.backedUp ? "Synced" : "Device-bound"}</span>
                    </div>)}
                    {!loaded && !loadError && <div className="empty" role="status">Loading passkeys…</div>}
                    {loaded && !loadError && passkeys.length === 0 && <div className="empty">No passkeys registered yet.</div>}
                </div>
            </section>

            <section className="box">
                <div style={styles.cardHead}>
                    <Smartphone size={16} style={styles.icon} />
                    <div style={{ flex: 1, minWidth: 0 }}><h3 style={styles.cardTitle}>Authenticator recovery</h3><p className="meta">A six-digit fallback for account recovery.</p></div>
                    <span className="pill" data-tone={totpEnabled && loaded && !loadError ? "success" : undefined}>{loadError ? "Unknown" : !loaded ? "Checking…" : totpEnabled ? "Enabled" : "Optional"}</span>
                </div>
                {totpEnabled && loaded && !loadError ? <div style={styles.enabled}><Check size={14} /> Authenticator recovery is ready.</div> : <>
                    <div className="meta" style={styles.tip}>Use an authenticator app as a fallback alongside passkeys, not as their replacement.</div>
                    <button className="btn" onClick={() => void beginTotp()} disabled={!password || busy !== null || !loaded || loadError || !!setup}>
                        <KeyRound size={14} /> {busy === "totp" ? "Starting setup..." : "Set up authenticator"}
                    </button>
                </>}
                {setup && <div style={styles.setup}>
                    <div style={styles.qrFrame}><img src={setup.qrCode} alt="Authenticator setup QR code" width={156} height={156} /></div>
                    <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                        <div style={styles.label}>Scan, then confirm the code</div>
                        <div className="meta" style={styles.manualKey}>Manual key <code style={styles.code}>{setup.secret}</code></div>
                        <div style={styles.verifyRow}>
                            <input aria-label="Authenticator verification code" className="field" style={styles.codeInput} inputMode="numeric" value={code} disabled={busy !== null} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" autoComplete="one-time-code" />
                            <button className="btn" data-tone="primary" onClick={() => void verifyTotp()} disabled={code.length !== 6 || !password || busy !== null}>{busy === "verify" ? "Verifying..." : "Verify"}</button>
                        </div>
                        <button type="button" className="btn" style={{ marginTop: 8 }} disabled={busy !== null} onClick={() => { setSetup(null); setCode(""); }}>Cancel setup</button>
                    </div>
                </div>}
            </section>
        </div>
        {message && <div className="notice" role="status">{message}</div>}
    </div>;
}

const styles: Record<string, React.CSSProperties> = {
    shell: { display: "flex", flexDirection: "column", gap: 14 },
    statusDot: { width: 6, height: 6, borderRadius: "50%", background: "currentColor" },
    icon: { flexShrink: 0, marginTop: 2, color: "var(--muted)" },
    ok: { flexShrink: 0, color: "var(--success)" },
    confirmation: { display: "flex", flexDirection: "column", gap: 10 },
    confirmHeader: { display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 },
    label: { fontSize: 13.5, fontWeight: 600 },
    passwordInput: { width: "100%" },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12 },
    cardHead: { display: "flex", gap: 10, alignItems: "flex-start" },
    cardTitle: { fontSize: 14, fontWeight: 600 },
    tip: { minHeight: 36, margin: "10px 0 12px" },
    passkeyList: { marginTop: 12 },
    passkeyRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "8px 0", fontSize: 13 },
    passkeyMeta: { marginLeft: "auto" },
    enabled: { display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12, color: "var(--success)", fontSize: 13, fontWeight: 500 },
    setup: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" },
    // QR scanners need a light quiet zone in either theme.
    qrFrame: { display: "grid", placeItems: "center", padding: 7, borderRadius: "var(--radius-sm)", background: "#fff" },
    manualKey: { marginTop: 4, wordBreak: "break-all" },
    code: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-2)" },
    verifyRow: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
    codeInput: { width: 112, letterSpacing: "0.12em", fontVariantNumeric: "tabular-nums" },
};
