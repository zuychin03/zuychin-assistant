import { NextRequest, NextResponse } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase";
import { createScheduledTask, updateScheduledTask, deleteScheduledTask } from "@/lib/tasks/store";
import { ownedTask, taskReport } from "@/lib/tasks/run-store";
import { taskId, taskInput, taskOwner, taskFailure, TaskInputError } from "@/lib/tasks/http";

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try { return NextResponse.json(await taskReport(await taskOwner()), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return taskFailure(error); }
}
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const userId = await taskOwner();
        const input = taskInput(await req.json());
        if (input.conversationId) {
            const { data, error } = await supabaseAdmin.from("conversations").select("id").eq("id", input.conversationId).eq("user_profile_id", userId).maybeSingle();
            if (error || !data) throw new TaskInputError("Choose a conversation belonging to your profile.");
        }
        const task = await createScheduledTask({ ...input, cron: input.cron ?? undefined, runAt: input.runAt ?? undefined, userProfileId: userId });
        return NextResponse.json({ task: { ...task, enabled: input.enabled } }, { status: 201 });
    } catch (error) { return taskFailure(error); }
}
export async function PATCH(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const body = await req.json();
        const id = taskId(body.id);
        const task = await ownedTask(id, await taskOwner());
        if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
        if (body.conversationId !== undefined) throw new TaskInputError("Conversation destination cannot be changed here. Create a new task instead.");
        const updated = await updateScheduledTask(id, taskInput(body, task));
        if (!updated) throw new Error("Task changes could not be saved.");
        return NextResponse.json({ task: updated });
    } catch (error) { return taskFailure(error); }
}
export async function DELETE(req: NextRequest) {
    const denied = await requireChatAuth(req); if (denied) return denied;
    try {
        const id = taskId(req.nextUrl.searchParams.get("id"));
        const owner = await taskOwner();
        if (!await ownedTask(id, owner)) return NextResponse.json({ error: "Task not found." }, { status: 404 });
        if (!await deleteScheduledTask(id)) return NextResponse.json({ error: "The task is running, an action is executing, or storage is unavailable. Nothing was deleted." }, { status: 409 });
        return NextResponse.json({ success: true });
    } catch (error) { return taskFailure(error); }
}
