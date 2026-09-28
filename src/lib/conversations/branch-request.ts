import { validConversationId } from "./branches";

export function createBranchRequest(conversationId: string, messageId: string, requestId = crypto.randomUUID()) {
    const body = JSON.stringify({ conversationId, messageId, requestId });
    let result: string | null = null;
    let pending: Promise<string> | null = null;
    return function attempt(): Promise<string> {
        if (result) return Promise.resolve(result);
        if (pending) return pending;
        pending = (async () => {
            const response = await fetch("/api/conversations/branches", {
                method: "POST", headers: { "Content-Type": "application/json" }, body,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The branch could not be created.");
            if (!validConversationId(data.conversation?.id)) throw new Error("The branch response was incomplete. Retry to recover the same branch.");
            result = data.conversation.id;
            return result!;
        })().finally(() => { pending = null; });
        return pending;
    };
}
