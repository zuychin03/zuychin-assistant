import { NextRequest, NextResponse, after } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { checkProviderKey } from "@/lib/ai/provider-keys/check";
import { readMasterKeys } from "@/lib/ai/provider-keys/master";
import { refreshProviderKeys } from "@/lib/ai/provider-keys/snapshot";
import { liveKeyStore } from "@/lib/ai/provider-keys/store";
import { clearProviderKey, confirmPassword, providerKeysView, saveProviderKey, type CatalogueCheckStart, type KeyAdminDeps } from "@/lib/ai/provider-keys/admin";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

// Keys and their last characters are owner data: never cache a response.
const NO_STORE = { "Cache-Control": "no-store" };

function deps(): KeyAdminDeps {
    return {
        store: liveKeyStore,
        masters: () => readMasterKeys(),
        check: (provider, apiKey) => checkProviderKey(provider, apiKey),
        notify: async (text) => {
            const { notify } = await import("@/lib/messaging/router");
            await notify("provider_key", text);
        },
        startCatalogueCheck: async (): Promise<CatalogueCheckStart> => {
            const { executeDiscovery, liveDiscoveryDeps } = await import("@/lib/ai/catalogue/run");
            const discovery = await liveDiscoveryDeps();
            const started = await discovery.startRun("manual");
            if (!started.ok) return started.reason === "busy" ? "busy" : "unavailable";
            after(async () => { await executeDiscovery(started.runId, "manual", discovery); });
            return "started";
        },
        now: () => new Date(),
    };
}

async function body(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
    let parsed: unknown = null;
    try { parsed = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export async function GET(req: NextRequest) {
    const denied = await requireSession(req);
    if (denied) return denied;
    await refreshProviderKeys();
    return NextResponse.json(providerKeysView(), { headers: NO_STORE });
}

export async function PUT(req: NextRequest) {
    const denied = await requireSession(req);
    if (denied) return denied;
    const input = await body(req);
    if (input instanceof NextResponse) return input;
    const refused = confirmPassword(req.headers, input.password);
    if (refused) return NextResponse.json(refused.body, { status: refused.status, headers: NO_STORE });
    await refreshProviderKeys();
    const result = await saveProviderKey({ providerId: input.providerId, apiKey: input.apiKey }, deps());
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}

export async function DELETE(req: NextRequest) {
    const denied = await requireSession(req);
    if (denied) return denied;
    const input = await body(req);
    if (input instanceof NextResponse) return input;
    const refused = confirmPassword(req.headers, input.password);
    if (refused) return NextResponse.json(refused.body, { status: refused.status, headers: NO_STORE });
    await refreshProviderKeys();
    const result = await clearProviderKey({ providerId: input.providerId }, deps());
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
