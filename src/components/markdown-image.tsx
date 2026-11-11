/* eslint-disable @next/next/no-img-element */
import type { ComponentPropsWithoutRef } from "react";

const BASE = "https://local.invalid";

// Replies can be steered by the email, search results or notes they quote, and
// an image the browser fetches by itself can carry data out in its URL. Only
// images this app serves load inline; any other image waits for a click.
export function inlineImageSource(src: unknown): string | null {
    if (typeof src !== "string" || !src) return null;
    try {
        const url = new URL(src, BASE);
        return url.origin === BASE ? url.pathname + url.search + url.hash : null;
    } catch {
        return null;
    }
}

export function MarkdownImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
    const inline = inlineImageSource(src);
    if (inline) return <img src={inline} alt={alt ?? ""} />;
    if (typeof src !== "string" || !src) return alt ? <span>{alt}</span> : null;
    let host = "";
    try { host = new URL(src, BASE).host; } catch { /* Shown without a host. */ }
    return <a href={src} target="_blank" rel="noreferrer">{alt || "Image"}{host ? ` (${host})` : ""}</a>;
}
