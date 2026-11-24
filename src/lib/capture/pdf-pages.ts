// Browser only: scanned PDF pages are rendered here and sent one at a time, because the box never renders PDFs (V8 Decision 20).
const DPI = 150;
// Bounds the canvas for oversized pages such as posters.
const MAX_SIDE = 2400;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface PdfPages {
    count: number;
    /** PNG, or JPEG when the PNG is over 2 MB (photographic scans). */
    render(number: number): Promise<Blob>;
    close(): Promise<void>;
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function openPdfPages(bytes: Uint8Array): Promise<PdfPages> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // As on the server: with the worker module loaded, pdf.js runs it on this thread and needs no worker URL.
    const scope = globalThis as { pdfjsWorker?: unknown };
    scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
    const pdf = await task.promise;
    return {
        count: pdf.numPages,
        async render(number) {
            const page = await pdf.getPage(number);
            const canvas = document.createElement("canvas");
            try {
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height)) });
                canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
                await page.render({ canvas, viewport }).promise;
                let blob = await canvasBlob(canvas, "image/png");
                if (!blob || blob.size > PAGE_MAX_BYTES) blob = await canvasBlob(canvas, "image/jpeg", 0.85);
                if (!blob || blob.size > PAGE_MAX_BYTES) throw new Error(`Page ${number} is too large to send.`);
                return blob;
            } finally {
                page.cleanup();
                canvas.width = 0; canvas.height = 0;
            }
        },
        close: () => task.destroy(),
    };
}
