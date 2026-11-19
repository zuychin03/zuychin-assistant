import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/auth/config";
import { startOnlineCouncil } from "@/lib/council/online/service";
import type { OnlineSeatInput } from "@/lib/council/online/seats";

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function readSeats(raw: unknown): OnlineSeatInput[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.map((seat) => {
        const s = (seat && typeof seat === "object" ? seat : {}) as Record<string, unknown>;
        return {
            modelKey: typeof s.modelKey === "string" ? s.modelKey : "",
            name: typeof s.name === "string" ? s.name : undefined,
            expertise: typeof s.expertise === "string" ? s.expertise : undefined,
            source: typeof s.source === "string" && /^(picker|auto:[a-z-]+)$/.test(s.source) ? s.source : undefined,
        };
    });
}

// Returns once the seats are recorded; the debate runs in this process afterwards,
// well clear of Cloudflare's 100 s response limit.
export async function POST(req: NextRequest) {
    if (!sameOrigin(req)) return respond({ error: "Start online councils from this site." }, 403);
    try {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body) return respond({ error: "Send the council as JSON." }, 400);
        const seats = readSeats(body.seats);
        if (!seats) return respond({ error: "Send 2 to 5 seats." }, 400);
        const result = await startOnlineCouncil({
            topic: typeof body.topic === "string" ? body.topic : "",
            brief: typeof body.brief === "string" ? body.brief : "",
            seats,
            closerName: typeof body.closerName === "string" ? body.closerName : undefined,
            closerIndex: typeof body.closerIndex === "number" ? body.closerIndex : undefined,
            maxRounds: typeof body.maxRounds === "number" ? body.maxRounds : undefined,
            allowPaid: body.allowPaid === true,
        });
        if (!result.ok) return respond({ error: result.error }, result.status);
        return respond(result);
    } catch (error) {
        console.error("[Council API] online start failed:", error);
        return respond({ error: "The online council could not be started." }, 500);
    }
}
