import { NextRequest, NextResponse } from "next/server";
import { claimDueTasks } from "@/lib/tasks/store";
import { runScheduledTask, type TaskRunResult } from "@/lib/tasks/runner";

export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const tasks = await claimDueTasks(3);
        if (tasks.length === 0) {
            return NextResponse.json({ message: "No tasks due.", ran: 0 });
        }

        // Sequential on purpose: bounds concurrent LLM load inside one invocation.
        const results: TaskRunResult[] = [];
        for (const task of tasks) {
            console.log(`[Tasks] Running "${task.title}" (${task.channel}${task.agentMode ? ", agent" : ""})`);
            results.push(await runScheduledTask(task));
        }

        return NextResponse.json({ ran: results.length, results });
    } catch (error) {
        console.error("[Tasks] Dispatcher error:", error);
        return NextResponse.json({ error: "Scheduled-task dispatch failed." }, { status: 500 });
    }
}
