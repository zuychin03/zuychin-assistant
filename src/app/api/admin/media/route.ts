import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { catalogueSnapshot, refreshCatalogueSnapshot, rowKind } from "@/lib/ai/catalogue/snapshot";
import { isMediaKind, type MediaKind } from "@/lib/ai/catalogue/sources";
import { mediaRowUsable, routableNow } from "@/lib/ai/media/resolve";
import { parseMediaChoice, readMediaChoices, saveMediaChoice } from "@/lib/ai/media/choices";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    return NextResponse.json(await readMediaChoices(true), { headers: { "Cache-Control": "no-store" } });
}

/** Owner-wide model choice for one V8 kind: `{ kind, providerId, modelId }`, or `{ kind, providerId: null }` for the automatic pick. */
export async function PUT(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let input: unknown = null;
    try { input = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const body = (input ?? {}) as { kind?: unknown; providerId?: unknown };
    if (typeof body.kind !== "string" || !isMediaKind(body.kind)) return NextResponse.json({ error: "Send kind as rerank, parse, image, decision, live or translate." }, { status: 400 });
    const kind: MediaKind = body.kind;
    let choice = null;
    if (body.providerId !== null) {
        choice = parseMediaChoice(input);
        if (!choice) return NextResponse.json({ error: "Send providerId and modelId, or providerId null to use the automatic pick." }, { status: 400 });
        await refreshCatalogueSnapshot();
        const row = catalogueSnapshot().typedRows.find((entry) => entry.providerId === choice!.providerId && entry.modelId === choice!.modelId);
        if (!row || rowKind(row) !== kind) return NextResponse.json({ error: `That is not a ${kind} model in the catalogue.` }, { status: 404 });
        if (!mediaRowUsable(row)) return NextResponse.json({ error: "Only an approved model whose last test passed can be chosen." }, { status: 400 });
        if (!routableNow(row)) return NextResponse.json({ error: "That provider has no key, or this app cannot call it yet." }, { status: 400 });
    }
    try {
        return NextResponse.json(await saveMediaChoice(kind, choice));
    } catch (error) {
        console.error("[MediaChoices] Save failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The choice could not be saved. Please retry." }, { status: 503 });
    }
}
