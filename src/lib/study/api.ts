import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_COOKIE, authEnabled } from "../auth/config";
import { verifySessionValue } from "../auth/session";
import { StudyError } from "./contracts";
import type { createStudyService } from "./service";

const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
export async function studyAuth(req: NextRequest) {
    if (authEnabled() && !await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return respond({ error: "Sign in with your owner account to use Active study." }, 401);
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && origin && origin !== req.nextUrl.origin) return respond({ error: "Study changes must come from this app." }, 403);
    return null;
}
export function createStudyHandlers(service: ReturnType<typeof createStudyService>, identify: () => Promise<string>, authenticate = studyAuth) {
    const wrap = (fn: (req: NextRequest, owner: string) => Promise<unknown>) => async (req: NextRequest) => {
        const denied = await authenticate(req); if (denied) return denied;
        try { return respond(await fn(req, await identify())); } catch (error) {
            if (error instanceof z.ZodError || error instanceof SyntaxError) return respond({ error: "Check the study form fields and try again." }, 400);
            if (error instanceof StudyError) return respond({ error: error.message }, error.status);
            if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 404, 409, 413].includes(error.status)) return respond({ error: error instanceof Error ? error.message : "Source validation failed." }, error.status);
            return respond({ error: "Study is unavailable. Your work has not been discarded; please retry." }, 503);
        }
    };
    return {
        GET: wrap((req, owner) => {
            if ([...req.nextUrl.searchParams.keys()].some(key => key !== "documentId")) throw new StudyError("Unsupported study query.");
            const id = req.nextUrl.searchParams.get("documentId");
            if (id !== null && (!id || id.length > 200)) throw new StudyError("Select a valid source.");
            return id ? service.snapshot(id, owner) : service.report(owner);
        }),
        POST: wrap(async (req, owner) => {
            const value = await req.json();
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new StudyError("Provide a study action.");
            const { action, ...body } = value;
            if (action === "create") return service.create(body, owner);
            if (action === "review") return service.review(body, owner);
            if (action === "edit") return service.edit(body, owner);
            if (action === "settings") return service.settings(body, owner);
            if (action === "draft") return service.draft(body, owner);
            if (action === "feedback") return service.feedback(body, owner);
            throw new StudyError("Choose a supported study action.");
        }),
    };
}
