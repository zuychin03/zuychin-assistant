import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const migration = await readFile(new URL("./migrations/server-only-tables.sql", import.meta.url), "utf8");
const SERVER_ONLY = ["user_profiles", "conversations", "messages", "embeddings", "todos", "artifacts", "vault_pages",
    "agent_runs", "memories", "scheduled_tasks", "processed_emails", "projects", "custom_skills", "initiative_log",
    "cron_state", "push_subscriptions", "conversation_cleanup_recommendations", "vault_graph_snapshot", "vault_page_links"];
const OPEN_ROLES = /\b(public|anon|authenticated)\b/i;

await check("setup creates no policy that reaches public, anon or authenticated", async () => {
    const policies = [...setup.matchAll(/create policy\s+("[^"]+"|[a-z_0-9]+)\s+on\s+([a-z_.]+)([\s\S]*?);/gi)];
    assert.ok(policies.length > 0, "The policy parser must find the service-role policies");
    for (const [, name, table, body] of policies) {
        const roles = /\bto\s+([a-z_,\s]+?)(?=\s+using\b|\s+with\b|$)/i.exec(body.trim())?.[1];
        assert.ok(roles, `${name} on ${table} applies to every role`);
        assert.doesNotMatch(roles, OPEN_ROLES, `${name} on ${table} reaches ${roles}`);
    }
});

await check("setup revokes every server-only table and the conversation delete function", async () => {
    for (const table of SERVER_ONLY) {
        assert.ok(setup.includes(`revoke all on ${table} from public, anon, authenticated;`), `${table} must be revoked from public, anon and authenticated`);
        assert.ok(setup.includes(`drop policy if exists "Allow all access to ${table}" on ${table};`), `Re-running setup must drop the old ${table} policy`);
    }
    assert.ok(setup.includes("revoke all on function delete_conversation_with_associations(uuid) from public, anon, authenticated;"));
    for (const table of SERVER_ONLY) assert.ok(migration.includes(`('${table}')`), `The migration must cover ${table}`);
});

await check("every security definer function in setup is revoked from the public role", async () => {
    // Header before the dollar-quoted body, trailer after it: "security definer" may sit in either.
    const definitions = [...setup.matchAll(/create or replace function\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\bas\s+(\$[a-z_]*\$)[\s\S]*?\3([^;]*);/gi)];
    const definer = new Set(definitions.filter(([, , header, , trailer]) => /security\s+definer/i.test(header + trailer)).map(match => match[1]));
    assert.ok(definer.size >= 20, "The parser must see the security definer functions");
    const revoked = new Set<string>();
    for (const [, targets, grantees] of setup.matchAll(/revoke\s+(?:all|execute)(?:\s+privileges)?\s+on\s+(?:function|routine)s?\s+([\s\S]*?)\s+from\s+([^;]+);/gi)) {
        if (!/\bpublic\b/i.test(grantees)) continue;
        for (const [, name] of targets.matchAll(/(?:public\.)?([a-z_0-9]+)\s*\(/gi)) revoked.add(name);
    }
    for (const [, names] of setup.matchAll(/proname in \(([^)]*)\)/gi)) for (const [, name] of names.matchAll(/'([a-z_0-9]+)'/g)) revoked.add(name);
    assert.deepEqual([...definer].filter(name => !revoked.has(name)), [], "Security definer functions run with the owner's rights, so the public role must not be able to call them");
});

const deleteFunction = /create or replace function delete_conversation_with_associations\(target_conversation_id uuid\)[\s\S]*?\$\$;/.exec(setup)?.[0];
assert.ok(deleteFunction, "delete_conversation_with_associations must exist in setup");

async function exposedDatabase(tables = SERVER_ONLY, withFunction = true): Promise<PGlite> {
    const db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;");
    for (const table of tables) {
        const columns = table === "conversations" ? "id uuid primary key" : table === "embeddings" ? "id uuid primary key default gen_random_uuid(), metadata jsonb" : "id text primary key";
        await db.exec(`create table ${table} (${columns});
            alter table ${table} enable row level security;
            create policy "Allow all access to ${table}" on ${table} for all using (true) with check (true);`);
    }
    // Supabase grants new tables to anon and authenticated by default.
    await db.exec("grant all on all tables in schema public to anon, authenticated, service_role;");
    if (withFunction) await db.exec(deleteFunction!);
    return db;
}
async function as<T>(db: PGlite, role: string, work: () => Promise<T>): Promise<T> {
    await db.exec(`set role ${role}`);
    try { return await work(); } finally { await db.exec("reset role"); }
}
const denied = /permission denied/i;

await check("the exposure is reproduced before the migration", async () => {
    const db = await exposedDatabase();
    await db.query("insert into messages (id) values ('m1')");
    assert.equal((await as(db, "anon", () => db.query<{ n: number }>("select count(*)::int as n from messages"))).rows[0].n, 1);
    await as(db, "anon", () => db.query("insert into todos (id) values ('planted')"));
    await as(db, "anon", () => db.query("select delete_conversation_with_associations($1)", [randomUUID()]));
});

await check("after the migration anon and authenticated reach nothing and the service role keeps working", async () => {
    const db = await exposedDatabase();
    const conversation = randomUUID();
    await db.query("insert into messages (id) values ('m1')");
    await db.query("insert into conversations (id) values ($1)", [conversation]);
    const results = await db.exec(migration);
    assert.deepEqual(results.at(-1)!.rows, [], "The migration's final query must report nothing still open");
    for (const role of ["anon", "authenticated"]) {
        for (const table of SERVER_ONLY) {
            await assert.rejects(as(db, role, () => db.query(`select count(*) from ${table}`)), denied, `${role} must not read ${table}`);
        }
        await assert.rejects(as(db, role, () => db.query("insert into todos (id) values ('planted')")), denied);
        await assert.rejects(as(db, role, () => db.query("update messages set id = 'changed'")), denied);
        await assert.rejects(as(db, role, () => db.query("delete from conversations")), denied);
        await assert.rejects(as(db, role, () => db.query("select delete_conversation_with_associations($1)", [conversation])), denied);
    }
    assert.equal(await db.query<{ n: number }>("select count(*)::int as n from pg_policies where schemaname = 'public'").then(r => r.rows[0].n), 0);
    const service = await as(db, "service_role", async () => ({
        messages: (await db.query<{ n: number }>("select count(*)::int as n from messages")).rows[0].n,
        deleted: (await db.query<{ ok: boolean }>("select delete_conversation_with_associations($1) as ok", [conversation])).rows[0].ok,
    }));
    assert.deepEqual(service, { messages: 1, deleted: true });
    assert.deepEqual((await db.exec(migration)).at(-1)!.rows, [], "Running the migration again stays closed");
});

await check("an older install without some tables or the function is handled", async () => {
    const db = await exposedDatabase(SERVER_ONLY.filter(table => !["vault_graph_snapshot", "vault_page_links", "conversation_cleanup_recommendations"].includes(table)), false);
    assert.deepEqual((await db.exec(migration)).at(-1)!.rows, []);
    await assert.rejects(as(db, "anon", () => db.query("select count(*) from messages")), denied);
});

console.log(`\nServer-only tables: ${passed} checks passed. No hosted database was used.`);
