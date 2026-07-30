"use client";

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Bot, KeyRound, Lock, Loader2, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || loading) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();
      if (res.ok && data.requiresTotp) {
        setNeedsTotp(true);
      } else if (res.ok) {
        window.location.href = "/";
      } else {
        setError(data.error || "Incorrect password");
        setPassword("");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskey = async () => {
    if (loading) return;
    setLoading(true); setError("");
    try {
      const optionsRes = await fetch("/api/auth/passkey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "authentication-options" }) });
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(options.error);
      const response = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch("/api/auth/passkey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "authentication-verify", response }) });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error);
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in was cancelled or failed.");
    } finally { setLoading(false); }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(totp) || loading) return;
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth/totp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recover", code: totp }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify authenticator code.");
    } finally { setLoading(false); }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card} className="animate-fade-in">
        <div style={styles.iconWrap}>
          <Bot size={28} color="var(--color-primary-foreground)" />
        </div>

        <h1 style={styles.title}>Zuychin Assistant</h1>
        <p style={styles.subtitle}>{needsTotp ? "Enter the code from your authenticator app" : "Sign in with a passkey or recovery password"}</p>

        {!needsTotp && <button type="button" onClick={handlePasskey} disabled={loading} style={{ ...styles.button, marginBottom: 12, opacity: loading ? 0.5 : 1 }}>{loading ? <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> : <><KeyRound size={18} /> <span>Sign in with passkey</span></>}</button>}
        <form onSubmit={needsTotp ? handleTotp : handleSubmit} style={styles.form}>
          <div style={styles.inputWrap}>
            {needsTotp ? <ShieldCheck size={16} color="var(--color-text-muted)" style={{ flexShrink: 0 }} /> : <Lock size={16} color="var(--color-text-muted)" style={{ flexShrink: 0 }} />}
            <input
              type={needsTotp ? "text" : "password"}
              inputMode={needsTotp ? "numeric" : undefined}
              autoComplete={needsTotp ? "one-time-code" : "current-password"}
              value={needsTotp ? totp : password}
              onChange={(e) => needsTotp ? setTotp(e.target.value.replace(/\D/g, "").slice(0, 6)) : setPassword(e.target.value)}
              placeholder={needsTotp ? "123456" : "Password"}
              autoFocus
              style={styles.input}
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            type="submit"
            disabled={needsTotp ? totp.length !== 6 || loading : !password.trim() || loading}
            style={{
              ...styles.button,
              opacity: needsTotp ? (totp.length !== 6 || loading ? 0.5 : 1) : (!password.trim() || loading ? 0.5 : 1),
            }}
          >
            {loading ? (
              <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              needsTotp ? "Verify code" : "Enter"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100dvh",
    padding: 20,
    background: "var(--color-background)",
  },
  card: {
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--color-text-primary)",
    letterSpacing: "-0.4px",
  },
  subtitle: {
    fontSize: 14,
    color: "var(--color-text-muted)",
    marginBottom: 20,
  },
  form: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  inputWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--color-surface)",
    borderRadius: "var(--radius-md)",
    padding: "12px 14px",
    border: "1px solid var(--color-border)",
  },
  input: {
    flex: 1,
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 15,
    fontFamily: "var(--font-family)",
    color: "var(--color-text-primary)",
  },
  error: {
    fontSize: 13,
    color: "#e53e3e",
    textAlign: "center",
  },
  button: {
    width: "100%",
    padding: "12px 0",
    borderRadius: "var(--radius-md)",
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    border: "none",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "var(--font-family)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity 0.15s ease",
  },
};
