import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile, getCapture } from "@/lib/capture/store";
import { originalAssetPath } from "@/lib/capture/service";

const TYPES: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg" };

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const id = req.nextUrl.searchParams.get("id");
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ error: "Choose a PDF or photo capture." }, { status: 400 });
    try {
        const capture = await getCapture((await captureProfile()).id, id);
        const original = capture?.source.pdf ?? capture?.source.image;
        const path = capture && original ? originalAssetPath(id, capture.source) : null;
        if (!original || !path) return NextResponse.json({ error: "Original file not found." }, { status: 404 });
        const extension = path.slice(path.lastIndexOf(".") + 1);
        // Photos open in place; the bytes were checked as JPEG when captured, and nosniff stops any other reading.
        const disposition = extension === "pdf" ? "attachment" : "inline";
        return new Response(Buffer.from(original.base64, "base64"), { headers: { "Content-Type": TYPES[extension], "Content-Disposition": `${disposition}; filename="capture-${id}.${extension}"`,
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    } catch { return NextResponse.json({ error: "The original file is unavailable." }, { status: 503 }); }
}
