// NVIDIA screens embedding input and refuses some harmless text with HTTP 422 (Nemotron 3.5, seen 24/11/2026).
const SCREEN_REFUSAL = /content safety screening/i;

export function isScreenRefusal(error: unknown): boolean {
    return error instanceof Error && (error as Error & { status?: unknown }).status === 422 && SCREEN_REFUSAL.test(error.message);
}

export function urlsToHosts(text: string): string {
    return text.replace(/https?:\/\/[^\s<>"'()]*[^\s<>"'().,;:!?]/g, (url) => {
        try { return new URL(url).hostname; } catch { return url; }
    });
}

/**
 * Embeds text past a provider screen that refuses it: URLs are cut to their host, then paragraphs the
 * screen refuses on their own are left out. Any other error, or a refusal of every variant, is thrown.
 */
export async function embedPastScreen(text: string, embed: (input: string) => Promise<number[]>): Promise<number[]> {
    let refusal: unknown;
    const attempt = async (input: string) => {
        try { return await embed(input); } catch (error) {
            if (!isScreenRefusal(error)) throw error;
            refusal = error;
            return null;
        }
    };
    const whole = await attempt(text);
    if (whole) return whole;
    const hosts = urlsToHosts(text);
    if (hosts !== text) {
        const cut = await attempt(hosts);
        if (cut) return cut;
    }
    const paragraphs = hosts.split(/\n{2,}/).filter((part) => part.trim());
    if (paragraphs.length > 1) {
        const kept: { paragraph: string; vector: number[] }[] = [];
        for (const paragraph of paragraphs) {
            const vector = await attempt(paragraph);
            if (vector) kept.push({ paragraph, vector });
        }
        if (kept.length === 1) return kept[0].vector;
        if (kept.length > 1 && kept.length < paragraphs.length) {
            const rest = await attempt(kept.map((part) => part.paragraph).join("\n\n"));
            if (rest) return rest;
        }
    }
    throw refusal;
}
