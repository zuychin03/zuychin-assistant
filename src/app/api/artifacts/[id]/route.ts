import { NextResponse } from "next/server";
import { getArtifact } from "@/lib/artifacts/store";

// GET /api/artifacts/[id] — streams a generated file back for download.
// Auth-gated by middleware (not in the public path list).
export async function GET(
    _req: Request,
    ctx: { params: Promise<{ id: string }> },
) {
    const { id } = await ctx.params;

    const artifact = await getArtifact(id);
    if (!artifact) {
        return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    const payload = typeof artifact.body === "string"
        ? new TextEncoder().encode(artifact.body)
        : new Uint8Array(artifact.body);

    // RFC 5987 filename* handles names with spaces/unicode; let the runtime set
    // Content-Length from the byte payload (a manual, mismatched value stalls the
    // download).
    return new NextResponse(payload, {
        status: 200,
        headers: {
            "Content-Type": artifact.mime,
            "Content-Disposition": `attachment; filename="${artifact.name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
            "Cache-Control": "no-store",
        },
    });
}
