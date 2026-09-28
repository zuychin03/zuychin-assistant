import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_COOKIE, authEnabled } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";
import { branchUserId } from "@/lib/conversations/branch-api";
import { validConversationId } from "@/lib/conversations/branches";
import { deleteEntrySchema, ResearchError } from "./contracts";
import type { createResearchService } from "./service";

type Service = ReturnType<typeof createResearchService>;
export function researchResponse(data: unknown, status = 200) {
    return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}
export async function requireResearchOwner(req: NextRequest) {
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return researchResponse({ error: "Use the research workbench from this site's owner session." }, 403);
    if (!authEnabled() || await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return null;
    return researchResponse({ error: "Sign in to your owner session to use the research workbench." }, 401);
}
function failure(error: unknown) {
    if (error instanceof ResearchError) return researchResponse({ error: error.message, ...(error.current ? { current: error.current } : {}) }, error.status);
    if (error instanceof z.ZodError) return researchResponse({ error: "Check the research form fields and try again." }, 400);
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400,404,409,413].includes(error.status)) {
        return researchResponse({ error: error instanceof Error ? error.message : "The source passage could not be validated." }, error.status);
    }
    return researchResponse({ error: "Research is temporarily unavailable. Your draft has not been discarded." }, 503);
}
function uuid(value: string | null, name: string): string {
    if (!validConversationId(value)) throw new ResearchError(`A valid ${name} is required.`);
    return value;
}
export function createResearchHandlers(service: Service, dependencies: { auth?: typeof requireResearchOwner; userId?: typeof branchUserId } = {}) {
    const authenticate = dependencies.auth ?? requireResearchOwner, identify = dependencies.userId ?? branchUserId;
    const run = (operation: (req: NextRequest, userId: string) => Promise<unknown>) => async (req: NextRequest) => {
        const denied = await authenticate(req); if (denied) return denied;
        try {
            const profileId = await identify(), expected = req.headers.get("X-Research-Profile");
            if (expected && expected !== profileId) return researchResponse({ error: "Your account changed. Reload research before continuing.", profileChanged: true }, 409);
            const response = researchResponse(await operation(req, profileId));
            response.headers.set("X-Research-Profile", profileId);
            return response;
        } catch (error) { return failure(error); }
    };
    const json = async (req: NextRequest) => { try { return await req.json(); } catch { throw new ResearchError("Provide a valid JSON research request."); } };
    return {
        GET: run(async (req, userId) => {
            const id = req.nextUrl.searchParams.get("questionId");
            return id ? service.workspace(uuid(id, "questionId"), userId) : service.list(userId);
        }),
        POST: run(async (req, userId) => ({ question: await service.saveQuestion(await json(req), userId) })),
        sourceGET: run(async (req, userId) => service.snapshot(uuid(req.nextUrl.searchParams.get("sourceId"), "sourceId"), uuid(req.nextUrl.searchParams.get("questionId"), "questionId"), userId)),
        sourcePOST: run(async (req, userId) => ({ source: await service.addSource(await json(req), userId) })),
        sourcePATCH: run(async (req, userId) => ({ source: await service.editSource(await json(req), userId) })),
        entryPOST: run(async (req, userId) => ({ entry: await service.saveEntry(await json(req), userId) })),
        entryDELETE: run(async (req, userId) => service.deleteEntry(deleteEntrySchema.parse(await json(req)), userId)),
    };
}
