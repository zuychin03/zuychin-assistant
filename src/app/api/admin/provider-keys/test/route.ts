import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { PROVIDERS, getProviderApiKey } from "@/lib/ai/providers";
import { checkProviderKey } from "@/lib/ai/provider-keys/check";

// Checks the key in use (saved or env) with one cheap request. Needs no password: it changes nothing.
export async function POST(req: NextRequest) {
    const denied = await requireSession(req);
    if (denied) return denied;
    const input: unknown = await req.json().catch(() => null);
    const providerId = (input as { providerId?: unknown } | null)?.providerId;
    const provider = PROVIDERS.find((entry) => entry.id === providerId);
    if (!provider) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
    const apiKey = getProviderApiKey(provider);
    if (!apiKey) return NextResponse.json({ error: `${provider.label} has no key to test.` }, { status: 409 });
    return NextResponse.json(await checkProviderKey(provider, apiKey), { headers: { "Cache-Control": "no-store" } });
}
