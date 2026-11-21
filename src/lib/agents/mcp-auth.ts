import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveAgentKey } from "./clients";

export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;
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
