import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveSeatKey } from "@/lib/council/seat-keys";
import { resolveAgentKey } from "./clients";

// Digests first so the comparison length never depends on the guess.
function sameSecret(provided: string, expected: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(provided), digest(expected));
}

export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;
    const host = process.env.MCP_COUNCIL_HOST_KEY;
    if (host && sameSecret(bearerToken, host)) {
        return { token: bearerToken, clientId: "council-host", scopes: ["council:host"] };
    }
    const seat = await resolveSeatKey(bearerToken);
    if (seat) {
        return {
            token: bearerToken,
            clientId: `council-seat:${seat.sessionId}:${seat.seatName}`,
            scopes: ["council:seat"],
            extra: {
                councilExecutionId: seat.executionId,
                councilExecutionBindingRequired: seat.bindingRequired,
            },
        };
    }
    const agent = await resolveAgentKey(bearerToken);
    if (agent) {
        return {
            token: bearerToken,
            clientId: `agent:${agent.clientId}:${agent.displayName}`,
            scopes: agent.scopes,
        };
    }
    return undefined;
}
