const SURFACES = new Set(["/", "/knowledge", "/graph"]);
const LOCATION_KEY = "zuychin:document-location:";

export function safeReturnTo(value: string | null | undefined): string | null {
    if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return null;
    try {
        const url = new URL(value, "https://local.invalid");
        if (url.origin !== "https://local.invalid" || !SURFACES.has(url.pathname)) return null;
        url.searchParams.delete("returnTo");
        return url.pathname + url.search + url.hash;
    } catch { return null; }
}

export function withReturnTo(destination: string, currentUrl: string): string {
    const target = new URL(safeReturnTo(destination) ?? "/", "https://local.invalid");
    const returnTo = safeReturnTo(currentUrl);
    if (returnTo) target.searchParams.set("returnTo", returnTo);
    return target.pathname + target.search + target.hash;
}

export function rememberDocumentLocation(value: string): void {
    const safe = safeReturnTo(value);
    if (!safe || typeof window === "undefined") return;
    try {
        window.sessionStorage.setItem(LOCATION_KEY + new URL(safe, window.location.origin).pathname, safe);
        const back = safeReturnTo(new URL(value, window.location.origin).searchParams.get("returnTo"));
        if (back && new URL(back, window.location.origin).pathname === "/") window.sessionStorage.setItem(LOCATION_KEY + "/", back);
    } catch { /* Storage can be disabled. */ }
}

export function documentDestination(surface: "/" | "/knowledge" | "/graph"): string {
    if (typeof window === "undefined") return surface;
    try {
        const saved = safeReturnTo(window.sessionStorage.getItem(LOCATION_KEY + surface));
        return saved && new URL(saved, window.location.origin).pathname === surface ? saved : surface;
    } catch { return surface; }
}

export function libraryDocumentDestination(path: string, previous: string, section?: string): string {
    const safe = safeReturnTo(previous);
    const url = new URL(safe?.startsWith("/knowledge") ? safe : "/knowledge", "https://local.invalid");
    if (url.searchParams.get("path") !== path) {
        url.searchParams.delete("document");
        url.searchParams.set("status", "all");
    }
    url.searchParams.set("path", path);
    url.searchParams.delete("tab");
    url.searchParams.delete("view");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    return url.pathname + url.search;
}

export function readDocumentPosition(key: string): number {
    try { return Math.max(0, Number(window.sessionStorage.getItem(`zuychin:document-scroll:${key}`)) || 0); }
    catch { return 0; }
}

export function rememberDocumentPosition(key: string, position: number): void {
    try { window.sessionStorage.setItem(`zuychin:document-scroll:${key}`, String(Math.max(0, position))); }
    catch { /* Reading still works without storage. */ }
}
