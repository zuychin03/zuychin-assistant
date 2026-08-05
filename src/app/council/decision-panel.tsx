"use client";

import { useState } from "react";
import { Check, CornerUpLeft, Gavel } from "lucide-react";

// Shown only while a council is 'awaiting_owner'. Accept is the step that
// produces everything durable - the campaign, the vault page, the announcement
// - so a council Duy never rules on files nothing until its standby runs out.

export function DecisionPanel({ code, verdict, openQuestions, standbyExpiresAt, continueCount, onDecided }: {
    code: string;
    verdict: string | null;
    openQuestions: string[];
    standbyExpiresAt: string | null;
    continueCount: number;
    onDecided: () => void;
}) {
    const [directive, setDirective] = useState("");
    const [busy, setBusy] = useState<"accept" | "continue" | null>(null);
    const [error, setError] = useState("");

    async function decide(decision: "accept" | "continue") {
        if (busy) return;
        setBusy(decision);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/decide`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision, directive }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                setError(data.error ?? "That did not go through.");
                return;
            }
            setDirective("");
            onDecided();
        } catch {
            setError("That did not go through.");
        } finally {
            setBusy(null);
        }
    }

    const filesItself = standbyExpiresAt
        ? `Files itself ${new Date(standbyExpiresAt).toLocaleString()} if you do not rule.`
        : "";

    return (
        <div style={styles.wrap}>
            <div style={styles.head}>
                <Gavel size={15} />
                <span>Waiting on you</span>
                {continueCount > 0 && <span style={styles.round}>sent back {continueCount}×</span>}
            </div>
            <div style={styles.note}>
                Nothing has been filed. Accepting writes the vault page, starts any campaign and announces it.
                {filesItself && <> {filesItself}</>}
            </div>

            {verdict && <div style={styles.verdict}>{verdict}</div>}
            {openQuestions.length > 0 && (
                <ul style={styles.questions}>
                    {openQuestions.map((q) => <li key={q}>{q}</li>)}
                </ul>
            )}

            <textarea
                value={directive}
                onChange={(e) => setDirective(e.target.value)}
                placeholder="If you send it back: what should they do differently?"
                rows={2}
                style={styles.input}
            />

            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.actions}>
                <button type="button" onClick={() => decide("accept")} disabled={busy !== null} style={{ ...styles.button, ...styles.accept }}>
                    <Check size={14} /> {busy === "accept" ? "Filing…" : "Accept"}
                </button>
                <button type="button" onClick={() => decide("continue")} disabled={busy !== null} style={styles.button}>
                    <CornerUpLeft size={14} /> {busy === "continue" ? "Reopening…" : "Send back"}
                </button>
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    wrap: {
        display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 14,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, #e0a33e 45%, transparent)",
        background: "color-mix(in srgb, #e0a33e 8%, var(--color-surface))",
    },
    head: {
        display: "flex", alignItems: "center", gap: 7,
        fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)",
    },
    round: {
        fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 999,
        color: "var(--color-text-muted)",
        background: "color-mix(in srgb, var(--color-text-muted) 14%, transparent)",
    },
    note: { fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5 },
    verdict: {
        fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto",
        padding: 10, borderRadius: 10,
        background: "color-mix(in srgb, var(--color-text-muted) 10%, transparent)",
    },
    questions: { margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--color-text-muted)", lineHeight: 1.6 },
    input: {
        resize: "none", padding: "8px 10px", borderRadius: 10, fontSize: 13,
        fontFamily: "var(--font-family)", lineHeight: 1.5,
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 30%, transparent)",
        background: "var(--color-background)", color: "var(--color-text-primary)",
    },
    error: { fontSize: 12, color: "#e5484d" },
    actions: { display: "flex", gap: 8 },
    button: {
        display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px",
        borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
        borderWidth: 1, borderStyle: "solid",
        borderColor: "color-mix(in srgb, var(--color-text-muted) 35%, transparent)",
        background: "transparent", color: "var(--color-text-primary)",
    },
    accept: {
        color: "#31d07f",
        borderColor: "color-mix(in srgb, #31d07f 50%, transparent)",
        background: "color-mix(in srgb, #31d07f 12%, transparent)",
    },
};
