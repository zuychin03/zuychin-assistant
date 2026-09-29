import { canOwnCouncil } from "./scopes";

export interface ReadCaller {
    readonly clientId?: string;
    readonly scopes?: readonly string[];
}

export function requireKnowledgeRead(caller: ReadCaller | undefined): void {
    if (Array.isArray(caller?.scopes) && caller.scopes.includes("knowledge:read")) return;
    throw new Error("This tool requires a key with knowledge read access.");
}

export function requireCouncilObserver(caller: ReadCaller | undefined, sessionId?: string): void {
    const scopes = Array.isArray(caller?.scopes) ? caller.scopes : [];
    if (scopes.includes("council:seat")) {
        const marker = "council-seat:";
        const id = caller?.clientId;
        if (typeof id !== "string" || !id.startsWith(marker)) {
            throw new Error("This tool requires a valid Council seat identity.");
        }
        const identity = id.slice(marker.length);
        // Seat names can contain colons; only the first separates the session.
        const separator = identity.indexOf(":");
        const seatSessionId = identity.slice(0, separator);
        const seatName = identity.slice(separator + 1);
        if (separator < 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seatSessionId) || !seatName.trim()) {
            throw new Error("This tool requires a valid Council seat identity.");
        }
        if (sessionId !== undefined && sessionId !== seatSessionId) {
            throw new Error("That seat key belongs to a different council.");
        }
        return;
    }
    if (scopes.includes("knowledge:read") || canOwnCouncil(scopes)) return;
    throw new Error("This tool requires knowledge read access, an owner key, a Council host credential, or a seat in this Council.");
}
