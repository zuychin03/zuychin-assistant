import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { patchProfilePreferences, ProfilePreferencesError } from "@/lib/profile-preferences";

const respond = (body: Record<string, unknown>, status = 200) =>
    NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readProfile() {
    try {
        return { data: await resolveOwnerProfile(), error: null };
    } catch (error) {
        return { data: null, error };
    }
}

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    const { data, error } = await readProfile();
    if (error) return respond({ error: "Could not load chat preferences. Please retry." }, 503);
    if (!data) return respond({ error: "Your profile was not found." }, 404);
    return respond({ freeOnly: data.preferences?.freeOnly === true });
}

export async function PATCH(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let body: unknown;
    try { body = await req.json(); } catch {
        return respond({ error: "Provide a JSON object with a freeOnly boolean." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)
        || typeof (body as Record<string, unknown>).freeOnly !== "boolean"
        || Object.keys(body).some((key) => key !== "freeOnly")) {
        return respond({ error: "Only the freeOnly boolean can be changed here." }, 400);
    }
    const { freeOnly } = body as { freeOnly: boolean };
    const { data: profile, error: readError } = await readProfile();
    if (readError) return respond({ error: "Could not load chat preferences. Please retry." }, 503);
    if (!profile) return respond({ error: "Your profile was not found." }, 404);
    try {
        const saved = await patchProfilePreferences(profile.id, { freeOnly });
        return respond({ freeOnly: saved.freeOnly === true });
    } catch (error) {
        if (error instanceof ProfilePreferencesError && error.reason === "missing") {
            return respond({ error: "Your profile was not found. Reload before trying again." }, 404);
        }
        if (error instanceof ProfilePreferencesError && error.reason === "conflict") {
            return respond({ error: "Your preferences changed during saving. Please retry." }, 409);
        }
        return respond({ error: "Could not save chat preferences. Please retry." }, 503);
    }
}
