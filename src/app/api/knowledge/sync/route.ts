import { NextRequest, NextResponse } from "next/server";
import { reconcileKnowledge } from "@/lib/knowledge/sync";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const body = await readJsonCapped(req).catch((error: unknown) => { if (error instanceof BodyTooLargeError) throw error; return {}; }) as {
            fullScan?: boolean;
            applyIdentities?: boolean;
        };
        const result = await reconcileKnowledge({
            fullScan: body.fullScan !== false,
            applyIdentities: body.applyIdentities === true,
        });
        return NextResponse.json(result);
    } catch (error) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        console.error("[Knowledge Sync]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Knowledge reconciliation failed.",
        }, { status: 500 });
    }
}
