export interface TelegramCommand { search: boolean; thinking: boolean; agent: boolean; text: string }

const COMMAND = /^[/!](search|think|agent)(?:@\S+)?(?=\s|$)\s*([\s\S]*)/i;

export function parseTelegramCommand(input: string): TelegramCommand {
    const match = COMMAND.exec(input);
    if (!match) return { search: false, thinking: false, agent: false, text: input };
    const command = match[1].toLowerCase();
    return { search: command === "search", thinking: command === "think", agent: command === "agent", text: match[2].trim() };
}

// The chat sees a plain reason; the raw error, which can carry provider detail, stays in the log.
export function telegramFailureText(error: unknown): string {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (/safe context budget|context safety limit/i.test(message)) return "This chat's history is too long for me to read right now, so I couldn't answer.";
    if (/changed while building context|retry this message/i.test(message)) return "Something changed while I was reading the chat. Please send that again.";
    if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) return "That took too long and was stopped. Please try again.";
    if (/\b429\b|\b503\b|quota|rate.?limit|resource.?exhausted|high demand|overloaded/i.test(message)) {
        return "The model is busy or out of quota right now. Try again in a minute, or switch with /model.";
    }
    return "Sorry, something went wrong on my side. Please try again in a moment.";
}
