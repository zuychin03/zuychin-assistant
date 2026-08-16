/**
 * The address an external agent has to call, which is not the same question as
 * "what origin is the owner looking at". A claim or seat key is routinely minted
 * from localhost while the agent that will use it runs somewhere else and needs
 * a deployment that is still up later, so the briefs take the address from here
 * rather than from the window or the request.
 *
 * NEXT_PUBLIC_ so one value serves both the API routes and the panels that build
 * a brief in the browser. It is a public address, never a secret.
 */
export function publicBaseUrl(fallbackOrigin?: string): string {
    const configured = process.env.NEXT_PUBLIC_BASE_URL;
    if (configured) return configured.replace(/\/+$/, "");
    // Server-side on Vercel only; undefined in a client bundle, which is fine
    // because there the browser origin already is the deployment.
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return (fallbackOrigin ?? "").replace(/\/+$/, "");
}

export function isLoopbackUrl(url: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
