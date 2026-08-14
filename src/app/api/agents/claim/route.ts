import { NextRequest, NextResponse } from "next/server";
import { isAccessLevel, mintKnowledgeClaim } from "@/lib/agents/clients";
import { knowledgeAgentSetup } from "@/lib/agents/brief";

// Owner-only, session-gated by proxy.ts. Returns the claim plaintext once,
// inside the brief. The claim is not the credential: it is exchanged for one at
// /api/agent/claim, which is the only place a durable key is ever produced.

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const clientId = typeof body.clientId === "string" ? body.clientId : "";
        if (!clientId) return NextResponse.json({ error: "Name the agent first." }, { status: 400 });
        if (!isAccessLevel(body.accessLevel)) {
            return NextResponse.json({ error: "Pick an access level." }, { status: 400 });
        }

        const origin = req.nextUrl.origin;
        const minted = await mintKnowledgeClaim({ clientId, accessLevel: body.accessLevel });
        return NextResponse.json({
            claim: minted.claim,
            expiresAt: minted.expiresAt,
            accessLevel: body.accessLevel,
            brief: knowledgeAgentSetup({ baseUrl: origin, claim: minted.claim }),
        });
    } catch (error) {
        console.error("[Agents API] claim mint failed:", error);
        return NextResponse.json({ error: "Failed to mint a claim." }, { status: 500 });
    }
}
