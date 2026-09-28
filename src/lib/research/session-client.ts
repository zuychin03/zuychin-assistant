export class ResearchApiFailure extends Error {
    constructor(message: string, readonly current?: Record<string, unknown>) { super(message); }
}
export function createResearchSessionClient(clear: () => void, transport: typeof fetch = fetch) {
    let generation = 0, profileId: string | null = null;
    const pending = new Set<AbortController>();
    function cancel() {
        generation++; profileId = null;
        for (const controller of pending) controller.abort();
        pending.clear();
    }
    function invalidate() { cancel(); clear(); }
    return {
        invalidate, cancel,
        async request<T>(url: string, body?: unknown, method = "GET", signal?: AbortSignal): Promise<T> {
            const current = generation, controller = new AbortController(); pending.add(controller);
            const aborted = () => new DOMException("The research session changed.", "AbortError");
            try {
                const response = await transport(url, { method, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
                    cache: "no-store", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(profileId ? { "X-Research-Profile": profileId } : {}) },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
                if (current !== generation || controller.signal.aborted) throw aborted();
                if (response.status === 401 || response.status === 403 || (response.redirected && new URL(response.url).pathname === "/login")) {
                    invalidate(); throw aborted();
                }
                const data = await response.json();
                if (current !== generation || controller.signal.aborted) throw aborted();
                const returnedProfile = response.headers.get("X-Research-Profile");
                if (data.profileChanged || (profileId && returnedProfile && profileId !== returnedProfile)) { invalidate(); throw aborted(); }
                if (!response.ok) throw new ResearchApiFailure(data.error ?? "Research request failed.", data.current);
                if (!returnedProfile) throw new ResearchApiFailure("Research identity could not be confirmed. Reload the page.");
                profileId = returnedProfile;
                return data;
            } finally { pending.delete(controller); }
        },
    };
}
