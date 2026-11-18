import { countWords, tidyMarkdown } from "./text";

export const MIN_PAGE_WORDS = 80;

export interface HtmlExtract {
    status: "ok" | "empty";
    text: string;
    title?: string; author?: string; site?: string; published?: string;
}

const present = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

export async function extractHtml(html: string, url: string): Promise<HtmlExtract> {
    const [{ parseHTML }, { Defuddle }] = await Promise.all([import("linkedom"), import("defuddle/node")]);
    const { document } = parseHTML(html);
    let markdown = "", meta: Record<string, unknown> = {};
    try {
        // useAsync defaults to true, which lets Defuddle call third-party APIs.
        const result = await Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false });
        markdown = result.content;
        meta = result as unknown as Record<string, unknown>;
    } catch (error) {
        console.error("[Capture] Defuddle failed, using plain page text:", error instanceof Error ? error.message : error);
        document.querySelectorAll("script,style,noscript,template,svg").forEach((node) => node.remove());
        markdown = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n");
    }
    const text = tidyMarkdown(markdown);
    return {
        status: countWords(text) >= MIN_PAGE_WORDS ? "ok" : "empty", text,
        title: present(meta.title) ?? present(document.title), author: present(meta.author), site: present(meta.site), published: present(meta.published),
    };
}
