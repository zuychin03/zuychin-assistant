import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { AddressRefused, guardedLookup, isPublicAddress, systemResolver, type AddressPolicy, type Resolver } from "./address";

export type SourceKind = "html" | "plain" | "pdf";
export interface FetchedSource { finalUrl: string; status: number; kind: SourceKind; contentType: string; charset?: string; body: Buffer }
export type FetchFailure = "blocked" | "dns" | "timeout" | "network" | "http" | "redirects" | "type" | "size";

export class SourceFetchError extends Error {
    constructor(readonly reason: FetchFailure, message: string, readonly status?: number) { super(message); this.name = "SourceFetchError"; }
}

export interface FetchOptions {
    policy?: AddressPolicy;
    resolver?: Resolver;
    ports?: ReadonlySet<number>;
    totalMs?: number;
    connectMs?: number;
    maxRedirects?: number;
    limits?: Partial<Record<SourceKind, number>>;
}

const MB = 1024 * 1024;
const LIMITS: Record<SourceKind, number> = { html: 3 * MB, plain: 3 * MB, pdf: 5 * MB };
const TYPES: Record<string, SourceKind> = {
    "text/html": "html", "application/xhtml+xml": "html", "text/plain": "plain", "text/markdown": "plain", "text/x-markdown": "plain", "application/pdf": "pdf",
};
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ZuychinCapture/1.0)",
    Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,text/markdown;q=0.8",
    "Accept-Language": "en-AU,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
};

export function checkSourceUrl(raw: string, policy: AddressPolicy = isPublicAddress, ports: ReadonlySet<number> = new Set([80, 443])): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new SourceFetchError("blocked", "The link is not a valid URL."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceFetchError("blocked", "Only http and https links can be fetched.");
    if (url.username || url.password) throw new SourceFetchError("blocked", "Links with a user name or password are not fetched.");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!ports.has(port)) throw new SourceFetchError("blocked", `Port ${port} is not fetched. Only ports 80 and 443 are.`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !policy(host)) throw new SourceFetchError("blocked", "This address isn't public, so Capture won't fetch it.");
    return url;
}

function failure(error: unknown, signal: AbortSignal): SourceFetchError {
    if (error instanceof SourceFetchError) return error;
    if (error instanceof AddressRefused) return new SourceFetchError("blocked", "This address isn't public, so Capture won't fetch it.");
    if (signal.aborted) return new SourceFetchError("timeout", "The site took too long to respond.");
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOTFOUND") return new SourceFetchError("dns", "The site's host name could not be found.");
    return new SourceFetchError("network", `The site could not be reached${code ? ` (${code})` : ""}.`);
}

function open(url: URL, options: Required<Pick<FetchOptions, "policy" | "resolver" | "connectMs">>, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const secure = url.protocol === "https:";
        const request = (secure ? https : http).request(url, {
            method: "GET", headers: HEADERS, agent: false, signal, lookup: guardedLookup(options.policy, options.resolver),
        }, resolve);
        request.on("socket", (socket) => {
            const timer = setTimeout(() => request.destroy(new SourceFetchError("timeout", "The site took too long to connect.")), options.connectMs);
            socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(timer));
            socket.once("close", () => clearTimeout(timer));
        });
        request.on("error", reject);
        request.end();
    });
}

function decoder(response: IncomingMessage): Readable {
    const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    if (encoding === "identity" || encoding === "") return response;
    const stream = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
        : encoding === "deflate" ? zlib.createInflate()
        : encoding === "br" ? zlib.createBrotliDecompress() : null;
    if (!stream) { response.destroy(); throw new SourceFetchError("type", `The site used an unsupported encoding (${encoding}).`); }
    response.on("error", (error) => stream.destroy(error));
    return response.pipe(stream);
}

function readCapped(response: IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit && !response.headers["content-encoding"]) {
        response.destroy();
        return Promise.reject(new SourceFetchError("size", `The source is larger than ${Math.round(limit / MB)} MB.`));
    }
    return new Promise((resolve, reject) => {
        let stream: Readable;
        try { stream = decoder(response); } catch (error) { reject(error); return; }
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > limit) {
                const error = new SourceFetchError("size", `The source is larger than ${Math.round(limit / MB)} MB.`);
                stream.destroy(error); response.destroy();
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", reject);
        response.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks, total)));
    });
}

function sniff(body: Buffer): SourceKind | null {
    if (body.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
    const head = body.subarray(0, 1024);
    if (head.includes(0)) return null;
    return /^\s*</.test(head.toString("latin1")) ? "html" : "plain";
}

export async function fetchSource(raw: string, options: FetchOptions = {}): Promise<FetchedSource> {
    const policy = options.policy ?? isPublicAddress, ports = options.ports ?? new Set([80, 443]);
    const limits = { ...LIMITS, ...options.limits };
    const settings = { policy, resolver: options.resolver ?? systemResolver, connectMs: options.connectMs ?? 5_000 };
    const signal = AbortSignal.timeout(options.totalMs ?? 20_000);
    const maxRedirects = options.maxRedirects ?? 5;
    let url = checkSourceUrl(raw, policy, ports);
    try {
        for (let hop = 0; ; hop++) {
            const response = await open(url, settings, signal);
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                const location = response.headers.location;
                response.resume();
                if (!location) throw new SourceFetchError("http", `The site sent a redirect without a destination (HTTP ${status}).`, status);
                if (hop >= maxRedirects) throw new SourceFetchError("redirects", "The link redirected too many times.");
                url = checkSourceUrl(new URL(location, url).href, policy, ports);
                continue;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                throw new SourceFetchError("http", `The site answered HTTP ${status}.`, status);
            }
            const [media = "", ...params] = String(response.headers["content-type"] ?? "").split(";");
            const mediaType = media.trim().toLowerCase();
            const charset = params.map((param) => param.trim().match(/^charset\s*=\s*"?([^";]+)"?$/i)?.[1]).find(Boolean);
            const declared: SourceKind | undefined = TYPES[mediaType];
            if (mediaType && !declared) {
                response.destroy();
                throw new SourceFetchError("type", `Capture reads web pages, text and PDFs, not ${mediaType}.`);
            }
            const body = await readCapped(response, declared ? limits[declared] : Math.max(...Object.values(limits)));
            const kind = declared ?? sniff(body);
            if (!kind) throw new SourceFetchError("type", "The site sent a file Capture cannot read.");
            if (body.length > limits[kind]) throw new SourceFetchError("size", `The source is larger than ${Math.round(limits[kind] / MB)} MB.`);
            return { finalUrl: url.href, status, kind, contentType: mediaType || kind, charset, body };
        }
    } catch (error) {
        throw failure(error, signal);
    }
}
