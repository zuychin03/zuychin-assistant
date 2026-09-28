const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function resumeRequestError(input: { resumeRunId?: unknown; conversationId?: unknown; channel?: unknown; agent?: unknown }): string | null {
    if (input.resumeRunId === undefined) return null;
    if (!uuid(input.resumeRunId) || !uuid(input.conversationId)) return "Resume requires valid run and conversation IDs.";
    if ((input.channel ?? "web") !== "web" || input.agent !== true) return "Resume is only available for an agent run in its original web conversation.";
    return null;
}
export class ResumeScopeError extends Error {
    constructor() { super("This run is unavailable in the current owner and conversation scope."); this.name = "ResumeScopeError"; }
}
