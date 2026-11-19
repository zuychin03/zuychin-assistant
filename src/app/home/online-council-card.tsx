"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, ChevronDown, ChevronRight, ExternalLink, Play } from "lucide-react";
import { styles } from "./styles";
import { Dropdown } from "@/components/dropdown";
import type { CouncilProposal } from "@/lib/types";

// An online proposal needs no host: the server runs the seats, so Start works
// from any device and the debate carries on after this page closes.

interface SeatOption { key: string; label: string; provider: string; free: boolean; speed: string; status: string | null }
interface Options { freeOnly: boolean; models: SeatOption[] }

const BRIEF_CLAMP_CHARS = 320;

function optionLabel(m: SeatOption): string {
    return [m.label, m.provider, m.free ? null : "paid", m.speed !== "unknown" ? m.speed : null].filter(Boolean).join(" · ");
}

export function OnlineProposalCard({ proposal }: { proposal: CouncilProposal }) {
    const [options, setOptions] = useState<Options | null>(null);
    const [loadError, setLoadError] = useState("");
    const [models, setModels] = useState<Record<string, string>>(() => Object.fromEntries(proposal.participants.map((p) => [p.name, p.modelKey ?? ""])));
    const [allowPaid, setAllowPaid] = useState(proposal.allowPaid === true);
    const [openBrief, setOpenBrief] = useState(false);
    const [phase, setPhase] = useState<"ready" | "starting" | "started">("ready");
    const [code, setCode] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void fetch(`/api/council/online/options?purpose=${encodeURIComponent(proposal.purpose ?? "reasoning")}`, { cache: "no-store" })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "Could not list the models.");
                if (live) setOptions(data);
            })
            .catch((reason: unknown) => { if (live) setLoadError(reason instanceof Error ? reason.message : "Could not list the models."); });
        return () => { live = false; };
    }, [proposal.purpose]);

    const paidAllowed = allowPaid && options?.freeOnly === false;
    const choices = (options?.models ?? []).filter((m) => m.free || paidAllowed);

    const start = async () => {
        const missing = proposal.participants.filter((p) => !choices.some((m) => m.key === models[p.name]));
        if (missing.length) { setError(`Choose an offered model for ${missing.map((p) => p.name).join(", ")}.`); return; }
        setError("");
        setPhase("starting");
        try {
            const res = await fetch("/api/council/online", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    topic: proposal.topic, brief: proposal.brief, closerName: proposal.closerName, maxRounds: proposal.maxRounds, allowPaid: paidAllowed,
                    seats: proposal.participants.map((p) => ({
                        name: p.name, expertise: p.expertise, modelKey: models[p.name],
                        source: models[p.name] === p.modelKey ? p.source : "picker",
                    })),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "The online council could not be started.");
            setCode(data.code);
            setPhase("started");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "The online council could not be started.");
            setPhase("ready");
        }
    };

    const briefLong = proposal.brief.length > BRIEF_CLAMP_CHARS;
    const briefShown = openBrief || !briefLong ? proposal.brief : `${proposal.brief.slice(0, BRIEF_CLAMP_CHARS).trimEnd()}…`;

    return (
        <div style={styles.proposalCard}>
            <div style={styles.proposalHead}>
                <Bot size={15} color="var(--color-primary)" />
                <span style={styles.proposalKicker}>Proposed online council</span>
                <span style={styles.proposalType}>debate</span>
            </div>

            <p style={styles.proposalTopic}>{proposal.topic}</p>
            <p style={styles.proposalBrief}>{briefShown}</p>
            {briefLong && (
                <button type="button" onClick={() => setOpenBrief((v) => !v)} style={styles.proposalMore}>
                    {openBrief ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {openBrief ? "Less" : "Full brief"}
                </button>
            )}

            <div style={seatStyles.list}>
                {proposal.participants.map((p) => (
                    <div key={p.name} style={seatStyles.seat}>
                        <div style={seatStyles.head}>
                            <span>{p.name}</span>
                            {p.name === proposal.closerName && <span style={styles.proposalCloser}>closer</span>}
                        </div>
                        <p style={styles.proposalNote}>{p.expertise}</p>
                        <Dropdown ariaLabel={`Model for ${p.name}`} value={models[p.name] ?? ""} disabled={phase !== "ready" || !options}
                            onChange={(key) => setModels((current) => ({ ...current, [p.name]: key }))}
                            options={[{ value: "", label: options ? "Choose a model" : "Loading models…" }, ...choices.map((m) => ({ value: m.key, label: optionLabel(m) }))]}
                            style={seatStyles.input} />
                    </div>
                ))}
            </div>

            <label style={seatStyles.check} title={options?.freeOnly ? "Free only is on in chat settings, so paid models stay off." : undefined}>
                <input type="checkbox" checked={paidAllowed} disabled={!options || options.freeOnly || phase !== "ready"} onChange={(e) => setAllowPaid(e.target.checked)} />
                Allow paid{options?.freeOnly ? " (Free only is on)" : ""}
            </label>

            {loadError && <p role="alert" style={styles.proposalError}>{loadError}</p>}

            {phase !== "started" && (
                <button type="button" onClick={() => void start()} disabled={phase === "starting" || !options}
                    style={{ ...styles.proposalLaunch, minHeight: 44, ...(phase === "starting" || !options ? styles.proposalLaunchOff : {}) }}>
                    <Play size={13} />
                    {phase === "starting" ? "Starting…" : "Start online council"}
                </button>
            )}

            {phase === "started" && code && (
                <p style={styles.proposalNote}>
                    <strong style={styles.proposalCodeStrong}>{code}</strong> is running on the server and carries on if you close this page.{" "}
                    <Link href="/council" style={styles.proposalLink}>Watch it <ExternalLink size={11} /></Link>
                </p>
            )}

            {error && <p role="alert" style={styles.proposalError}>{error}</p>}
        </div>
    );
}

const seatStyles: Record<string, React.CSSProperties> = {
    list: { display: "flex", flexWrap: "wrap", gap: 8 },
    seat: { flex: "1 1 220px", minWidth: 0, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm, 8px)", background: "var(--color-background)", overflowWrap: "anywhere" },
    head: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-primary)" },
    input: { flex: "0 0 auto", width: "100%", minHeight: 44, fontSize: 12 },
    check: { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44, fontSize: 12, color: "var(--color-text-muted)" },
};
