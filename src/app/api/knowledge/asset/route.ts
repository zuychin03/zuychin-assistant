import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { isImageAssetPath, photoMime } from "@/lib/knowledge/photo-paths";
import { getBinaryFile, requireVaultConfig } from "@/lib/vault/github";

// Saved photos from the vault for reply thumbnails. PNG and JPEG under attachments/ only, checked by their bytes.
const MAX_BYTES = 8 * 1024 * 1024;

export async function GET(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    const path = req.nextUrl.searchParams.get("path");
    if (!isImageAssetPath(path)) return NextResponse.json({ error: "Choose a PNG or JPEG photo under attachments/." }, { status: 400 });
    try {
        const file = await getBinaryFile(requireVaultConfig(), path);
        if (!file) return NextResponse.json({ error: "Photo not found." }, { status: 404 });
        const type = photoMime(file.content);
        if (!type || file.content.length > MAX_BYTES) return NextResponse.json({ error: "That file is not a photo this app shows." }, { status: 415 });
        const name = path.slice(path.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._-]/g, "_");
        return new Response(new Uint8Array(file.content), {
            headers: {
                "Content-Type": type, "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, max-age=3600",
                "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
            },
        });
    } catch (error) {
        console.error("[Knowledge Asset]", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The photo is unavailable." }, { status: 503 });
    }
}
