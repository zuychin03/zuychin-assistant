import { NextRequest, NextResponse } from "next/server";
import { importObsidianVault } from "@/lib/knowledge/portability";
import { bodyFailure, readBodyCapped } from "@/lib/http/body";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        // Read capped, then parsed, so a body with no declared length cannot grow past the limit.
        const bytes = await readBodyCapped(req);
        const form = await new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: bytes }).formData();
        const file = form.get("vault");
        if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".zip")) {
            return NextResponse.json({ error: "Attach an Obsidian vault ZIP as 'vault'." }, { status: 400 });
        }
        const dryRun = form.get("dryRun") !== "false";
        const archive = Buffer.from(await file.arrayBuffer());
        const plan = await importObsidianVault(archive, { dryRun });
        return NextResponse.json(plan);
    } catch (error) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        console.error("[Knowledge Import]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Vault import failed.",
        }, { status: 400 });
    }
}
