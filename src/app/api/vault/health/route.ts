import { NextResponse } from "next/server";
import { vaultHealthCheck } from "@/lib/vault/github";

export async function GET() {
    const result = await vaultHealthCheck();
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
