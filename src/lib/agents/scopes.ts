// knowledge:write remains compatible with both granular write scopes.

export const OWNER_SCOPES = [
    "knowledge:read", "knowledge:write", "notes:write", "vault:write", "council:owner",
] as const;

export const READONLY_SCOPES = ["knowledge:read"] as const;

function holds(scopes: readonly string[] | undefined, wanted: readonly string[]): boolean {
    if (!scopes) return false;
    return wanted.some((scope) => scopes.includes(scope));
}

export function canWriteNotes(scopes?: readonly string[]): boolean {
    return holds(scopes, ["knowledge:write", "notes:write"]);
}

export function canWriteVault(scopes?: readonly string[]): boolean {
    return holds(scopes, ["knowledge:write", "vault:write"]);
}

export function canParticipateInCouncil(scopes?: readonly string[]): boolean {
    return holds(scopes, ["council:owner", "council:seat"]);
}

export function canOwnCouncil(scopes?: readonly string[]): boolean {
    return holds(scopes, ["council:owner", "council:host"]);
}

export function isCouncilHost(scopes?: readonly string[]): boolean {
    return holds(scopes, ["council:host"]);
}

export function isCouncilOwner(scopes?: readonly string[]): boolean {
    return holds(scopes, ["council:owner"]);
}
