import { randomUUID } from "node:crypto";
import { claimTaskRun, claimTaskDelivery, startTaskRun, finishTaskRun } from "@/lib/tasks/run-store";
import { withUnattendedRun } from "@/lib/tasks/unattended-policy";
import { ragChat } from "@/lib/ai/rag-service";
import { getArtifact } from "@/lib/artifacts/store";
import { sendTelegramMessage, sendTelegramDocument } from "@/lib/messaging/telegram-service";
import { notify } from "@/lib/messaging/router";
import type { ScheduledTask } from "@/lib/tasks/store";

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export interface TaskRunResult {
    id: string;
    title: string;
    status: "ok" | "error";
    detail: string;
}

// Scheduled chat generation must not inherit a channel's free model route.
export async function runScheduledTask(task: ScheduledTask, claimedRunId?: string): Promise<TaskRunResult> {
    let runId = claimedRunId ?? task.claimedRunId;
    const signal = AbortSignal.timeout(4 * 60_000);
    try {
        if (!task.userProfileId) throw new Error("This task has no confirmed owner. Assign ownership before running it.");
        if (!runId) {
            const claim = await claimTaskRun(task.id, randomUUID(), "manual", task.userProfileId);
            if (!claim || claim.status !== "accepted") return { id: task.id, title: task.title, status: "error", detail: "This task is already running." };
            runId = claim.run.id;
            task = claim.task;
        }
        if (!await startTaskRun(runId)) return { id: task.id, title: task.title, status: "error", detail: "This run is already started or no longer available." };
        return await withUnattendedRun({
            runId, taskId: task.id, taskTitle: task.title, instruction: task.instruction, userProfileId: task.userProfileId!,
        }, () => executeScheduledTask(task, runId!, signal));
    } catch (error) {
        const detail = error instanceof Error ? error.message : "Scheduled run unavailable.";
        if (runId) await finishTaskRun(runId, "error", detail).catch(() => {});
        return { id: task.id, title: task.title, status: "error", detail };
    }
}

async function executeScheduledTask(task: ScheduledTask, runId: string, signal: AbortSignal): Promise<TaskRunResult> {
    let deliveryStarted = false;
    try {
        const { reply, artifacts } = await ragChat({
            message: task.instruction,
            channel: task.channel,
            conversationId: task.channel === "web" ? (task.conversationId ?? undefined) : undefined,
            agent: task.agentMode,
            paidOnly: true,
            signal,
        });

        signal.throwIfAborted();
        if (!await claimTaskDelivery(runId)) throw new Error("This run is no longer current or delivery was already claimed. No delivery was started.");
        signal.throwIfAborted();
        let delivered = true;
        if (task.channel === "telegram") {
            if (!TELEGRAM_CHAT_ID) {
                delivered = false;
            } else {
                deliveryStarted = true;
                delivered = await sendTelegramMessage(TELEGRAM_CHAT_ID, `🕑 **${task.title}**\n\n${reply}`, { signal, allowFormattingFallback: false });
                for (const a of artifacts) {
                    signal.throwIfAborted();
                    if (!delivered) break;
                    const stored = await getArtifact(a.id);
                    if (!stored) { delivered = false; continue; }
                    const attachmentDelivered = await sendTelegramDocument(TELEGRAM_CHAT_ID, {
                        filename: stored.name,
                        mimeType: stored.mime,
                        body: stored.body,
                    }, signal);
                    delivered = attachmentDelivered && delivered;
                }
            }
        } else if (task.channel === "discord") {
            const note = artifacts.length
                ? `\n\n(${artifacts.length} file(s) generated - download from the web app.)`
                : "";
            deliveryStarted = true;
            const sent = await notify("scheduled_task", `🕑 **${task.title}**\n\n${reply}${note}`, { signal });
            delivered = sent.discord;
        }

        if (!delivered) {
            const detail = `Ran, but delivery to ${task.channel} was not fully confirmed. Check the destination before starting another run; delivery was not retried.`;
            await finishTaskRun(runId, "error", detail);
            return { id: task.id, title: task.title, status: "error", detail };
        }

        signal.throwIfAborted();
        if (!await finishTaskRun(runId, "ok", reply)) throw new Error("The run is no longer current. Its result was not allowed to replace a newer run.");
        return { id: task.id, title: task.title, status: "ok", detail: reply.slice(0, 200) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const detail = deliveryStarted ? `Delivery outcome is unconfirmed. Check the destination before another run. ${reason}` : reason;
        console.error(`[Tasks] Run failed for "${task.title}":`, error);
        await finishTaskRun(runId, "error", detail).catch(() => {});
        return { id: task.id, title: task.title, status: "error", detail };
    }
}
