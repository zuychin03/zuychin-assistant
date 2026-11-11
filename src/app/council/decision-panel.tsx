"use client";

import { useState } from "react";
import { Check, CornerUpLeft, Gavel } from "lucide-react";
import ui from "./council.module.css";

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
        ? `Files itself ${new Date(standbyExpiresAt).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })} if you do not rule.`
        : "";

    return (
        <div className={ui.subBlock} data-emphasis>
            <div className={ui.subHead} data-signal>
                <Gavel size={15} />
                <span>Waiting on you</span>
                {continueCount > 0 && <span className={ui.pill}>sent back {continueCount}×</span>}
            </div>
            <div className={ui.subNote}>
                Nothing has been filed. Accepting writes the vault page, starts any campaign and announces it.
                {filesItself && <> {filesItself}</>}
            </div>

            {verdict && <div className={ui.decisionVerdict}>{verdict}</div>}
            {openQuestions.length > 0 && (
                <ul className={ui.questions}>
                    {openQuestions.map((q) => <li key={q}>{q}</li>)}
                </ul>
            )}

            <textarea aria-label="Decision or follow-up instructions"
                value={directive}
                onChange={(e) => setDirective(e.target.value)}
                placeholder="If you send it back: what should they do differently?"
                rows={2}
                className={`${ui.input} ${ui.textarea}`}
            />

            {error && <div className={ui.errorText} role="alert">{error}</div>}

            <div className={ui.buttonRow}>
                <button type="button" onClick={() => decide("accept")} disabled={busy !== null} className={`${ui.btn} ${ui.primary}`}>
                    <Check size={14} /> {busy === "accept" ? "Filing…" : "Accept"}
                </button>
                <button type="button" onClick={() => decide("continue")} disabled={busy !== null} className={ui.btn}>
                    <CornerUpLeft size={14} /> {busy === "continue" ? "Reopening…" : "Send back"}
                </button>
            </div>
        </div>
    );
}
