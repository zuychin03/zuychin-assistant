import { NextRequest, NextResponse } from "next/server";
import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { isPurposeTag } from "@/lib/ai/models/tags";
import { autoFillSeats, seatOptions } from "@/lib/council/online/service";
import { MAX_SEATS } from "@/lib/council/online/seats";
import { ONLINE_DEFAULT_ROUNDS, ONLINE_MAX_ROUNDS, ONLINE_MIN_ROUNDS } from "@/lib/council/online/limits";

export async function GET(req: NextRequest) {
    try {
        const raw = req.nextUrl.searchParams.get("purpose") ?? "reasoning";
        const purpose = isPurposeTag(raw) ? raw : "reasoning";
        const freeOnly = effectiveFreeOnly(await getDefaultProfile());
        return NextResponse.json({
            freeOnly,
            purpose,
            rounds: { default: ONLINE_DEFAULT_ROUNDS, min: ONLINE_MIN_ROUNDS, max: ONLINE_MAX_ROUNDS },
            models: seatOptions(freeOnly),
            suggestion: autoFillSeats(MAX_SEATS, purpose),
        }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[Council API] online options failed:", error);
        return NextResponse.json({ error: "Could not list the models." }, { status: 500 });
    }
}
