import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { stagedShare } from "@/lib/capture/staged-share";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/** What the share target staged: the fields as JSON, or with `file=1` the shared file itself. */
export async function GET(req: NextRequest) {
    const denied = await requireSession(req); if (denied) return denied;
    const id = req.nextUrl.searchParams.get("id") ?? "";
    const staged = /^[a-f0-9-]{36}$/.test(id) ? stagedShare(id) : null;
    if (!staged) return NextResponse.json({ error: "The shared item has expired. Share it again." }, { status: 404, headers: PRIVATE });
    if (req.nextUrl.searchParams.get("file") === "1") {
        if (!staged.file) return NextResponse.json({ error: "Nothing was attached to this share." }, { status: 404, headers: PRIVATE });
        return new Response(new Uint8Array(staged.file.bytes), { headers: { ...PRIVATE, "Content-Type": staged.file.type, "Content-Disposition": "attachment" } });
    }
    const { title, text, url, file, skipped } = staged;
    return NextResponse.json({ title, text, url, skipped, file: file && { name: file.name, type: file.type, size: file.bytes.byteLength } }, { headers: PRIVATE });
}
