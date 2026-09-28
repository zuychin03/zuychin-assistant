import { runRequestKey } from "./task-form";

export type RunIdentity = { runId: string; status: "accepted" | "reused" | "active" };

export async function submitRunRequest(taskId: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, send: (body: { id: string; requestId: string }) => Promise<{ response: Pick<Response, "ok" | "status">; data: Record<string, unknown> }>): Promise<RunIdentity> {
    let requestId: string;
    const key = runRequestKey(taskId);
    try {
        requestId = storage.getItem(key) || crypto.randomUUID();
        storage.setItem(key, requestId);
    } catch { throw new Error("This browser cannot retain the run request. Allow session storage before running a task."); }
    const { response, data } = await send({ id: taskId, requestId });
    if ((response.ok || response.status === 409) && typeof data.runId === "string" && data.runId.length > 0 && ["accepted", "reused", "active"].includes(String(data.status))) {
        try { storage.removeItem(key); } catch { /* Retaining the same request remains safe. */ }
        return { runId: data.runId, status: data.status as RunIdentity["status"] };
    }
    throw new Error(typeof data.error === "string" ? data.error : "The run request was not confirmed.");
}
