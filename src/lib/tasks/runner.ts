import { ragChat } from "@/lib/ai/rag-service";
import { getArtifact } from "@/lib/artifacts/store";
import { sendTelegramMessage, sendTelegramDocument } from "@/lib/messaging/telegram-service";
import { sendDiscordMessage } from "@/lib/messaging/discord-service";
import { recordTaskResult, type ScheduledTask } from "@/lib/tasks/store";

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

export interface TaskRunResult {
    id: string;
    title: string;
    status: "ok" | "error";
    detail: string;
}

/**
 * Execute a claimed task through the normal chat pipeline (real channel =
 * model prefs, memory partition, persistence and agent tracing all apply),
 * then deliver the reply to the task's channel. Web tasks need no delivery:
 * ragChat already persisted the exchange into the target conversation.
 */
export async function runScheduledTask(task: ScheduledTask): Promise<TaskRunResult> {
    try {
        const { reply, artifacts } = await ragChat({
            message: task.instruction,
            channel: task.channel,
            conversationId: task.channel === "web" ? (task.conversationId ?? undefined) : undefined,
            agent: task.agentMode,
        });

        let delivered = true;
        if (task.channel === "telegram") {
            if (!TELEGRAM_CHAT_ID) {
                delivered = false;
            } else {
                delivered = await sendTelegramMessage(TELEGRAM_CHAT_ID, `🕑 **${task.title}**\n\n${reply}`);
                for (const a of artifacts) {
                    const stored = await getArtifact(a.id);
                    if (!stored) continue;
                    await sendTelegramDocument(TELEGRAM_CHAT_ID, {
                        filename: stored.name,
                        mimeType: stored.mime,
                        body: stored.body,
                    });
                }
            }
        } else if (task.channel === "discord") {
            if (!DISCORD_CHANNEL_ID) {
                delivered = false;
            } else {
                const note = artifacts.length
                    ? `\n\n(${artifacts.length} file(s) generated — download from the web app.)`
                    : "";
                delivered = await sendDiscordMessage(DISCORD_CHANNEL_ID, `🕑 **${task.title}**\n\n${reply}${note}`);
            }
        }

        if (!delivered) {
            const detail = `Ran, but delivery to ${task.channel} failed (channel not configured or send error).`;
            await recordTaskResult(task.id, "error", detail);
            return { id: task.id, title: task.title, status: "error", detail };
        }

        await recordTaskResult(task.id, "ok", reply);
        return { id: task.id, title: task.title, status: "ok", detail: reply.slice(0, 200) };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Tasks] Run failed for "${task.title}":`, error);
        await recordTaskResult(task.id, "error", detail);
        return { id: task.id, title: task.title, status: "error", detail };
    }
}
