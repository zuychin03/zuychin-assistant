import { createHash } from "node:crypto";

export const COUNCIL_PROTOCOL_VERSION = 3 as const;
export const COUNCIL_HOST_GENERATION = "typescript-node" as const;

export interface HostCapabilities {
    protocolVersion: typeof COUNCIL_PROTOCOL_VERSION;
    seatCredentials: true;
    fencedDispatch: true;
    durableDeliveries: true;
    exactCommitVerification: true;
    delegatedIntegration: true;
    modelSelection: true;
    connectorCapabilitySnapshots: true;
    transportNeutralHostContracts: true;
}

export const V3_HOST_CAPABILITIES: HostCapabilities = {
    protocolVersion: COUNCIL_PROTOCOL_VERSION,
    seatCredentials: true,
    fencedDispatch: true,
    durableDeliveries: true,
    exactCommitVerification: true,
    delegatedIntegration: true,
    modelSelection: true,
    connectorCapabilitySnapshots: true,
    transportNeutralHostContracts: true,
};

export type ConnectorKind =
    | "acp"
    | "mcp"
    | "managed_api"
    | "managed_cli"
    | "text_only"
    | "manual";

export type CapabilitySource = "probed" | "configured" | "declared";
export type IdentityAssurance =
    | "verified_seat"
    | "host_bound"
    | "owner_relay"
    | "unverified_declaration";

export interface ConnectorCapabilitySnapshot {
    kind: ConnectorKind;
    source: CapabilitySource;
    streaming: boolean;
    cancellation: boolean;
    sessionResume: boolean;
    modelSelection: boolean;
    structuredActions: boolean;
    toolCalls: boolean;
    permissionCallbacks: boolean;
    filesystemMediated: boolean;
    terminalMediated: boolean;
    observedAt: string;
}

export interface CouncilAgentSelection {
    modelId?: string;
    reasoningEffort?: string;
}

export interface CouncilHostPrincipal {
    kind: "host";
    hostId: string;
    leaseEpoch: number;
}

export interface CouncilSeatPrincipal {
    kind: "seat";
    sessionId: string;
    seatName: string;
}

export type CouncilPrincipal = CouncilHostPrincipal | CouncilSeatPrincipal;

export function promptDigest(prompt: string): string {
    return createHash("sha256").update(prompt).digest("hex");
}

export function configuredCapabilities(params: {
    kind: ConnectorKind;
    modelSelection?: boolean;
    filesystemMediated?: boolean;
    terminalMediated?: boolean;
    permissionCallbacks?: boolean;
    observedAt?: string;
}): ConnectorCapabilitySnapshot {
    const acp = params.kind === "acp";
    return {
        kind: params.kind,
        source: "configured",
        streaming: acp,
        cancellation: acp,
        sessionResume: false,
        modelSelection: params.modelSelection === true,
        structuredActions: acp || params.kind === "mcp" || params.kind === "managed_api",
        toolCalls: acp || params.kind === "mcp" || params.kind === "managed_cli",
        permissionCallbacks: params.permissionCallbacks === true,
        filesystemMediated: params.filesystemMediated === true,
        terminalMediated: params.terminalMediated === true,
        observedAt: params.observedAt ?? new Date().toISOString(),
    };
}

export function isV3HostCapabilities(value: unknown): value is HostCapabilities {
    if (!value || typeof value !== "object") return false;
    const row = value as Partial<HostCapabilities>;
    return row.protocolVersion === COUNCIL_PROTOCOL_VERSION
        && row.seatCredentials === true
        && row.fencedDispatch === true
        && row.durableDeliveries === true
        && row.exactCommitVerification === true
        && row.delegatedIntegration === true
        && row.modelSelection === true
        && row.connectorCapabilitySnapshots === true
        && row.transportNeutralHostContracts === true;
}
