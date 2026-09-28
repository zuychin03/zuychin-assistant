import type { Message, MessageMetadata } from "../types";

export interface ForkRequest { conversationId: string; messageId: string; requestId: string; title?: string }
export interface BranchConversation {
    id: string; title: string; projectId: string | null; parentConversationId: string | null;
    parentMessageId: string | null; copiedCount: number; createdAt: string;
}
export interface BranchComparisonSide { conversation: BranchConversation; messages: Message[] }
export interface BranchComparison { left: BranchComparisonSide; right: BranchComparisonSide }
export class BranchError extends Error {
    constructor(message: string, readonly status: number) { super(message); this.name = "BranchError"; }
}
export function validConversationId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function parseForkRequest(value: unknown): ForkRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BranchError("Provide a branch request object.", 400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["conversationId", "messageId", "requestId", "title"].includes(key))) {
        throw new BranchError("Only conversationId, messageId, requestId and title are accepted.", 400);
    }
    for (const key of ["conversationId", "messageId", "requestId"] as const) {
        if (!validConversationId(body[key])) throw new BranchError(`A valid ${key} is required.`, 400);
    }
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120)) {
        throw new BranchError("Branch titles must contain 1 to 120 characters.", 400);
    }
    return { conversationId: body.conversationId as string, messageId: body.messageId as string, requestId: body.requestId as string,
        ...(typeof body.title === "string" ? { title: body.title.trim() } : {}) };
}
export function isolateBranchRecall<T extends { metadata?: Record<string, string | undefined> }>(matches: T[], conversationId: string | undefined, branched: boolean): T[] {
    if (!branched) return matches;
    return matches.filter((match) => !(match.metadata?.source === "user_message" || match.metadata?.conversationId)
        || match.metadata.conversationId === conversationId);
}
export function comparisonUrl(left: string, right: string): string {
    return `/conversations/compare?${new URLSearchParams({ left, right })}`;
}
export function matchingPrefixCount(left: Message[], right: Message[]): number {
    let count = 0;
    while (count < Math.min(left.length, right.length)) {
        const a = left[count], b = right[count];
        if (a.role !== b.role || a.content !== b.content || a.imageUrl !== b.imageUrl
            || JSON.stringify(a.metadata?.replyTo ?? null) !== JSON.stringify(b.metadata?.replyTo ?? null)) break;
        count++;
    }
    return count;
}
export function safeCopiedMetadata(metadata: MessageMetadata, origin: { conversationId: string; messageId: string }): MessageMetadata {
    const safe: MessageMetadata = { branchOrigin: { ...origin, copied: true } };
    if (metadata.knowledgeOnly === true) safe.knowledgeOnly = true;
    if (metadata.replyTo && ["user", "assistant"].includes(metadata.replyTo.role) && typeof metadata.replyTo.content === "string") {
        safe.replyTo = { role: metadata.replyTo.role, content: metadata.replyTo.content };
    }
    const trace = metadata.replyTrace as { calls?: unknown[] } | undefined;
    const models = [
        ...(Array.isArray(metadata.historicalModels) ? metadata.historicalModels : []),
        ...(Array.isArray(trace?.calls) ? trace.calls.filter((call) => {
            const item = call as Record<string, unknown> | null;
            return item?.status === "success" && ["chat", "worker", "orchestration"].includes(String(item.purpose));
        }) : []),
    ].flatMap((entry) => {
        const item = entry as Record<string, unknown> | null;
        return item && typeof item.providerId === "string" && typeof item.modelId === "string"
            ? [{ providerId: item.providerId, modelId: item.modelId }] : [];
    });
    if (models.length) safe.historicalModels = [...new Map(models.map((model) => [`${model.providerId}:${model.modelId}`, model])).values()];
    return safe;
}
