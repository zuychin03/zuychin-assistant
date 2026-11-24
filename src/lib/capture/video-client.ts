import { VIDEO_BODY_LIMIT } from "@/lib/http/limits";

// Browser side of V8 F4, also imported by the route for the event shape. No server imports.

export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm";
export const VIDEO_UPLOAD_MAX_BYTES = VIDEO_BODY_LIMIT;
export const VIDEO_HEARTBEAT_MS = 10_000;

export type VideoEvent =
    | { type: "started"; model: string }
    | { type: "done"; title: string; text: string; model: string; speech: boolean }
    | { type: "error"; error: string };
export type VideoReply = Extract<VideoEvent, { type: "done" }>;

function parseEvent(block: string): VideoEvent | null {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    if (!data) return null;
    try {
        const value = JSON.parse(data) as Partial<VideoEvent> & Record<string, unknown>;
        if (value.type === "started" && typeof value.model === "string") return { type: "started", model: value.model };
        if (value.type === "done" && typeof value.title === "string" && typeof value.text === "string" && typeof value.model === "string") {
            return { type: "done", title: value.title, text: value.text, model: value.model, speech: value.speech === true };
        }
        if (value.type === "error" && typeof value.error === "string") return { type: "error", error: value.error };
    } catch { /* not an event of ours */ }
    return null;
}

/** Reads the route's events until the notes or an error arrive; heartbeat comments are skipped. */
export async function readVideoEvents(body: ReadableStream<Uint8Array>, onStarted?: (model: string) => void): Promise<VideoReply> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = done ? "" : blocks.pop() ?? "";
        for (const block of blocks) {
            const event = parseEvent(block);
            if (event?.type === "started") onStarted?.(event.model);
            else if (event?.type === "done") { void reader.cancel().catch(() => {}); return event; }
            else if (event?.type === "error") { void reader.cancel().catch(() => {}); throw new Error(event.error); }
        }
        if (done) throw new Error("The connection closed before the notes arrived. Try again.");
    }
}

export async function postVideo(file: Blob & { name?: string }, options: { signal?: AbortSignal; onStarted?: (model: string) => void; fetchImpl?: typeof fetch } = {}): Promise<VideoReply> {
    const response = await (options.fetchImpl ?? fetch)("/api/capture/video", {
        method: "POST", body: file, cache: "no-store", signal: options.signal,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name ?? "") },
    });
    if (!response.ok || !response.body) {
        const json = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof json?.error === "string" ? json.error : `The video could not be sent (HTTP ${response.status}).`);
    }
    return readVideoEvents(response.body, options.onStarted);
}
