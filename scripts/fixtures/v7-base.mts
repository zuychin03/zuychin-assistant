import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";

/** The parts of supabase-setup.sql that v7-channel-threads.sql builds on, with Supabase's default grants. */
export async function applyV7Base(db: PGlite): Promise<void> {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    // Supabase grants new tables to anon and authenticated by default; the migrations must take that back.
    await db.exec("alter default privileges in schema public grant all on tables to anon, authenticated;");
    const setup = await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8");
    for (const table of ["user_profiles", "conversations", "scheduled_tasks"]) {
        const match = setup.match(new RegExp(String.raw`create table if not exists ${table} \([\s\S]*?\n\);`));
        if (!match) throw new Error(`supabase-setup.sql has no ${table} table`);
        await db.exec(match[0]);
    }
    await db.exec(await readFile(new URL("../migrations/v6-scheduled-actions.sql", import.meta.url), "utf8"));
}
