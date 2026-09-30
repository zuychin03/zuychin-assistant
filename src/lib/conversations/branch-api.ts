import { NextResponse } from "next/server";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { BranchError } from "./branches";

export async function branchUserId(): Promise<string> {
    const profile = await resolveOwnerProfile().catch(() => { throw new BranchError("Your profile could not be loaded.", 503); });
    if (!profile) throw new BranchError("Your profile was not found.", 404);
    return profile.id;
}
export function branchResponse(value: unknown, status = 200) {
    return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function branchFailure(error: unknown) {
    if (error instanceof BranchError) return branchResponse({ error: error.message }, error.status);
    if (error instanceof Error && error.name === "AbortError") return branchResponse({ error: "Request cancelled." }, 499);
    return branchResponse({ error: "The conversation request could not be completed. Please retry." }, 503);
}
