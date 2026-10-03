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

/**
 * A link the owner opens from Telegram or Discord, which drop or strand a relative path. The
 * per-deployment VERCEL_URL is skipped: the owner signs in on the production host.
 */
export function ownerLink(path: string): string {
    const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.AUTH_ORIGIN || (production ? `https://${production}` : "");
    return base.replace(/\/+$/, "") + path;
}

export function isLoopbackUrl(url: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
