import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reconcileKnowledge } from "@/lib/knowledge/sync";

export const maxDuration = 60;

function validSignature(body: string, signature: string | null, secret: string): boolean {
    if (!signature?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return providedBuffer.length === expectedBuffer.length
        && timingSafeEqual(providedBuffer, expectedBuffer);
}

interface PushPayload {
    commits?: {
        added?: string[];
        modified?: string[];
        removed?: string[];
    }[];
}

export async function POST(req: NextRequest) {
    const secret = process.env.GITHUB_VAULT_WEBHOOK_SECRET;
    if (!secret) return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });

    const raw = await req.text();
    if (!validSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
        return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    }
    if (req.headers.get("x-github-event") === "ping") {
        return NextResponse.json({ ok: true });
    }

    try {
        const payload = JSON.parse(raw) as PushPayload;
        const paths = new Set<string>();
        const deletedPaths = new Set<string>();
        for (const commit of payload.commits ?? []) {
            for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) paths.add(path);
            for (const path of commit.removed ?? []) deletedPaths.add(path);
        }
        const result = await reconcileKnowledge({
            paths: [...paths],
            deletedPaths: [...deletedPaths],
            fullScan: false,
        });
        return NextResponse.json(result);
    } catch (error) {
        console.error("[Knowledge Webhook]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Webhook reconciliation failed.",
        }, { status: 500 });
    }
}
