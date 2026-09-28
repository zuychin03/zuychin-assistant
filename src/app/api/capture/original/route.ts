import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { captureProfile, getCapture } from "@/lib/capture/store";
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    const id = req.nextUrl.searchParams.get("id");
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ error: "Choose a PDF capture." }, { status: 400 });
    try {
        const capture = await getCapture((await captureProfile()).id, id);
        if (!capture?.source.pdf) return NextResponse.json({ error: "PDF original not found." }, { status: 404 });
        const bytes = Buffer.from(capture.source.pdf.base64, "base64");
        return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="capture-${id}.pdf"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    } catch { return NextResponse.json({ error: "The original PDF is unavailable." }, { status: 503 }); }
}
