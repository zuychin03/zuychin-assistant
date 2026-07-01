import { NextRequest, NextResponse } from "next/server";
import { renderDocument, type ExportFormat } from "@/lib/export";

const FORMATS: ExportFormat[] = ["docx", "pdf", "md"];

// POST /api/export
export async function POST(req: NextRequest) {
    try {
        const { content, format, title = "Document" } = await req.json();

        if (!content || typeof content !== "string") {
            return NextResponse.json({ error: "Content is required." }, { status: 400 });
        }

        if (!FORMATS.includes(format)) {
            return NextResponse.json({ error: "Format must be 'docx', 'pdf' or 'md'." }, { status: 400 });
        }

        const { body, mimeType, filename } = await renderDocument(content, format, title);
        const payload = typeof body === "string" ? body : new Uint8Array(body);

        return new NextResponse(payload, {
            status: 200,
            headers: {
                "Content-Type": mimeType,
                "Content-Disposition": `attachment; filename="${filename}"`,
            },
        });
    } catch (error) {
        console.error("[Export] Error:", error);
        return NextResponse.json({ error: "Export failed." }, { status: 500 });
    }
}
