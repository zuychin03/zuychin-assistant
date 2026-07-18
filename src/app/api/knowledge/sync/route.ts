import { NextRequest, NextResponse } from "next/server";
import { reconcileKnowledge } from "@/lib/knowledge/sync";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({})) as {
            fullScan?: boolean;
            applyIdentities?: boolean;
        };
        const result = await reconcileKnowledge({
            fullScan: body.fullScan !== false,
            applyIdentities: body.applyIdentities === true,
        });
        return NextResponse.json(result);
    } catch (error) {
        console.error("[Knowledge Sync]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Knowledge reconciliation failed.",
        }, { status: 500 });
    }
}
