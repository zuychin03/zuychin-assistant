import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { getProvider, isProviderAvailable } from "@/lib/ai/providers";
import { refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { assessDataRoute } from "@/lib/ai/data-policy";
import { knownVoices } from "@/lib/voice/api-speech";
import { TRANSCRIPTION_ORDERS, readVoiceChoices, saveVoiceChoices, type SpeechBackupChoice, type TranscriptionChoice } from "@/lib/ai/voice-choices";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Approved, passing and not missing: the same bar as any automatic route. */
function usable(providerId: string, modelId: string, kind: "speech" | "transcription") {
    const provider = getProvider(providerId);
    if (!provider || !isProviderAvailable(provider)) return null;
    const model = (kind === "speech" ? provider.speechModels : provider.transcriptionModels)?.find((entry) => entry.id === modelId);
    if (!model || !model.catalogue.approved || model.catalogue.status) return null;
    return assessDataRoute({ providerId, modelId, purpose: kind, classes: ["personal"] }).allowed === false ? null : { provider, model };
}

function checkBackup(raw: unknown): Checked<SpeechBackupChoice | null> {
    if (raw === null) return { ok: true, value: null };
    const value = (raw ?? {}) as Record<string, unknown>;
    const providerId = text(value.providerId), modelId = text(value.modelId), voice = text(value.voice);
    if (!providerId || !modelId) return { ok: false, error: "Send the backup voice as providerId, modelId and voice, or null to use the default." };
    const found = usable(providerId, modelId, "speech");
    if (!found) return { ok: false, error: "Only an approved speech model whose last test passed can be the backup voice." };
    const voices = knownVoices(found.provider, modelId, "voices" in found.model ? found.model.voices : []);
    if (voices.length && (!voice || !voices.includes(voice))) return { ok: false, error: `Pick one of this model's voices: ${voices.slice(0, 10).join(", ")}${voices.length > 10 ? ", ..." : ""}.` };
    return { ok: true, value: { providerId, modelId, voice: voices.length ? voice : null } };
}

function checkTranscription(raw: unknown): Checked<TranscriptionChoice> {
    const value = (raw ?? {}) as Record<string, unknown>;
    const order = TRANSCRIPTION_ORDERS.find((entry) => entry === value.order);
    if (!order) return { ok: false, error: `The order must be one of ${TRANSCRIPTION_ORDERS.join(", ")}.` };
    const providerId = text(value.providerId), modelId = text(value.modelId);
    // On-box only is always allowed; a remembered model needs no check because nothing calls it.
    if (order === "local") return { ok: true, value: providerId && modelId ? { order, providerId, modelId } : { order, providerId: null, modelId: null } };
    if (!providerId || !modelId) return { ok: false, error: "Choose a transcription model before an order that uses it." };
    if (!usable(providerId, modelId, "transcription")) return { ok: false, error: "Only an approved transcription model whose last test passed can be used." };
    return { ok: true, value: { order, providerId, modelId } };
}

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    return NextResponse.json(await readVoiceChoices(true), { headers: { "Cache-Control": "no-store" } });
}

/** Owner-wide: the backup voice and the transcription order. Either field may be left out. */
export async function PUT(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let input: unknown = null;
    try { input = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const body = (input ?? {}) as { backup?: unknown; transcription?: unknown };
    if (!("backup" in body) && !("transcription" in body)) return NextResponse.json({ error: "Send backup, transcription or both." }, { status: 400 });
    await refreshCatalogueSnapshot();
    const backup = "backup" in body ? checkBackup(body.backup) : null;
    if (backup && !backup.ok) return NextResponse.json({ error: backup.error }, { status: 400 });
    const transcription = "transcription" in body ? checkTranscription(body.transcription) : null;
    if (transcription && !transcription.ok) return NextResponse.json({ error: transcription.error }, { status: 400 });
    try {
        const saved = await saveVoiceChoices({ ...(backup?.ok ? { speech: backup.value } : {}), ...(transcription?.ok ? { transcription: transcription.value } : {}) });
        return NextResponse.json(saved);
    } catch (error) {
        console.error("[VoiceChoices] Save failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "The choice could not be saved. Please retry." }, { status: 503 });
    }
}
