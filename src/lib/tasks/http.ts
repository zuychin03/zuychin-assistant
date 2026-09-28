import { NextRequest, NextResponse } from "next/server";
import { getDefaultProfile } from "@/lib/db";
import { AUTH_COOKIE } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";
import { APP_TIMEZONE } from "@/lib/datetime";
import { validateCron } from "@/lib/tasks/schedule";
import type { ScheduledTask, TaskChannel } from "@/lib/tasks/store";

export class TaskInputError extends Error {}
export function taskId(value: unknown): string {
    if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new TaskInputError("A valid ID is required.");
    return value;
}
export async function taskOwner(): Promise<string> {
    const profile = await getDefaultProfile();
    if (!profile?.id) throw new Error("Your profile is unavailable. Try again.");
    return profile.id;
}
export async function requireApprovalOwner(req: NextRequest) {
    if (!await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.json({ error: "Sign in as the owner to decide actions." }, { status: 401 });
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "Approval must come from this app." }, { status: 403 });
    return null;
}
type Edit = Pick<ScheduledTask, "title" | "instruction" | "scheduleType" | "cron" | "runAt" | "timezone" | "channel" | "agentMode" | "enabled">;
export function taskInput(value: unknown, existing?: ScheduledTask): Edit & { conversationId?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskInputError("Provide task fields.");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["id","title","instruction","scheduleType","cron","runAt","timezone","channel","agentMode","enabled","conversationId"].includes(key))) throw new TaskInputError("Unsupported task field.");
    const merged = { ...existing, ...body };
    for (const [name, limit] of [["title", 160], ["instruction", 20000]] as const) {
        if (typeof merged[name] !== "string" || !(merged[name] as string).trim() || (merged[name] as string).length > limit) throw new TaskInputError(`${name} must contain 1 to ${limit} characters.`);
    }
    if (merged.scheduleType !== "once" && merged.scheduleType !== "recurring") throw new TaskInputError("Choose a one-off or recurring schedule.");
    const timezone = merged.timezone ?? APP_TIMEZONE;
    if (typeof timezone !== "string") throw new TaskInputError("Invalid timezone.");
    try { new Intl.DateTimeFormat("en-AU", { timeZone: timezone }); } catch { throw new TaskInputError("Choose a valid IANA timezone."); }
    if (merged.channel !== undefined && !["web","telegram","discord"].includes(String(merged.channel))) throw new TaskInputError("Choose a valid delivery channel.");
    for (const field of ["enabled","agentMode"] as const) if (merged[field] !== undefined && typeof merged[field] !== "boolean") throw new TaskInputError(`${field} must be a boolean.`);
    const cron = merged.scheduleType === "recurring" ? merged.cron : null;
    const runAt = merged.scheduleType === "once" ? merged.runAt : null;
    if (merged.scheduleType === "recurring") {
        if (typeof cron !== "string" || validateCron(cron, timezone)) throw new TaskInputError("Provide a valid five-field cron schedule.");
    } else if (typeof runAt !== "string" || !Number.isFinite(Date.parse(runAt))) throw new TaskInputError("Provide a valid run date and time.");
    else if ((!existing || existing.scheduleType !== "once" || Date.parse(runAt) !== Date.parse(existing.runAt ?? "") || (body.enabled === true && !existing.enabled)) && Date.parse(runAt) <= Date.now()) throw new TaskInputError("The next run must be in the future.");
    if (body.conversationId !== undefined && body.conversationId !== null && body.conversationId !== "") taskId(body.conversationId);
    return { title: (merged.title as string).trim(), instruction: (merged.instruction as string).trim(),
        scheduleType: merged.scheduleType, cron: cron as string | null, runAt: runAt as string | null, timezone,
        channel: (merged.channel ?? "web") as TaskChannel, agentMode: merged.agentMode === true, enabled: merged.enabled !== false,
        ...(typeof body.conversationId === "string" && body.conversationId ? { conversationId: body.conversationId } : {}) };
}
export function taskFailure(error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Task request failed." }, { status: error instanceof TaskInputError || error instanceof SyntaxError ? 400 : 503 });
}
