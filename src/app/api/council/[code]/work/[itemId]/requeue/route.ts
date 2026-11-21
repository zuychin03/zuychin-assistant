import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/auth/config";
import { getCampaignForSession, listCampaignWorkItems } from "@/lib/council/campaign";
import { requeueWorkItem, type RequeueRefusal } from "@/lib/council/owner-notes";
import { getSessionByCode } from "@/lib/council/store";

// Owner only, session-gated by proxy.ts. A blocked task goes back to its seat with
// a fresh attempt allowance; the host restarts a seat its watchdog gave up on once
// that seat's task is runnable again.

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSALS: Record<RequeueRefusal, [number, string]> = {
    unknown_item: [404, "No task with that id in this council."],
    manifest_frozen: [409, "Integration has started, so the tasks can no longer change."],
    campaign_finished: [409, "The work campaign has finished."],
    not_blocked: [409, "Only a blocked task can be requeued."],
    not_installed: [503, "Requeue needs scripts/migrations/council-owner-notes.sql applied in Supabase first."],
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string; itemId: string }> }) {
    if (!sameOrigin(req)) return respond({ error: "Requeue tasks from this site." }, 403);
    try {
        const { code, itemId } = await params;
        if (!UUID.test(itemId)) return respond({ error: REFUSALS.unknown_item[1] }, 404);
        const session = await getSessionByCode(code);
        if (!session) return respond({ error: "No council with that code." }, 404);
        const campaign = await getCampaignForSession(session.id);
        const items = campaign ? await listCampaignWorkItems(campaign.id) : [];
        if (!items.some((item) => item.id === itemId)) return respond({ error: REFUSALS.unknown_item[1] }, 404);
        const result = await requeueWorkItem(itemId);
        if (!result.ok) {
            const [status, error] = REFUSALS[result.reason];
            return respond({ error, reason: result.reason }, status);
        }
        return respond({ ok: true });
    } catch (error) {
        console.error("[Council API] requeue failed:", error);
        return respond({ error: "Could not requeue the task." }, 500);
    }
}
