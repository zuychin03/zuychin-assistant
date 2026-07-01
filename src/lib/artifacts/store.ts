import { supabaseAdmin as supabase } from "@/lib/supabase";
import type { ArtifactDescriptor, ArtifactKind } from "@/lib/types";

export interface StoredArtifact extends ArtifactDescriptor {
    body: Buffer | string;
}

export async function saveArtifact(params: {
    kind: ArtifactKind;
    filename: string;
    mimeType: string;
    body: Buffer | string;
    conversationId?: string;
    userProfileId?: string;
}): Promise<ArtifactDescriptor> {
    const isText = typeof params.body === "string";
    const size = isText
        ? Buffer.byteLength(params.body as string, "utf-8")
        : (params.body as Buffer).length;

    const { data, error } = await supabase
        .from("artifacts")
        .insert({
            kind: params.kind,
            filename: params.filename,
            mime_type: params.mimeType,
            content_text: isText ? (params.body as string) : null,
            content_base64: isText ? null : (params.body as Buffer).toString("base64"),
            size,
            conversation_id: params.conversationId ?? null,
            user_profile_id: params.userProfileId ?? null,
        })
        .select("id")
        .single();

    if (error) {
        console.error("[Artifacts] Failed to save:", error.message);
        throw new Error("Failed to save artifact.");
    }

    return { id: data.id, name: params.filename, mime: params.mimeType, kind: params.kind, size };
}

export async function getArtifact(id: string): Promise<StoredArtifact | null> {
    const { data, error } = await supabase
        .from("artifacts")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) {
        if (error) console.error("[Artifacts] Failed to fetch:", error.message);
        return null;
    }

    const body: Buffer | string = data.content_text !== null && data.content_text !== undefined
        ? data.content_text
        : Buffer.from(data.content_base64 ?? "", "base64");

    return {
        id: data.id,
        name: data.filename,
        mime: data.mime_type,
        kind: data.kind,
        size: data.size,
        body,
    };
}

export async function linkArtifactsToMessage(artifactIds: string[], messageId: string): Promise<void> {
    if (artifactIds.length === 0) return;
    const { error } = await supabase
        .from("artifacts")
        .update({ message_id: messageId })
        .in("id", artifactIds);
    if (error) console.error("[Artifacts] Failed to link to message:", error.message);
}
