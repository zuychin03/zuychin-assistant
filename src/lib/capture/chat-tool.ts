import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { ownerLink } from "@/lib/public-url";
import { CaptureError } from "./service";
import type { CaptureItem } from "./types";

export interface CaptureAddDeps {
    profile: () => Promise<{ id: string }>;
    capture: (profile: string, id: string, input: unknown) => Promise<CaptureItem>;
}

const live: CaptureAddDeps = {
    profile: async () => (await import("./store")).captureProfile(),
    capture: async (profile, id, input) => (await import("./store")).captureService.capture(profile, id, input),
};

function invalid(error: ZodError): string {
    const field = error.issues[0]?.path[0];
    if (field === "title") return "The title must be 1 to 200 characters.";
    if (field === "text") return "The text is longer than 120,000 characters.";
    if (field === "url") return "The URL is longer than 4,000 characters.";
    return "The capture details were not valid.";
}

export async function executeCaptureAdd(args: Record<string, unknown>, ctx: { userProfileId?: string } = {}, deps: CaptureAddDeps = live): Promise<string> {
    const kind = args.kind === "link" || args.kind === "text" ? args.kind : null;
    if (!kind) return "capture_add needs kind 'link' or 'text'. Nothing was saved.";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const text = typeof args.text === "string" ? args.text : "";
    if (kind === "text" && !text.trim()) return "A text capture needs the passage in text. Nothing was saved.";
    const source = kind === "link" ? { kind, title, text, url: typeof args.url === "string" ? args.url.trim() : "" } : { kind, title, text };
    try {
        const profile = await deps.profile();
        if (ctx.userProfileId && ctx.userProfileId !== profile.id) return "Only the owner's conversations can save to the Capture inbox. Nothing was saved.";
        const id = randomUUID();
        await deps.capture(profile.id, id, source);
        return `Saved to your Capture inbox for review: ${ownerLink(`/capture?review=${id}`)}`;
    } catch (error) {
        if (error instanceof CaptureError) return `${error.message} Nothing was saved.`;
        if (error instanceof ZodError) return `${invalid(error)} Nothing was saved.`;
        throw error;
    }
}
