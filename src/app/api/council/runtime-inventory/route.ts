import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";
import { parseRuntimeInventoryCursor, readRuntimeInventory } from "@/lib/council/runtime-inventory";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: NextRequest) {
    if (!await verifySessionValue(request.cookies.get(AUTH_COOKIE)?.value)) {
        return NextResponse.json({ error: "Owner sign-in required." }, { status: 401, headers });
    }
    let cursor: string | null;
    try {
        const query = request.nextUrl.searchParams;
        if (query.getAll("cursor").length > 1 || [...query.keys()].some(key => key !== "cursor")) throw new Error();
        cursor = parseRuntimeInventoryCursor(query.get("cursor"));
    } catch {
        return NextResponse.json({ error: "Invalid inventory query." }, { status: 400, headers });
    }
    try {
        const page = await readRuntimeInventory(cursor);
        return NextResponse.json(page, { status: page.status === "available" ? 200 : 503, headers });
    } catch {
        return NextResponse.json({ error: "Runtime inventory is unavailable." }, { status: 503, headers });
    }
}
