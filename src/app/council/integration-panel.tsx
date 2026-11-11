"use client";

import { useState } from "react";
import { GitMerge, ShieldCheck } from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import { parseFrozenExecutionItems } from "@/lib/council/execution-evidence";
import { ExecutionEvidence } from "./execution-evidence";
import { OwnerMergePackage } from "./owner-merge-package";
import ui from "./council.module.css";

interface Campaign {
    status: string;
    baseBranch: string;
    integratorAgent: string | null;
    integrationBranch: string | null;
    integrationStatus: string | null;
    integrationReport: string | null;
    integrationCheckedAt: string | null;
    integrationManifest?: unknown;
}

const TONE: Record<string, "success" | "danger"> = {
    verified: "success",
    conflict: "danger",
    failed: "danger",
};

export function IntegrationPanel({ code, campaign, agentNames, onChange }: {
    code: string;
    campaign: Campaign;
    agentNames: string[];
    onChange: () => void;
}) {
    const [agent, setAgent] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function nominate() {
        const agentName = agent.trim();
        if (!agentName || busy || campaign.integrationStatus === "running") return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`/api/council/${encodeURIComponent(code)}/integrator`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentName }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                setError(data.error === "attempt_running" ? "Assembly is running. Wait for this attempt to finish before delegating again." : data.error ?? "Could not nominate an integrator.");
                return;
            }
            setAgent("");
            onChange();
        } catch {
            setError("Could not nominate an integrator.");
        } finally {
            setBusy(false);
        }
    }

    const status = campaign.integrationStatus;
    const tone = status ? TONE[status] : undefined;
    const frozenItems = parseFrozenExecutionItems(campaign.integrationManifest);

    return (
        <div className={ui.subBlock}>
            <div className={ui.subHead}><GitMerge size={15} /><span>Integration</span></div>

            {status ? (
                <>
                    <div className={ui.pillRow}>
                        <span className={ui.pill} data-tone={tone}>
                            {status}
                        </span>
                        {campaign.integrationBranch && <code>{campaign.integrationBranch}</code>}
                        {campaign.integratorAgent && <span className={ui.path}>by {campaign.integratorAgent}</span>}
                    </div>
                    {status === "verified" && (
                        <div className={ui.subNote}>
                            <ShieldCheck size={13} /> Assembled and checked. Merging into{" "}
                            <code>{campaign.baseBranch}</code> is still yours to do.
                        </div>
                    )}
                </>
            ) : (
                <div className={ui.subNote}>
                    {campaign.status === "complete"
                        ? "Every task is accepted. The host assembles them on a clean branch when it next ticks, or nominate one agent to do it."
                        : "Runs once every task has been accepted."}
                </div>
            )}

            {frozenItems.length > 0 && <details className={ui.executionHistory}>
                <summary>Accepted submission evidence <span className={ui.evidenceSummary}>{frozenItems.length} {frozenItems.length === 1 ? "task" : "tasks"}</span></summary>
                {frozenItems.map(item => <div key={item.itemId} className={ui.executionRecord}>
                    <div className={ui.evidenceNote}>Task {item.sequence} · {item.agentName} · <code>{item.commitSha}</code></div>
                    <ExecutionEvidence executionId={item.acceptedExecutionId} snapshot={item.executionEvidence} label="Frozen model details" />
                </div>)}
            </details>}
            <OwnerMergePackage key={code} code={code} revision={campaign.integrationCheckedAt} />

            {campaign.status === "complete" && (
                <div className={ui.buttonRow}>
                    <Dropdown
                        value={agent}
                        onChange={setAgent}
                        options={agentNames}
                        ariaLabel="Integration agent"
                        placeholder="Delegate the assembly to…"
                        disabled={busy || status === "running" || agentNames.length === 0}
                    />
                    <button type="button" onClick={nominate} disabled={busy || status === "running" || !agentNames.includes(agent)} className={ui.btn}>
                        {busy ? "Delegating…" : "Delegate"}
                    </button>
                </div>
            )}
            {campaign.status === "complete" && status === "running" && <p className={ui.subNote}>Assembly is running. Delegation becomes available when this attempt finishes.</p>}

            {error && <div role="alert" className={ui.errorText}>{error}</div>}
        </div>
    );
}
