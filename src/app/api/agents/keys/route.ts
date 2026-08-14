import { NextRequest, NextResponse } from "next/server";
import { revokeAgentKey } from "@/lib/agents/clients";

export async function DELETE(req: NextRequest) {
    try {
        const keyId = req.nextUrl.searchParams.get("keyId") ?? "";
        if (!keyId) return NextResponse.json({ error: "Name the key first." }, { status: 400 });
        await revokeAgentKey(keyId);
        return NextResponse.json({ revoked: keyId });
    } catch (error) {
        console.error("[Agents API] key revoke failed:", error);
        return NextResponse.json({ error: "Failed to revoke that key." }, { status: 500 });
    }
}
