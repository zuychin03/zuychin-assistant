import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";

const PAGE_SIZE = 50;
const cursorSchema = z.string().uuid();
const rowSchema = z.object({
    session_id: cursorSchema, code: z.string().regex(/^CN-[A-Z0-9]{4}$/),
    status: z.enum(["open", "concluding", "awaiting_owner", "closed"]),
    paused_at: z.string().datetime({ offset: true }).nullable(),
    host_generation: z.string().min(1).max(100).nullable(),
    policy_version: z.string().min(1).max(100).nullable(),
    has_execution_history: z.boolean(),
});

export interface CouncilRuntimeInventoryRecord {
    sessionId: string;
    code: string;
    status: "open" | "concluding" | "awaiting_owner" | "closed";
    pausedAt: string | null;
    hostGeneration: string | null;
    policyVersion: string | null;
    hasExecutionHistory: boolean;
}

export interface CouncilRuntimeInventoryPage {
    status: "available" | "unavailable";
    records: CouncilRuntimeInventoryRecord[];
    nextCursor: string | null;
}

export function parseRuntimeInventoryCursor(cursor: string | null): string | null {
    if (cursor === null) return null;
    const parsed = cursorSchema.safeParse(cursor);
    if (!parsed.success) throw new Error("Invalid inventory cursor.");
    return parsed.data.toLowerCase();
}

export async function readRuntimeInventory(cursor: string | null = null): Promise<CouncilRuntimeInventoryPage> {
    const after = parseRuntimeInventoryCursor(cursor);
    try {
        const { data, error } = await supabaseAdmin.rpc("list_council_runtime_inventory", { p_after: after })
            .abortSignal(AbortSignal.timeout(5_000));
        if (error) throw error;
        const rows = z.array(rowSchema).max(PAGE_SIZE + 1).parse(data);
        if (rows.some((row, index) => row.session_id.toLowerCase() <= (index === 0 ? after ?? "" : rows[index - 1].session_id.toLowerCase()))) {
            throw new Error("Invalid inventory order.");
        }
        const records = rows.slice(0, PAGE_SIZE).map(row => ({
            sessionId: row.session_id.toLowerCase(), code: row.code, status: row.status, pausedAt: row.paused_at,
            hostGeneration: row.host_generation, policyVersion: row.policy_version, hasExecutionHistory: row.has_execution_history,
        }));
        return { status: "available", records, nextCursor: rows.length > PAGE_SIZE ? records.at(-1)!.sessionId : null };
    } catch {
        return { status: "unavailable", records: [], nextCursor: null };
    }
}
