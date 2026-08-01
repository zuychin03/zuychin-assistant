"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Gavel, Plug, Rocket, ChevronDown, ChevronRight, AlertTriangle, ExternalLink } from "lucide-react";
import { styles } from "./styles";
import { findHost, launchCouncil, pair, type HostSnapshot } from "@/app/council/host-client";
import type { CouncilProposal } from "@/lib/types";

// One probe per page load, shared by every card. Scanning the port range costs
// a second when nothing is listening, and a conversation can hold several
// proposals; the answer is the same for all of them.
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
        setError("");
        setPhase("launching");
        const result = await launchCouncil(port, token, {
            topic: proposal.topic,
            brief: proposal.brief,
            agents: proposal.participants.map((p) => p.name),
            closer: proposal.closerName,
            councilType: proposal.councilType,
        });
        if ("error" in result) {
            setError(result.error);
            setPhase("ready");
            return;
        }
        setCode(result.code);
        setPhase("launched");
    }, [port, token, proposal]);

    // Only meaningful once the host has told us what it can run; an older host
    // sends no instance list, and guessing wrong would flag a valid name.
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
                    return (
                        <span
                            key={p.name}
                            style={{ ...styles.proposalAgent, ...(isUnknown ? styles.proposalAgentUnknown : {}) }}
                            title={isUnknown ? `${p.name} is not configured on this machine` : p.expertise}
                        >
                            {p.name}
                            {p.name === proposal.closerName && <span style={styles.proposalCloser}>closer</span>}
                        </span>
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

            {error && <p style={styles.proposalError}>{error}</p>}
        </div>
    );
}
