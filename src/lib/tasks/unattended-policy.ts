import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface UnattendedRun {
    runId: string; taskId: string; taskTitle: string; instruction: string; userProfileId: string;
}
export interface ProposedAction extends UnattendedRun {
    tool: string; args: Record<string, unknown>; argsHash: string; sourceContext: string;
}
type Scope = UnattendedRun & { sources: string[]; initialContext?: string; permit?: { tool: string; argsHash: string; used: boolean } };
const scope = new AsyncLocalStorage<Scope>();
const READ = new Set(["get_current_time", "search_web", "search_knowledge", "search_history", "get_recent_conversations",
    "list_calendar_events", "list_unread_emails", "list_recent_emails", "read_email", "vault_search", "vault_read"]);
const LOCAL = new Set(["create_document", "create_code_file", "create_code_bundle"]);
const MUTATIONS = new Set(["send_email", "draft_gmail_reply", "manage_calendar_event", "save_note", "vault_ingest",
    "vault_write", "vault_delete", "vault_lint", "manage_todo_list", "manage_scheduled_task", "manage_memory_facts", "manage_notes"]);
const LISTABLE = new Set(["manage_todo_list", "manage_scheduled_task", "manage_memory_facts", "manage_notes"]);

export function unattendedDisposition(tool: string, args: Record<string, unknown>): "read" | "local" | "approval" | "deny" {
    if (tool.startsWith("council_")) return "deny";
    if (READ.has(tool) || (LISTABLE.has(tool) && args.action === "list")) return "read";
    if (LOCAL.has(tool)) return "local";
    return MUTATIONS.has(tool) ? "approval" : "deny";
}
function canonical(value: unknown, depth = 0): string {
    if (depth > 20) throw new Error("Action arguments are too deeply nested.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map((item) => canonical(item, depth + 1)).join(",") + "]";
    if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
        return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key], depth + 1)).join(",") + "}";
    }
    throw new Error("Action arguments must contain finite JSON values only.");
}
export function canonicalAction(tool: string, args: Record<string, unknown>): { hash: string; args: Record<string, unknown> } {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(tool)) throw new Error("Invalid action tool.");
    const encoded = canonical(args);
    if (encoded.length > 100_000) throw new Error("Action arguments exceed the review limit.");
    return { hash: createHash("sha256").update(tool + "\n" + encoded).digest("hex"), args: JSON.parse(encoded) };
}
export function withUnattendedRun<T>(run: UnattendedRun, fn: () => T): T {
    return scope.run({ ...run, sources: [] }, fn);
}
export function withApprovedAction<T>(run: UnattendedRun & { tool: string; argsHash: string }, fn: () => T): T {
    return scope.run({ ...run, sources: [], permit: { tool: run.tool, argsHash: run.argsHash, used: false } }, fn);
}
export function isUnattendedRun(): boolean { return Boolean(scope.getStore()); }
export function recordUnattendedContext(label: string, content: string): void {
    const current = scope.getStore();
    if (!current || !content) return;
    const text = `${label}:\n${content}`;
    current.initialContext = text.length > 7900 ? `${text.slice(0, 7850)}\n[Initial context truncated]` : text;
}
export function recordUnattendedSource(tool: string, result: string, args: Record<string, unknown> = {}): void {
    const current = scope.getStore();
    if (!current || unattendedDisposition(tool, args) !== "read") return;
    current.sources.push(tool + ":\n" + result.slice(0, 7000) + (result.length > 7000 ? "\n[Read result truncated]" : ""));
    while (current.sources.join("\n\n").length > 7900) current.sources.shift();
}

export function confirmedActionReceipt(tool: string, args: Record<string, unknown>, receipt: string): boolean {
    const action = String(args.action ?? "");
    switch (tool) {
        case "send_email": return /^✅ Email sent to /.test(receipt);
        case "draft_gmail_reply": return /^✅ Draft reply created! Draft ID: \S+/.test(receipt);
        case "manage_calendar_event": return action === "delete" ? receipt === "Event deleted successfully." : /^✅ Event created: /.test(receipt);
        case "save_note": return /^Note saved successfully: /.test(receipt);
        case "vault_write": return /^(Created|Updated) wiki\/\S+ \(commit [a-f0-9]{7}\)\. Index and log updated\.$/.test(receipt);
        case "vault_ingest": return /^(Created|Updated) wiki\/\S+ \(commit [a-f0-9]{7}\)\. Summary: /.test(receipt);
        case "vault_delete": return /^Deleted wiki\/\S+ \(commit [a-f0-9]{7}\)\. Index, log and search index updated\./.test(receipt);
        case "manage_todo_list": return action === "add" ? /^✅ Task added: /.test(receipt) : action === "complete" ? receipt === "✅ Task marked as done!" : action === "delete" && receipt === "🗑️ Task deleted.";
        case "manage_notes": return action === "update" ? receipt === "✅ Note updated." : action === "delete" && receipt === "🗑️ Note deleted.";
        case "manage_memory_facts": return action === "correct" ? /^✅ Fact updated to: /.test(receipt) : action === "forget" && receipt === "🗑️ Fact forgotten.";
        case "manage_scheduled_task": return action === "create" ? /^✅ Scheduled "/.test(receipt) : action === "update" ? /^✅ Updated "/.test(receipt) : action === "enable" ? /^✅ Enabled "/.test(receipt) : action === "disable" ? /^⏸ Disabled "/.test(receipt) : action === "delete" && receipt === "🗑️ Scheduled task deleted.";
        default: return false;
    }
}
export async function gateUnattendedTool(
    tool: string, args: Record<string, unknown>,
    propose: (action: ProposedAction) => Promise<{ id: string; status: string }>,
): Promise<string | null> {
    const current = scope.getStore();
    if (!current) return null;
    const disposition = unattendedDisposition(tool, args);
    if (disposition === "deny") return "This tool is not authorised for unattended tasks. No action was executed.";
    if (disposition === "read" || disposition === "local") return null;
    try {
        const action = canonicalAction(tool, args);
        if (current.permit) {
            if (current.permit.tool !== tool || current.permit.argsHash !== action.hash) return "These arguments are not authorised by the approved action.";
            if (current.permit.used) return "This approval was already used. The action was not repeated.";
            current.permit.used = true;
            return null;
        }
        if (!current.userProfileId) return "The task has no confirmed owner. This action was not executed.";
        const proposal = await propose({ runId: current.runId, taskId: current.taskId, taskTitle: current.taskTitle,
            instruction: current.instruction, userProfileId: current.userProfileId, tool, args: action.args,
            argsHash: action.hash, sourceContext: [current.initialContext, ...current.sources].filter(Boolean).join("\n\n") });
        return proposal.status === "pending"
            ? `Awaiting your approval: [review ${tool}](/tasks?approval=${proposal.id}). No action has been executed.`
            : `This action is already recorded as ${proposal.status}. It was not repeated. [Review it](/tasks?approval=${proposal.id}).`;
    } catch {
        return "Approval could not be recorded safely. This action was not executed. Report this to the user.";
    }
}
