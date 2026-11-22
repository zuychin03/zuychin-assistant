"use client";

import { useEffect, useState } from "react";
import { Check, Clock, LockKeyhole, TriangleAlert, X } from "lucide-react";
import { styles } from "./styles";
import { APP_TIMEZONE } from "@/lib/datetime";
import type { HeldApproval } from "@/lib/types";

type Status = "pending" | "executing" | "succeeded" | "outcome_unknown" | "rejected" | "expired";
interface Settled { status: Status; receipt?: string | null }

function expiry(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "unknown";
    return new Intl.DateTimeFormat("en-AU", {
        timeZone: APP_TIMEZONE, day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date).replace(/\u202f/g, " ");
}

function clip(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

const noteRow = { ...styles.proposalNote, display: "flex", alignItems: "flex-start", gap: 5 } as const;
const noteIcon = { flexShrink: 0, marginTop: 3 } as const;

function Outcome({ settled }: { settled: Settled }) {
    switch (settled.status) {
        case "succeeded": return (
            <p role="status" style={noteRow}>
                <Check size={14} aria-hidden="true" style={noteIcon} />
                <span>Approved and done.{settled.receipt ? ` ${clip(settled.receipt, 500)}` : ""}</span>
            </p>
        );
        case "outcome_unknown": return (
            <p role="status" style={styles.proposalWarn}>
                <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                Approved, but the outcome is unknown. Check the destination before trying again.
            </p>
        );
        case "rejected": return <p role="status" style={noteRow}><X size={14} aria-hidden="true" style={noteIcon} />Rejected. Nothing was run.</p>;
        case "expired": return <p role="status" style={noteRow}><Clock size={14} aria-hidden="true" style={noteIcon} />Expired. Nothing was run.</p>;
        case "executing": return <p role="status" style={styles.proposalNote}>Running…</p>;
        default: return null;
    }
}

/** Approve or Reject a send the model asked for in this chat. A reload or a decision made in /tasks shows the current state. */
export function ApprovalCard({ approval, live = false }: { approval: HeldApproval; live?: boolean }) {
    const [settled, setSettled] = useState<Settled>({ status: "pending" });
    const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
    const [error, setError] = useState("");
    const [warning, setWarning] = useState("");

    useEffect(() => {
        if (live) return;
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch(`/api/tasks/approvals?id=${encodeURIComponent(approval.id)}`);
                const data = await response.json().catch(() => ({}));
                if (!cancelled && response.ok && data.approval?.status) setSettled({ status: data.approval.status, receipt: data.approval.receipt });
            } catch { }
        })();
        return () => { cancelled = true; };
    }, [approval.id, live]);

    const decide = async (decision: "approve" | "reject") => {
        setBusy(decision);
        setError("");
        try {
            const response = await fetch("/api/tasks/approvals", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: approval.id, decision }),
            });
            const data = await response.json().catch(() => ({}));
            if (data.approval?.status) setSettled({ status: data.approval.status, receipt: data.approval.receipt });
            if (typeof data.warning === "string") setWarning(data.warning);
            if (!response.ok && !data.approval) setError(data.error ?? "The decision could not be recorded. Try again from Tasks.");
        } catch {
            setError("The decision could not be recorded. Try again from Tasks.");
        } finally { setBusy(null); }
    };

    const expired = settled.status === "pending" && Date.parse(approval.expiresAt) <= Date.now();
    const shown: Settled = expired ? { status: "expired" } : settled;
    const open = shown.status === "pending";

    return (
        <div style={styles.proposalCard} aria-label="Approval needed">
            <div style={styles.proposalHead}>
                <LockKeyhole size={15} color="var(--muted)" aria-hidden="true" />
                <span style={styles.proposalKicker}>Approval needed</span>
                {open && <span style={styles.proposalType}>Expires {expiry(approval.expiresAt)}</span>}
            </div>
            <p style={styles.proposalTopic}>{approval.label}</p>
            {approval.lines.length > 0 && <p style={styles.proposalBrief}>{approval.lines.join("\n")}</p>}
            {open ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" onClick={() => void decide("approve")} disabled={busy !== null}
                        style={{ ...styles.proposalLaunch, minHeight: 44, ...(busy !== null ? styles.proposalLaunchOff : {}) }}>
                        <Check size={15} aria-hidden="true" /> {busy === "approve" ? "Sending…" : "Approve"}
                    </button>
                    <button type="button" onClick={() => void decide("reject")} disabled={busy !== null}
                        style={{ ...styles.proposalGhostBtn, minHeight: 44, ...(busy !== null ? styles.proposalLaunchOff : {}) }}>
                        {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                </div>
            ) : <Outcome settled={shown} />}
            {warning && <p role="alert" style={styles.proposalWarn}><TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />{warning}</p>}
            {error && <p role="alert" style={styles.proposalError}>{error}</p>}
        </div>
    );
}
