import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
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

        // Agent-mode tasks run for minutes — far past the cron client's
        // timeout (cron-job.org caps at 30s) — so respond once the claim is
        // recorded and run after. Task output reaches its channel directly.
        after(() => runClaimed(tasks));
        return NextResponse.json({ accepted: true, claimed: tasks.length }, { status: 202 });
    } catch (error) {
        console.error("[Tasks] Dispatcher error:", error);
        return NextResponse.json({ error: "Scheduled-task dispatch failed." }, { status: 500 });
    }
}

async function runClaimed(tasks: Awaited<ReturnType<typeof claimDueTasks>>) {
    try {
        // Sequential on purpose: bounds concurrent LLM load inside one invocation.
        const results: TaskRunResult[] = [];
        for (const task of tasks) {
            console.log(`[Tasks] Running "${task.title}" (${task.channel}${task.agentMode ? ", agent" : ""})`);
            results.push(await runScheduledTask(task));
        }
        console.log(`[Tasks] Ran ${results.length}: ${results.map((r) => `${r.title}=${r.status}`).join(", ")}`);
    } catch (error) {
        console.error("[Tasks] Dispatcher error:", error);
    }
}
