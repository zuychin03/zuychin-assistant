import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { sameOrigin } from "@/lib/auth/config";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { patchProfilePreferences, ProfilePreferencesError } from "@/lib/profile-preferences";
import { cleanMaskNames, MASK_NAME_CHARS, MASK_NAMES_MAX, readMaskPrefs } from "@/lib/ai/privacy/mask";
import { rememberMaskPrefs } from "@/lib/ai/privacy/policy";

// V8 F13: the masking switch and the names to mask, kept in profile preferences (no SQL).

const respond = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const limits = { names: MASK_NAMES_MAX, nameChars: MASK_NAME_CHARS };

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const profile = await resolveOwnerProfile();
        if (!profile) return respond({ error: "Your profile was not found." }, 404);
        return respond({ ...readMaskPrefs(profile.preferences), limits });
    } catch {
        return respond({ error: "Could not load the privacy settings. Please retry." }, 503);
    }
}

export async function PUT(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    if (!sameOrigin(req)) return respond({ error: "Open the dashboard on this site before saving." }, 403);
    let body: unknown;
    try { body = await readJsonCapped(req); } catch (error) {
        return bodyFailure(error) ?? respond({ error: "Send enabled and names." }, 400);
    }
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const names = input.names;
    if (typeof input.enabled !== "boolean" || !Array.isArray(names) || names.length > MASK_NAMES_MAX * 2
        || names.some((name) => typeof name !== "string" || name.length > 200) || Object.keys(input).some((key) => key !== "enabled" && key !== "names")) {
        return respond({ error: `Send enabled as true or false and names as a list of up to ${MASK_NAMES_MAX} names.` }, 400);
    }
    const masking = { enabled: input.enabled, names: cleanMaskNames(names) };
    try {
        const profile = await resolveOwnerProfile();
        if (!profile) return respond({ error: "Your profile was not found." }, 404);
        const saved = readMaskPrefs(await patchProfilePreferences(profile.id, { masking }));
        rememberMaskPrefs(saved);
        return respond({ ...saved, limits });
    } catch (error) {
        if (error instanceof ProfilePreferencesError && error.reason === "conflict") return respond({ error: "Your preferences changed while saving. Please retry." }, 409);
        if (error instanceof ProfilePreferencesError && error.reason === "missing") return respond({ error: "Your profile was not found. Reload before trying again." }, 404);
        return respond({ error: "Could not save the privacy settings. Please retry." }, 503);
    }
}
