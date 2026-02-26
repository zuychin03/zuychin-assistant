"use client";

import { useState } from "react";
import { Bot, Lock, Loader2 } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
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

      if (res.ok) {
        window.location.href = "/";
      } else {
        const data = await res.json();
        setError(data.error || "Incorrect password");
        setPassword("");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card} className="animate-fade-in">
        <div style={styles.iconWrap}>
          <Bot size={28} color="#fff" />
        </div>

        <h1 style={styles.title}>Zuychin Assistant</h1>
        <p style={styles.subtitle}>Enter the password to continue</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.inputWrap}>
            <Lock size={16} color="var(--color-text-muted)" style={{ flexShrink: 0 }} />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              style={styles.input}
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            type="submit"
            disabled={!password.trim() || loading}
            style={{
              ...styles.button,
              opacity: !password.trim() || loading ? 0.5 : 1,
            }}
          >
            {loading ? (
              <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              "Enter"
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
    color: "#fff",
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
