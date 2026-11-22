import { NextResponse } from "next/server";
import { bodyLimit, describeLimit } from "./limits";

export class BodyTooLargeError extends Error {
    readonly status = 413;
    constructor(readonly limit: number) { super(`Request too large. The limit is ${describeLimit(limit)}.`); }
}

export class BodyParseError extends Error {
    readonly status = 400;
    constructor() { super("The request body is not valid JSON."); }
}

function routeLimit(req: Request): number {
    return bodyLimit(new URL(req.url).pathname);
}

export function declaredTooLarge(headers: Headers, limit: number): boolean {
    const declared = Number(headers.get("content-length") ?? "");
    return Number.isFinite(declared) && declared > limit;
}

/** Reads at most limit bytes: refuses a declared length over it, counts bytes as they arrive and cancels the read at the limit. */
export async function readBodyCapped(req: Request, limit = routeLimit(req)): Promise<Uint8Array<ArrayBuffer>> {
    if (declaredTooLarge(req.headers, limit)) throw new BodyTooLargeError(limit);
    if (!req.body) return new Uint8Array();
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => { });
            throw new BodyTooLargeError(limit);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
}

export async function readTextCapped(req: Request, limit = routeLimit(req)): Promise<string> {
    return new TextDecoder().decode(await readBodyCapped(req, limit));
}

// Routes validate the shape themselves, as they did after req.json().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonCapped<T = any>(req: Request, limit = routeLimit(req)): Promise<T> {
    const text = await readTextCapped(req, limit);
    try { return JSON.parse(text) as T; } catch { throw new BodyParseError(); }
}

/** The response for a body that was too large or not JSON; null for any other error. */
export function bodyFailure(error: unknown): NextResponse | null {
    if (error instanceof BodyTooLargeError || error instanceof BodyParseError) return NextResponse.json({ error: error.message }, { status: error.status });
    return null;
}
