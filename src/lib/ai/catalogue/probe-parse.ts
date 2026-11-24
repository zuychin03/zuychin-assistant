import { requestParse, type MediaRoute } from "@/lib/ai/media/requests";
import { parseOutputToMarkdown } from "@/lib/capture/extract/parse-markdown";
import { PROBE_PAGE_FACTS, PROBE_PAGE_PNG_BASE64 } from "@/lib/ai/catalogue/probe-page";
import { failedProbe, observedProbeCall, type MediaProbeOptions, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

export const PARSE_OUTPUT_TOKENS = 2048;
const PROBE_TIMEOUT_MS = 60_000;

let page: Uint8Array | null = null;
export function probePage(): Uint8Array {
    page ??= new Uint8Array(Buffer.from(PROBE_PAGE_PNG_BASE64, "base64"));
    return page;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Facts of the probe page that the converted Markdown lacks. */
export function probePageMissing(markdown: string): string[] {
    const row = new RegExp(`\\|\\s*${PROBE_PAGE_FACTS.tableRow.map(escape).join("\\s*\\|\\s*")}\\s*\\|`);
    return [
        ...(markdown.includes(PROBE_PAGE_FACTS.heading) ? [] : ["heading"]),
        ...(row.test(markdown) ? [] : ["table row"]),
        ...(markdown.includes(PROBE_PAGE_FACTS.dueDate) ? [] : ["due date"]),
    ];
}

export async function probeParse(route: MediaRoute, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
    const traits = { outputTokens: PARSE_OUTPUT_TOKENS };
    const result = await observedProbeCall(route, () => requestParse(route, { bytes: probePage(), mimeType: "image/png" }, PARSE_OUTPUT_TOKENS, { ...options, timeoutMs: PROBE_TIMEOUT_MS }));
    if (!result.ok) return failedProbe("parse", result, traits);
    const missing = probePageMissing(parseOutputToMarkdown(result.value));
    const ok = !missing.length;
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: result.ms, traits,
        steps: { parse: { outcome: ok ? "pass" : "fail", httpStatus: result.status, ms: result.ms, detail: ok ? "Heading, table row and due date read." : `Missing: ${missing.join(", ")}.` } },
    };
}
