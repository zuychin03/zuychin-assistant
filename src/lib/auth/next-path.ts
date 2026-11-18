const BASE = "https://next-path.invalid";

// Where to go after sign-in. Only same-site relative paths pass; anything else goes home.
export function safeNextPath(raw: string | null | undefined): string {
    if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\x00-\x1f\x7f]/.test(raw)) return "/";
    let url: URL;
    try { url = new URL(raw, BASE); } catch { return "/"; }
    if (url.origin !== BASE || url.pathname === "/login" || url.pathname.startsWith("/login/")) return "/";
    return url.pathname + url.search + url.hash;
}

// A signed-out page visit keeps its path and query for after sign-in.
export function loginSearch(pathname: string, search: string): string {
    const target = pathname + search;
    return target === "/" ? "" : `?next=${encodeURIComponent(target)}`;
}
