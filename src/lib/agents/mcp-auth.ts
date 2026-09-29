import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveSeatKey } from "@/lib/council/seat-keys";
import { resolveAgentKey } from "./clients";

export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;
    const host = process.env.MCP_COUNCIL_HOST_KEY;
    if (host && bearerToken === host) {
        return { token: bearerToken, clientId: "council-host", scopes: ["council:host"] };
    }
    const seat = await resolveSeatKey(bearerToken);
    if (seat) {
        return {
            token: bearerToken,
            clientId: `council-seat:${seat.sessionId}:${seat.seatName}`,
            scopes: ["council:seat"],
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
