"use client";

import ui from "./login.module.css";
import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, Lock, Loader2, ShieldCheck } from "lucide-react";
import { ZuychinMark } from "@/components/app-sidebar";

const spin = { animation: "spin 1s linear infinite" };

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"password" | "passkey" | "totp" | null>(null);
  const loading = pending !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || loading) return;

    setPending("password");
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
      setPending(null);
    }
  };

  const handlePasskey = async () => {
    if (loading) return;
    setPending("passkey"); setError("");
    try {
      const optionsRes = await fetch("/api/auth/passkey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "authentication-options" }) });
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(options.error || "Could not start passkey sign-in. Please try again.");
      const response = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch("/api/auth/passkey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "authentication-verify", response }) });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error || "Passkey verification failed. Please try again.");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in was cancelled or failed.");
    } finally { setPending(null); }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(totp) || loading) return;
    setPending("totp"); setError("");
    try {
      const res = await fetch("/api/auth/totp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recover", code: totp }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not verify the authenticator code. Please retry.");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify authenticator code.");
    } finally { setPending(null); }
  };

  return (
    <main className={ui.page}>
      <div className={ui.card}>
        <header className={ui.head}>
          <ZuychinMark size={26} className={ui.mark} />
          <h1 className={ui.title}>Sign in to Zuychin</h1>
          <p id="login-hint" className={ui.hint}>{needsTotp ? "Enter the code from your authenticator app" : "Sign in with a passkey or recovery password"}</p>
        </header>

        {!needsTotp && <button type="button" onClick={handlePasskey} disabled={loading} className={ui.primary}>{pending === "passkey" ? <Loader2 size={17} aria-hidden style={spin} /> : <KeyRound size={17} aria-hidden />} <span>{pending === "passkey" ? "Waiting for passkey…" : "Sign in with passkey"}</span></button>}
        <form onSubmit={needsTotp ? handleTotp : handleSubmit} className={ui.form} aria-busy={loading}>
          <label htmlFor="login-credential" className={ui.label}>{needsTotp ? "Authenticator code" : "Recovery password"}</label>
          <div className={ui.field}>
            {needsTotp ? <ShieldCheck size={16} aria-hidden /> : <Lock size={16} aria-hidden />}
            <input
              key={needsTotp ? "totp" : "password"}
              id="login-credential"
              aria-describedby={error ? "login-hint login-error" : "login-hint"}
              aria-invalid={!!error}
              disabled={loading}
              type={needsTotp ? "text" : "password"}
              inputMode={needsTotp ? "numeric" : undefined}
              autoComplete={needsTotp ? "one-time-code" : "current-password"}
              required
              maxLength={needsTotp ? 6 : undefined}
              value={needsTotp ? totp : password}
              onChange={(e) => needsTotp ? setTotp(e.target.value.replace(/\D/g, "").slice(0, 6)) : setPassword(e.target.value)}
              placeholder={needsTotp ? "123456" : "Password"}
              autoFocus
            />
          </div>

          {error && <p id="login-error" role="alert" className={ui.error}>{error}</p>}

          <button
            type="submit"
            disabled={needsTotp ? totp.length !== 6 || loading : !password.trim() || loading}
            className={needsTotp ? ui.primary : ui.secondary}
          >
            {pending === "password" || pending === "totp" ? (
              <><Loader2 size={17} aria-hidden style={spin} /><span>{needsTotp ? "Verifying…" : "Signing in…"}</span></>
            ) : (
              needsTotp ? "Verify code" : "Sign in with password"
            )}
          </button>
        </form>
        {needsTotp && <button type="button" disabled={loading} onClick={() => { setNeedsTotp(false); setTotp(""); setError(""); }} className={ui.linkButton}>Back to sign-in methods</button>}
      </div>
    </main>
  );
}
