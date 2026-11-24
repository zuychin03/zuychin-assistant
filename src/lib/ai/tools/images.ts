import type { McpTool, ToolContext } from "@/lib/ai/mcp-service";
import { catalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { mediaKindsEnabled } from "@/lib/ai/catalogue/sources";
import { removedModelKeys } from "@/lib/ai/models/profiles";
import { pickMediaRow, resolveModelOfKind, routableNow, type ResolvedMedia } from "@/lib/ai/media/resolve";
import { requestImage, type GeneratedImage, type MediaResult } from "@/lib/ai/media/requests";
import { observedMediaCall } from "@/lib/ai/media/observed";
import { saveArtifact } from "@/lib/artifacts/store";

// V8 F10: make_image on the approved image model (FLUX.2 klein on NIM). The tool is left out of every tool list when
// no image model can be used (Decision 8), so a retired model removes the tool instead of failing it.

export const IMAGE_PROMPT_MAX = 1000;
// FLUX.2 klein made all three in 3 to 9 s on 25/11/2026 (and 1344 x 768).
export const IMAGE_SIZES = { square: [1024, 1024], portrait: [768, 1024], landscape: [1024, 768] } as const;
export type ImageShape = keyof typeof IMAGE_SIZES;
const IMAGE_TIMEOUT_MS = 60_000;

export const MAKE_IMAGE_TOOL: McpTool = {
    name: "make_image",
    description: "Make a new picture from a text description and attach it to your reply as an image. Use it when the user asks you to draw, generate, design or illustrate something. Describe the subject, style, colours and setting in plain words; it cannot edit an existing photo, and text inside the picture may come out garbled. After calling this, say in one sentence what the picture shows.",
    parameters: {
        prompt: { type: "string", description: `What the picture should show, in plain words (at most ${IMAGE_PROMPT_MAX} characters).`, required: true },
        size: { type: "string", description: "Picture shape (default square).", required: false, enum: ["square", "portrait", "landscape"] },
    },
};

export function imageToolsEnabled(raw = process.env.IMAGE_TOOLS): boolean {
    return raw?.trim().toLowerCase() !== "off";
}

/** Synchronous, for the tool lists: an approved, passed image row this app can call now, in either mode. */
export function imageModelAvailable(): boolean {
    if (!imageToolsEnabled() || !mediaKindsEnabled()) return false;
    const snapshot = catalogueSnapshot();
    return !!pickMediaRow("image", snapshot.typedRows, { freeOnly: false, removed: removedModelKeys(snapshot.profiles), routable: routableNow });
}

export function imageTools(): McpTool[] {
    return imageModelAvailable() ? [MAKE_IMAGE_TOOL] : [];
}

/** Whole words up to 40 characters; the web chat turns the name back into the image's alt text. */
function slug(prompt: string): string {
    let out = "";
    for (const word of prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        if (out && out.length + 1 + word.length > 40) break;
        out = out ? `${out}-${word}` : word.slice(0, 40);
    }
    return out || "image";
}
const EXTENSION: Record<GeneratedImage["mimeType"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export interface ImageToolDeps {
    resolve(freeOnly: boolean): Promise<ResolvedMedia | null>;
    generate(route: ResolvedMedia, input: { prompt: string; width: number; height: number }): Promise<MediaResult<GeneratedImage>>;
    save: typeof saveArtifact;
}

const liveDeps: ImageToolDeps = {
    resolve: (freeOnly) => resolveModelOfKind("image", { freeOnly }),
    generate: (route, input) => observedMediaCall(route, "image", () => requestImage(route, input, { timeoutMs: IMAGE_TIMEOUT_MS })),
    save: saveArtifact,
};

/** The probe's own size, as a fallback when a model refuses the shape asked for. */
function probedSize(route: ResolvedMedia): [number, number] | null {
    const match = /^(\d{2,4})x(\d{2,4})$/.exec(route.row.traits?.sizes?.[0] ?? "");
    return match ? [Number(match[1]), Number(match[2])] : null;
}

export async function executeImageTool(name: string, args: Record<string, unknown>, ctx?: ToolContext, deps: ImageToolDeps = liveDeps): Promise<string | null> {
    if (name !== MAKE_IMAGE_TOOL.name) return null;
    const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim().slice(0, IMAGE_PROMPT_MAX) : "";
    if (!prompt) return "Error: `prompt` is required. Describe the picture in plain words.";
    if (!imageToolsEnabled()) return "Image making is turned off on this server, so no image was made.";
    const shape: ImageShape = typeof args.size === "string" && args.size in IMAGE_SIZES ? args.size as ImageShape : "square";
    const route = await deps.resolve(ctx?.freeOnly === true);
    if (!route) return `No image model is available right now${ctx?.freeOnly ? " in Free only" : ""}, so no image was made. Tell the user.`;
    let [width, height]: readonly number[] = IMAGE_SIZES[shape];
    let result = await deps.generate(route, { prompt, width, height });
    const fallback = probedSize(route);
    if (!result.ok && result.status === 422 && fallback && (fallback[0] !== width || fallback[1] !== height)) {
        [width, height] = fallback;
        result = await deps.generate(route, { prompt, width, height });
    }
    if (!result.ok) return `The image model (${route.row.label}) could not make this image: ${result.error} No image was attached; tell the user.`;
    try {
        const art = await deps.save({
            kind: "image", filename: `${slug(prompt)}.${EXTENSION[result.value.mimeType]}`, mimeType: result.value.mimeType, body: Buffer.from(result.value.bytes),
            conversationId: ctx?.conversationId, userProfileId: ctx?.userProfileId,
        });
        ctx?.onArtifact?.(art);
        return `Made a ${width} x ${height} image with ${route.row.label} (${Math.round(art.size / 1024)} KB). It is attached to this reply and shown to the user. Describe it in one sentence; do not add a link or file name.`;
    } catch (error) {
        console.error("[Images] Could not save the image:", error instanceof Error ? error.message : error);
        return "The image was made but could not be saved, so it is not attached. Tell the user to try again.";
    }
}
