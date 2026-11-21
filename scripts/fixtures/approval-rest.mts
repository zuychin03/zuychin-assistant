import type { PGlite } from "@electric-sql/pglite";

/** Switches a test flips to simulate outages or a missing migration. */
export interface RestState {
    decideFails: boolean;
    proposeChatFails: boolean;
    noticesMissing: boolean;
    /** Every assistant or user message the app saved, as posted. */
    messages: Record<string, unknown>[];
}

/**
 * Answers the Supabase REST calls the approval code makes by running the real SQL in PGlite:
 * the approval RPCs, the channel thread RPC and the notices table. Anything else gets an empty list.
 */
export function approvalRest(db: PGlite, owner: string, state: RestState) {
    const value = async (sql: string, params: unknown[]) => (await db.query<{ value: unknown }>(sql, params)).rows[0]?.value ?? null;
    const eq = (url: URL, key: string) => url.searchParams.get(key)?.replace(/^eq\./, "") ?? null;
    return async (url: URL, method: string, body: string): Promise<Response> => {
        const path = url.pathname.replace(/^\/rest\/v1\//, "");
        const args = body ? JSON.parse(body) : {};
        const accept = (wanted: unknown) => Response.json(wanted);
        if (path === "user_profiles") return accept([{ id: owner, display_name: "Owner", system_prompt: null, preferences: {} }]);
        if (path === "rpc/assistant_decide_action") {
            if (state.decideFails) return Response.json({ code: "57014", message: "statement timeout", details: null, hint: null }, { status: 500 });
            return accept(await value("select public.assistant_decide_action($1, $2, $3) as value", [args.p_id, args.p_user_id, args.p_decision]));
        }
        if (path === "rpc/assistant_finish_action") return accept(await value("select public.assistant_finish_action($1, $2, $3, $4) as value", [args.p_id, args.p_token, args.p_status, args.p_receipt]));
        if (path === "rpc/assistant_propose_action") return accept(await value("select public.assistant_propose_action($1, $2, $3, $4, $5) as value", [args.p_run_id, args.p_tool, args.p_args, args.p_hash, args.p_sources]));
        if (path === "rpc/assistant_propose_chat_action") {
            if (state.proposeChatFails) return Response.json({ code: "57014", message: "statement timeout", details: null, hint: null }, { status: 500 });
            return accept(await value("select public.assistant_propose_chat_action($1, $2, $3, $4, $5, $6, $7, $8, $9) as value",
                [args.p_profile, args.p_conversation, args.p_turn, args.p_channel, args.p_tool, args.p_args, args.p_hash, args.p_instruction, args.p_sources]));
        }
        if (path === "rpc/assistant_channel_thread") {
            return accept(await value("select public.assistant_channel_thread($1, $2, $3::uuid, $4::integer, $5::boolean) as value",
                [args.p_channel, args.p_chat_key, args.p_profile, args.p_gap_seconds, args.p_force_new]));
        }
        if (path === "rpc/assistant_context_snapshot") return accept({ messages: [], revision: "fixture-empty", summary: null, project_id: null });
        if (path === "messages" && method === "POST") {
            state.messages.push(args);
            const row = { id: crypto.randomUUID() };
            return Response.json(row, { status: 201 });
        }
        if (path === "assistant_approval_notices") {
            if (state.noticesMissing) return Response.json({ code: "PGRST205", message: "Could not find the table", details: null, hint: null }, { status: 404 });
            if (method === "POST") {
                const row = Array.isArray(args) ? args[0] : args;
                const { rows } = await db.query("insert into assistant_approval_notices (approval_id, channel, chat_id) values ($1, $2, $3) on conflict do nothing returning approval_id", [row.approval_id, row.channel, row.chat_id]);
                return Response.json(rows, { status: 201 });
            }
            if (method === "PATCH") {
                await db.query("update assistant_approval_notices set message_id = $1 where approval_id = $2 and channel = $3", [args.message_id, eq(url, "approval_id"), eq(url, "channel")]);
                return new Response(null, { status: 204 });
            }
            if (method === "DELETE") {
                await db.query("delete from assistant_approval_notices where approval_id = $1 and channel = $2", [eq(url, "approval_id"), eq(url, "channel")]);
                return new Response(null, { status: 204 });
            }
            const { rows } = await db.query("select chat_id, message_id::int as message_id from assistant_approval_notices where approval_id = $1 and channel = $2 and message_id is not null", [eq(url, "approval_id"), eq(url, "channel")]);
            return Response.json(rows);
        }
        return Response.json([]);
    };
}
