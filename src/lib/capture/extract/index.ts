import { CaptureError } from "../service";
import type { CaptureExtract, CaptureExtractMethod, CaptureSource } from "../types";
import { fetchSource, SourceFetchError, type FetchOptions } from "../fetch/http";
import { extractHtml } from "./html";
import { extractPdfText } from "./pdf";
import { capText, countWords, decodeText, tidyMarkdown } from "./text";

export interface ExtractOptions {
    fetch?: typeof fetchSource;
    fetchOptions?: FetchOptions;
    now?: () => Date;
}

type Draft = Omit<CaptureExtract, "version" | "truncated" | "words" | "fetchedAt"> & { truncated?: boolean };

function finish(draft: Draft, now: Date): CaptureExtract {
    const capped = capText(draft.text);
    return { version: 1, ...draft, text: capped.text, truncated: capped.truncated || draft.truncated === true, words: countWords(capped.text), fetchedAt: now.toISOString() };
}

async function fromPdf(bytes: Uint8Array, base: Partial<Draft>): Promise<Draft> {
    const pdf = await extractPdfText(bytes);
    return { ...base, method: "pdf-text", status: pdf.status, text: pdf.text, pages: pdf.pages, truncated: pdf.truncated, note: pdf.note };
}

export async function extractCapture(source: CaptureSource, options: ExtractOptions = {}): Promise<CaptureExtract> {
    const now = options.now ?? (() => new Date());
    if (source.kind === "pdf") {
        if (!source.pdf?.base64) throw new CaptureError("This capture has no PDF original to read.");
        return finish(await fromPdf(Buffer.from(source.pdf.base64, "base64"), {}), now());
    }
    if (source.kind !== "link" || !source.url) throw new CaptureError("Only link and PDF captures have source text.");
    const method: CaptureExtractMethod = "html";
    if (process.env.CAPTURE_FETCH === "off") {
        return finish({ status: "failed", method, text: "", note: "Server fetching is turned off. Paste the passage instead." }, now());
    }
    try {
        const fetched = await (options.fetch ?? fetchSource)(source.url, options.fetchOptions);
        const base = { finalUrl: fetched.finalUrl, contentType: fetched.contentType };
        if (fetched.kind === "pdf") return finish(await fromPdf(fetched.body, base), now());
        const decoded = decodeText(fetched.body, fetched.charset);
        if (fetched.kind === "plain") {
            const text = tidyMarkdown(decoded);
            return finish({ ...base, method: "plain", status: text ? "ok" : "empty", text, note: text ? undefined : "The link returned no text." }, now());
        }
        const page = await extractHtml(decoded, fetched.finalUrl);
        const words = countWords(page.text);
        return finish({
            ...base, method, status: page.status, text: page.text, title: page.title, author: page.author, site: page.site, published: page.published,
            note: page.status === "ok" ? undefined : words
                ? `This page had only ${words} words of text. It may need JavaScript or a sign-in. Paste the passage if more is missing.`
                : "This page had no readable text. It may need JavaScript or a sign-in. Paste the passage instead.",
        }, now());
    } catch (error) {
        if (!(error instanceof SourceFetchError)) throw error;
        return finish({ method, status: error.reason === "blocked" ? "blocked" : "failed", text: "", note: error.message }, now());
    }
}
