export const COUNCIL_PROTOCOL_VERSION = 3 as const;
export const COUNCIL_HOST_GENERATION = "typescript-node" as const;

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
