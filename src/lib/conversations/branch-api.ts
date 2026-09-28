import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { BranchError } from "./branches";

export async function branchUserId(): Promise<string> {
    const { data, error } = await supabaseAdmin.from("user_profiles").select("id").limit(1).maybeSingle();
    if (error) throw new BranchError("Your profile could not be loaded.", 503);
    if (!data) throw new BranchError("Your profile was not found.", 404);
    return data.id;
}
export function branchResponse(value: unknown, status = 200) {
    return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function branchFailure(error: unknown) {
    if (error instanceof BranchError) return branchResponse({ error: error.message }, error.status);
    if (error instanceof Error && error.name === "AbortError") return branchResponse({ error: "Request cancelled." }, 499);
    return branchResponse({ error: "The conversation request could not be completed. Please retry." }, 503);
}
