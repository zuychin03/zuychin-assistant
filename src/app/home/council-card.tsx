"use client";

import { Gavel } from "lucide-react";
import { styles } from "./styles";
import type { CouncilProposal } from "@/lib/types";
import { OnlineProposalCard } from "./online-council-card";

export function CouncilProposalCard({ proposal }: { proposal: CouncilProposal }) {
    return proposal.online ? <OnlineProposalCard proposal={proposal} /> : <RetiredProposalCard proposal={proposal} />;
}

// Older replies still carry proposals for the retired local agent host.
function RetiredProposalCard({ proposal }: { proposal: CouncilProposal }) {
    return (
        <div style={styles.proposalCard}>
            <div style={styles.proposalHead}>
                <Gavel size={15} color="var(--color-text-muted)" />
                <span style={styles.proposalKicker}>Proposed council</span>
                <span style={styles.proposalType}>{proposal.councilType}</span>
            </div>
            <p style={styles.proposalTopic}>{proposal.topic}</p>
            <p style={styles.proposalNote}>
                Councils of coding agents on your computer have moved to Converoom, so this proposal can no longer be
                launched here. Ask for a new council to debate it with chat models instead.
            </p>
        </div>
    );
}
