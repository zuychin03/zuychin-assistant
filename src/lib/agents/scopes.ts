// Scope predicates, kept out of the MCP route so they can be tested directly
// and reused by any non-MCP caller.
//
// knowledge:write is the owner's legacy scope and satisfies both write gates.
// notes:write and vault:write exist so a minted agent key can file a note
// without also being able to rewrite long-form vault pages. council:owner is
// minted only by the "council" access level, never by read/notes/full, so an
// ordinary agent key still cannot convene. It grants create and observe, not
// participation: asserting a seat is refused for an owner-scoped key regardless.

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
