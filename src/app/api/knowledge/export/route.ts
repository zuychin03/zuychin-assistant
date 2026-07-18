import { NextResponse } from "next/server";
import { exportObsidianVault } from "@/lib/knowledge/portability";

export const maxDuration = 60;

export async function GET() {
    try {
        const { archive, manifest } = await exportObsidianVault();
        const date = new Date().toISOString().slice(0, 10);
        return new NextResponse(new Uint8Array(archive), {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="zuychin-obsidian-${date}.zip"`,
                "X-Zuychin-File-Count": String(manifest.files.length),
            },
        });
    } catch (error) {
        console.error("[Knowledge Export]", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Vault export failed.",
        }, { status: 500 });
    }
}
