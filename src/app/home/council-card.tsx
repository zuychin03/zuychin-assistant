"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Gavel, Plug, Rocket, ChevronDown, ChevronRight, AlertTriangle, ExternalLink } from "lucide-react";
import { styles } from "./styles";
import { findHost, launchCouncil, pair, type HostSnapshot } from "@/app/council/host-client";
import { Dropdown } from "@/components/dropdown";
import { prepareProposalSelections, proposalSeatChoices, type ProposalSelections } from "./council-proposal-selection";
import type { CouncilProposal } from "@/lib/types";

// Reuse host discovery across proposal cards in the same page.
type Found = Awaited<ReturnType<typeof findHost>>;
let lookup: Promise<Found> | null = null;

function lookupHost(refresh = false): Promise<Found> {
    if (refresh || !lookup) lookup = findHost();
    return lookup;
}

const BRIEF_CLAMP_CHARS = 320;

type Phase = "probing" | "absent" | "unpaired" | "ready" | "busy" | "launching" | "launched";

export function CouncilProposalCard({ proposal }: { proposal: CouncilProposal }) {
    const [phase, setPhase] = useState<Phase>("probing");
    const [port, setPort] = useState<number | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
    const [code, setCode] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [pairCode, setPairCode] = useState("");
    const [openBrief, setOpenBrief] = useState(false);
    const [selections, setSelections] = useState<ProposalSelections>({});

    const settle = useCallback((found: Found) => {
        if (!found) { setPhase("absent"); setPort(null); return; }
        setPort(found.port);
        if (!found.token) { setPhase("unpaired"); return; }
        setToken(found.token);
        setSnapshot(found.snapshot);
        setPhase(found.snapshot?.code ? "busy" : "ready");
    }, []);

    useEffect(() => {
        let live = true;
        void lookupHost().then((found) => { if (live) settle(found); });
        return () => { live = false; };
    }, [settle]);

    const submitPairing = useCallback(async () => {
        if (!port) return;
        const fresh = await pair(port, pairCode);
        if (!fresh) { setError("That pairing code was not accepted."); return; }
        setError("");
        setPairCode("");
        settle(await lookupHost(true));
    }, [port, pairCode, settle]);

    const launch = useCallback(async () => {
        if (!port || !token) return;
        const prepared = prepareProposalSelections(snapshot, proposal.participants.map(participant => participant.name), selections);
        if ("error" in prepared) { setError(prepared.error); return; }
        setError("");
        setPhase("launching");
        const result = await launchCouncil(port, token, {
            topic: proposal.topic,
            brief: proposal.brief,
            agents: proposal.participants.map((p) => p.name),
            closer: proposal.closerName,
            councilType: proposal.councilType,
            ...(Object.keys(prepared.selections).length ? { selections: prepared.selections } : {}),
        });
        if ("error" in result) {
            setError(result.error);
            setPhase("ready");
            return;
        }
        setCode(result.code);
        setPhase("launched");
    }, [port, token, proposal, snapshot, selections]);

    // Older hosts omit the roster; do not reject names without that evidence.
    const known = snapshot?.instances?.map((i) => i.name);
    const unknown = known ? proposal.participants.filter((p) => !known.includes(p.name)) : [];

    const briefLong = proposal.brief.length > BRIEF_CLAMP_CHARS;
    const briefShown = openBrief || !briefLong
        ? proposal.brief
        : `${proposal.brief.slice(0, BRIEF_CLAMP_CHARS).trimEnd()}…`;

    return (
        <div style={styles.proposalCard}>
            <div style={styles.proposalHead}>
                <Gavel size={15} color="var(--color-primary)" />
                <span style={styles.proposalKicker}>Proposed council</span>
                <span style={styles.proposalType}>{proposal.councilType}</span>
            </div>

            <p style={styles.proposalTopic}>{proposal.topic}</p>

            <p style={styles.proposalBrief}>{briefShown}</p>
            {briefLong && (
                <button type="button" onClick={() => setOpenBrief((v) => !v)} style={styles.proposalMore}>
                    {openBrief ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {openBrief ? "Less" : "Full brief"}
                </button>
            )}

            <div style={styles.proposalAgents}>
                {proposal.participants.map((p) => {
                    const isUnknown = unknown.includes(p);
                    const choice = proposalSeatChoices(snapshot, p.name);
                    const selection = selections[p.name] ?? {};
                    const explicit = Boolean(selection.modelId || selection.reasoningEffort);
                    return (
                        <details key={p.name} style={seatStyles.seat}>
                            <summary style={seatStyles.summary}>
                                <span style={{ color: isUnknown ? "var(--color-warning)" : "var(--color-text-primary)" }}>{p.name}</span>{" "}
                                {p.name === proposal.closerName && <span style={styles.proposalCloser}>closer</span>}
                                <span style={seatStyles.state}>{explicit ? "Custom selection" : "Host default"}</span>
                            </summary>
                            <div style={seatStyles.body}>
                                <p style={styles.proposalNote}>{p.expertise}</p>
                                {choice.instance && <p style={styles.proposalNote}>{choice.instance.provider} · {choice.instance.mode.toUpperCase()}</p>}
                                {choice.models.length > 0 ? <label style={seatStyles.field}>Model
                                    <Dropdown ariaLabel={`Model for ${p.name}`} value={selection.modelId ?? ""} disabled={phase !== "ready"}
                                        onChange={modelId => setSelections(current => ({ ...current, [p.name]: { ...current[p.name], modelId: modelId || undefined } }))}
                                        options={[{ value: "", label: `Host default${choice.instance?.defaultModel ? ` (${choice.instance.defaultModel})` : ""}` }, ...choice.models.map(value => ({ value }))]}
                                        style={seatStyles.input} />
                                </label> : <p style={styles.proposalNote}>{choice.instance ? `Model: ${choice.instance.defaultModel ?? "provider default"}. ${choice.supported ? "Model selection is locked for this seat." : "This host does not advertise model selection."}` : isUnknown ? "This seat is not configured on the host." : "Model choices appear when a supported host is connected."}</p>}
                                {choice.efforts.length > 0 && <label style={seatStyles.field}>Reasoning effort
                                    <Dropdown ariaLabel={`Reasoning effort for ${p.name}`} value={selection.reasoningEffort ?? ""} disabled={phase !== "ready"}
                                        onChange={reasoningEffort => setSelections(current => ({ ...current, [p.name]: { ...current[p.name], reasoningEffort: reasoningEffort || undefined } }))}
                                        options={[{ value: "", label: `Host default${choice.instance?.defaultReasoningEffort ? ` (${choice.instance.defaultReasoningEffort})` : ""}` }, ...choice.efforts.map(value => ({ value }))]}
                                        style={seatStyles.input} />
                                </label>}
                                {choice.instance?.warn && <p style={styles.proposalWarn}>{choice.instance.warn}</p>}
                            </div>
                        </details>
                    );
                })}
            </div>

            {unknown.length > 0 && (
                <p style={styles.proposalWarn}>
                    <AlertTriangle size={12} />
                    {unknown.map((p) => p.name).join(", ")} {unknown.length > 1 ? "are" : "is"} not configured on this
                    machine{known && known.length > 0 ? `; it runs ${known.join(", ")}` : ""}. Launching would fail.
                </p>
            )}

            {phase === "probing" && <p style={styles.proposalNote}>Looking for your council host…</p>}

            {phase === "absent" && (
                <p style={styles.proposalNote}>
                    No council host is running on this machine, so there is nothing to launch on. Start one with{" "}
                    <code style={styles.proposalCode}>scripts\council-host-start.cmd</code>, then reload. The proposal
                    stays valid.
                </p>
            )}

            {phase === "unpaired" && (
                <div style={styles.proposalPairRow}>
                    <Plug size={13} color="var(--color-text-muted)" />
                    <input
                        value={pairCode}
                        onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                        onKeyDown={(e) => { if (e.key === "Enter") void submitPairing(); }}
                        placeholder="Pairing code"
                        style={styles.proposalPairInput}
                        maxLength={8}
                    />
                    <button type="button" onClick={() => void submitPairing()} style={styles.proposalGhostBtn}>
                        Pair
                    </button>
                </div>
            )}

            {phase === "busy" && (
                <p style={styles.proposalNote}>
                    Your host is already running {snapshot?.code}. Finish or close it first —{" "}
                    <Link href="/council" style={styles.proposalLink}>open Council <ExternalLink size={11} /></Link>
                </p>
            )}

            {(phase === "ready" || phase === "launching") && (
                <button
                    type="button"
                    onClick={() => void launch()}
                    disabled={phase === "launching" || unknown.length > 0}
                    style={{
                        ...styles.proposalLaunch,
                        minHeight: 44,
                        ...(phase === "launching" || unknown.length > 0 ? styles.proposalLaunchOff : {}),
                    }}
                >
                    <Rocket size={13} />
                    {phase === "launching" ? "Starting the agents…" : "Launch council"}
                </button>
            )}

            {phase === "launched" && code && (
                <p style={styles.proposalNote}>
                    <strong style={styles.proposalCodeStrong}>{code}</strong> is running —{" "}
                    <Link href="/council" style={styles.proposalLink}>watch it <ExternalLink size={11} /></Link>
                </p>
            )}

            {error && <p role="alert" style={styles.proposalError}>{error}</p>}
        </div>
    );
}

const seatStyles: Record<string, React.CSSProperties> = {
    seat: { flex: "1 1 220px", minWidth: 0, maxWidth: "100%", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm, 8px)", background: "var(--color-background)", overflowWrap: "anywhere" },
    summary: { minHeight: 44, padding: "10px 12px", fontSize: 12, cursor: "pointer" },
    state: { marginLeft: 8, fontSize: 11, color: "var(--color-text-muted)" },
    body: { display: "flex", flexDirection: "column", gap: 10, padding: "0 12px 12px" },
    field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5, color: "var(--color-text-muted)", minWidth: 0 },
    input: { flex: "0 0 auto", width: "100%", minHeight: 44, fontSize: 12 },
};
