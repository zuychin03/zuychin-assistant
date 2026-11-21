export interface ReadCaller {
    readonly clientId?: string;
    readonly scopes?: readonly string[];
}

export function requireKnowledgeRead(caller: ReadCaller | undefined): void {
    if (Array.isArray(caller?.scopes) && caller.scopes.includes("knowledge:read")) return;
    throw new Error("This tool requires a key with knowledge read access.");
}
