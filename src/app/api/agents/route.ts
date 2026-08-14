import { NextRequest, NextResponse } from "next/server";
import {
    createAgentClient, listAgentClients, revokeAgentClient, type ClientKind,
} from "@/lib/agents/clients";

// Owner-only, session-gated by proxy.ts. No plaintext credential is returned
// from here; minting lives on /api/agents/claim.

const KINDS: ClientKind[] = ["local_host", "remote_agent", "owner_tool"];

export async function GET() {
    try {
        return NextResponse.json({ clients: await listAgentClients() });
    } catch (error) {
        console.error("[Agents API] list failed:", error);
        return NextResponse.json({ error: "Failed to load agents." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!displayName) return NextResponse.json({ error: "Name the agent first." }, { status: 400 });
        if (displayName.length > 64) {
            return NextResponse.json({ error: "That name is too long." }, { status: 400 });
        }
        const kind: ClientKind = KINDS.includes(body.kind) ? body.kind : "remote_agent";

        const created = await createAgentClient({
            displayName,
            kind,
            providerHint: typeof body.providerHint === "string" ? body.providerHint.trim() || null : null,
            note: typeof body.note === "string" ? body.note.trim() || null : null,
        });
        if (!created.ok) {
            return NextResponse.json({ error: "An agent with that name already exists." }, { status: 409 });
        }
        return NextResponse.json({ id: created.id, displayName, kind });
    } catch (error) {
        console.error("[Agents API] create failed:", error);
        return NextResponse.json({ error: "Failed to add that agent." }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id") ?? "";
        if (!id) return NextResponse.json({ error: "Name the agent first." }, { status: 400 });
        await revokeAgentClient(id);
        return NextResponse.json({ revoked: id });
    } catch (error) {
        console.error("[Agents API] revoke failed:", error);
        return NextResponse.json({ error: "Failed to revoke that agent." }, { status: 500 });
    }
}
