import { ai, MODEL } from "@/lib/gemini";
import { Type, ThinkingLevel } from "@google/genai";

export interface RouteDecision {
    mode: "chat" | "agent";
}

const TRIVIAL = /^(hi|hey|hello|thanks|thank you|thx|ok|okay|cool|nice|yes|no|yep|nope|sup|yo|good (morning|afternoon|evening|night))\b/i;

const AGENT_HINT = /\b(report|essay|write[- ]?up|document|generate|build|create|script|code|program|refactor|debug|implement|research|analy[sz]e|draft|bundle|project|spreadsheet|\.(py|js|ts|tsx|md|pdf|docx|csv|json|zip))\b/i;

function routerPrompt(message: string): string {
    return `You route a personal assistant's messages. Decide how to handle this user message.
Choose "agent" when it needs multiple steps, research, producing a document/report, or writing code/files — anything that benefits from an autonomous multi-step agent that uses tools and can return downloadable files.
Choose "chat" for simple questions, quick facts, casual talk, memory/recall, scheduling a single reminder, or anything answerable in one short reply.
User message:
"""${message.slice(0, 2000)}"""
Respond ONLY with JSON: {"mode":"agent"} or {"mode":"chat"}.`;
}

export async function classifyIntent(message: string): Promise<RouteDecision> {
    const text = message.trim();

    if (text.length < 16 || TRIVIAL.test(text)) return { mode: "chat" };

    try {
        const resp = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: routerPrompt(text) }] }],
            config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: { mode: { type: Type.STRING, enum: ["chat", "agent"] } },
                    required: ["mode"],
                },
            },
        });
        const parsed = JSON.parse(resp.text ?? "{}") as { mode?: string };
        return { mode: parsed.mode === "agent" ? "agent" : "chat" };
    } catch (err) {
        console.warn("[Router] classification failed, using heuristic:", err);
        return { mode: AGENT_HINT.test(text) ? "agent" : "chat" };
    }
}
