export const PDF_PAGE_LIMIT = 300;
const SCANNED_PAGE_CHARS = 20;

export interface PdfExtract {
    status: "ok" | "scanned" | "locked" | "failed";
    text: string;
    pages: number;
    truncated: boolean;
    note?: string;
}

class PdfDeadline extends Error {}

function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new PdfDeadline());
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PdfDeadline()), left); })])
        .finally(() => clearTimeout(timer));
}

export async function extractPdfText(data: Uint8Array, options: { deadlineMs?: number; pageLimit?: number } = {}): Promise<PdfExtract> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // A static import keeps the worker in the standalone trace; pdf.js then runs it on this thread.
    const scope = globalThis as { pdfjsWorker?: unknown };
    scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const deadline = Date.now() + (options.deadlineMs ?? 20_000), pageLimit = options.pageLimit ?? PDF_PAGE_LIMIT;
    const task = pdfjs.getDocument({
        data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0,
        maxImageSize: 16_777_216, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    });
    try {
        let document;
        try { document = await within(task.promise, deadline); } catch (error) {
            if ((error as { name?: string })?.name === "PasswordException") return { status: "locked", text: "", pages: 0, truncated: false, note: "This PDF needs a password." };
            if (error instanceof PdfDeadline) return { status: "failed", text: "", pages: 0, truncated: false, note: "The PDF took too long to open." };
            return { status: "failed", text: "", pages: 0, truncated: false, note: "The PDF could not be read." };
        }
        const total = document.numPages, texts: string[] = [];
        let note: string | undefined;
        for (let number = 1; number <= Math.min(total, pageLimit); number++) {
            try {
                const page = await within(document.getPage(number), deadline);
                const content = await within(page.getTextContent(), deadline);
                texts.push(content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("")
                    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim());
                page.cleanup();
            } catch (error) {
                if (!(error instanceof PdfDeadline)) throw error;
                note = `Stopped after ${texts.length} of ${total} pages (time limit).`;
                break;
            }
        }
        if (!note && total > pageLimit) note = `Read the first ${pageLimit} of ${total} pages.`;
        const sparse = texts.filter((text) => text.replace(/\s/g, "").length < SCANNED_PAGE_CHARS).length;
        if (!texts.length || sparse >= texts.length * 0.8) {
            return { status: "scanned", text: texts.join("\n\n").trim(), pages: total, truncated: false, note: "This PDF has no text layer. It looks scanned." };
        }
        return { status: "ok", text: texts.filter(Boolean).join("\n\n"), pages: total, truncated: texts.length < total, note };
    } catch (error) {
        console.error("[Capture] PDF text failed:", error instanceof Error ? error.message : error);
        return { status: "failed", text: "", pages: 0, truncated: false, note: "The PDF could not be read." };
    } finally {
        await task.destroy().catch(() => {});
    }
}
