import { NextRequest, NextResponse } from "next/server";
import { authOrigin } from "@/lib/auth/config";
import { requireSession } from "@/lib/auth/guard";
import { BodyTooLargeError, readBodyCapped } from "@/lib/http/body";
import { readShareForm, stageShare } from "@/lib/capture/staged-share";

// 303 so the browser follows with a GET; behind the tunnel the origin comes from config, never the request.
const toCapture = (query: string) => NextResponse.redirect(new URL(`/capture?${query}`, authOrigin()), 303);

/** The Android share target (manifest.ts): stages what was shared and opens Capture with it. Nothing is saved until the owner does. */
export async function POST(req: NextRequest) {
    if (await requireSession(req)) return NextResponse.redirect(new URL("/login?next=%2Fcapture", authOrigin()), 303);
    let bytes: Uint8Array;
    try { bytes = await readBodyCapped(req); } catch (error) {
        if (error instanceof BodyTooLargeError) return toCapture("shareError=too-large");
        throw error;
    }
    let form: FormData;
    try { form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": req.headers.get("content-type") ?? "" } }).formData(); }
    catch { return toCapture("shareError=unreadable"); }
    const shared = await readShareForm(form);
    return toCapture(shared ? `staged=${stageShare(shared)}` : "shareError=empty");
}
