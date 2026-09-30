import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://owner-profile-fixture.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service", GEMINI_API_KEY: "fixture-gemini",
});

let passed = 0;
async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

interface ProfileRow { id: string; display_name: string; system_prompt: string | null; preferences: Record<string, unknown> | null; created_at: string }
interface MessageRow { id: string; user_profile_id: string | null; created_at: string }
let profiles: ProfileRow[] = [];
let messages: MessageRow[] = [];
let failing: string | null = null;
let requests: string[] = [];
const profile = (id: string, created: string, prompt = "Fixture prompt"): ProfileRow =>
    ({ id, display_name: "Owner", system_prompt: prompt, preferences: { voice: { voiceName: "Kore" } }, created_at: created });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "owner-profile-fixture.supabase.co");
    const table = url.pathname.replace("/rest/v1/", "");
    requests.push(`${table}?${decodeURIComponent(url.searchParams.toString())}`);
    if (failing === table) return Response.json({ code: "08006", message: "connection failure" }, { status: 503 });
    const limit = Number(url.searchParams.get("limit") ?? Infinity);
    if (table === "user_profiles") {
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        let rows = profiles.filter(row => !id || row.id === id);
        if (url.searchParams.get("order") === "created_at.asc,id.asc") {
            rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        }
        return Response.json(rows.slice(0, limit));
    }
    if (table === "messages") {
        assert.equal(url.searchParams.get("user_profile_id"), "not.is.null");
        assert.equal(url.searchParams.get("order"), "created_at.desc,id.desc");
        const rows = messages.filter(row => row.user_profile_id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        return Response.json(rows.slice(0, limit).map(row => ({ user_profile_id: row.user_profile_id })));
    }
    throw new Error(`Unexpected request: ${url}`);
};

const { resolveOwnerProfile, OwnerProfileError } = await import("../src/lib/owner-profile");
const { getDefaultProfile } = await import("../src/lib/db");
const { branchUserId } = await import("../src/lib/conversations/branch-api");
const { BranchError } = await import("../src/lib/conversations/branches");
const warnings: string[] = [];
const errors: string[] = [];
const { warn, error } = console;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };

try {
    await check("a single profile resolves in one request with its settings", async () => {
        profiles = [profile("11111111-1111-4111-8111-111111111111", "2026-07-30T00:00:00Z", "Current prompt")];
        messages = [];
        requests = [];
        assert.deepEqual(await resolveOwnerProfile(), { id: profiles[0].id, displayName: "Owner", systemPrompt: "Current prompt", preferences: { voice: { voiceName: "Kore" } } });
        assert.deepEqual(requests, ["user_profiles?select=id,display_name,system_prompt,preferences&order=created_at.asc,id.asc&limit=2"]);
        assert.deepEqual(await getDefaultProfile(), await resolveOwnerProfile());
        assert.equal(await branchUserId(), profiles[0].id);
    });

    await check("no profile is reported as missing, not invented", async () => {
        profiles = [];
        assert.equal(await resolveOwnerProfile(), null);
        assert.equal(await getDefaultProfile(), null);
        await assert.rejects(branchUserId(), (e: unknown) => e instanceof BranchError && e.status === 404);
    });

    await check("duplicate profiles resolve to the one holding the newest message", async () => {
        const [oldest, middle, current] = ["aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002", "cccccccc-0000-4000-8000-000000000003"];
        profiles = [profile(current, "2026-07-30T00:00:00Z", "Current prompt"), profile(oldest, "2026-07-01T00:00:00Z"), profile(middle, "2026-07-04T00:00:00Z")];
        messages = [
            { id: "m1", user_profile_id: oldest, created_at: "2026-07-16T00:00:00Z" },
            { id: "m2", user_profile_id: current, created_at: "2026-09-30T00:00:00Z" },
            { id: "m3", user_profile_id: null, created_at: "2026-10-01T00:00:00Z" },
            { id: "m4", user_profile_id: middle, created_at: "2026-07-29T00:00:00Z" },
        ];
        requests = [];
        warnings.length = 0;
        const owner = await resolveOwnerProfile();
        assert.equal(owner?.id, current);
        assert.equal(owner?.systemPrompt, "Current prompt");
        assert.equal(requests.length, 3);
        assert.match(requests[2], new RegExp(`^user_profiles\\?select=[^&]+&id=eq\\.${current}&limit=1$`));
        assert.equal((await resolveOwnerProfile())?.id, current, "The choice is stable across calls");
        assert.equal(warnings.length, 1, "The duplicate warning is logged once per process");
        assert.match(warnings[0], /owner-profile-consolidation\.sql/);
    });

    await check("duplicate profiles without messages resolve to the oldest, ties broken by id", async () => {
        profiles = [profile("bbbbbbbb-0000-4000-8000-000000000002", "2026-07-01T00:00:00Z"), profile("aaaaaaaa-0000-4000-8000-000000000001", "2026-07-01T00:00:00Z"), profile("cccccccc-0000-4000-8000-000000000003", "2026-06-30T12:00:00Z")];
        messages = [];
        assert.equal((await resolveOwnerProfile())?.id, "cccccccc-0000-4000-8000-000000000003");
        profiles = profiles.slice(0, 2);
        assert.equal((await resolveOwnerProfile())?.id, "aaaaaaaa-0000-4000-8000-000000000001");
    });

    await check("storage failures are errors, never a guessed owner", async () => {
        profiles = [profile("aaaaaaaa-0000-4000-8000-000000000001", "2026-07-01T00:00:00Z"), profile("bbbbbbbb-0000-4000-8000-000000000002", "2026-07-04T00:00:00Z")];
        messages = [{ id: "m1", user_profile_id: "bbbbbbbb-0000-4000-8000-000000000002", created_at: "2026-07-16T00:00:00Z" }];
        failing = "messages";
        await assert.rejects(resolveOwnerProfile(), OwnerProfileError);
        failing = "user_profiles";
        await assert.rejects(resolveOwnerProfile(), OwnerProfileError);
        errors.length = 0;
        assert.equal(await getDefaultProfile(), null);
        assert.equal(errors.length, 1);
        await assert.rejects(branchUserId(), (e: unknown) => e instanceof BranchError && e.status === 503);
        failing = null;
    });
} finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
    console.error = error;
}

const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
function extract(pattern: RegExp, label: string): string {
    const match = setup.match(pattern);
    assert.ok(match, `${label} must exist in supabase-setup.sql`);
    return match[0];
}
const updatedAtFunction = extract(/create or replace function update_updated_at\(\)[\s\S]*?\$\$ language plpgsql;/, "update_updated_at");
const tableDdl = (table: string) => extract(new RegExp(String.raw`create table if not exists ${table} \([\s\S]*?\n\);`), `${table} table`);
const triggerDdl = (table: string) => extract(new RegExp(String.raw`drop trigger if exists trigger_${table}_updated_at[\s\S]*?execute function update_updated_at\(\);`), `${table} trigger`);
const singleOwnerBlock = extract(/do \$\$\nbegin\n  if \(select count\(\*\) from user_profiles\) <= 1 then[\s\S]*?end \$\$;/, "single-owner index block");
const seedInsert = extract(/insert into user_profiles \(display_name, system_prompt\)[\s\S]*?on conflict do nothing;/, "profile seed");
const seedPrompt = /'(You are Zuychin, a helpful, warm[^']*)'/.exec(seedInsert)?.[1];
assert.ok(seedPrompt, "The seed prompt must be readable from the seed insert");

async function profileTable(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(updatedAtFunction + tableDdl("user_profiles") + triggerDdl("user_profiles"));
    return db;
}
const count = async (db: PGlite, sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

await check("re-running setup keeps exactly one profile and blocks a second", async () => {
    const db = await profileTable();
    for (let run = 0; run < 3; run++) await db.exec(singleOwnerBlock + seedInsert);
    assert.equal(await count(db, "select count(*) as n from user_profiles"), 1);
    await assert.rejects(db.query("insert into user_profiles (display_name) values ('Second')"), /duplicate key|unique/i);
});

await check("setup leaves an unconsolidated database readable and unindexed", async () => {
    const db = await profileTable();
    await db.exec("insert into user_profiles (display_name) values ('First'), ('Second')");
    await db.exec(singleOwnerBlock + seedInsert);
    assert.equal(await count(db, "select count(*) as n from user_profiles"), 2);
    assert.equal(await count(db, "select count(*) as n from pg_indexes where indexname = 'user_profiles_single_owner'"), 0);
});

const script = await readFile(new URL("./migrations/owner-profile-consolidation.sql", import.meta.url), "utf8");
assert.ok(script.includes(seedPrompt), "The consolidation script must recognise the current setup seed");
function variant(options: { apply?: boolean; owner?: string } = {}): string {
    let text = script;
    if (options.apply) text = text.replace("apply_changes constant boolean := false;", "apply_changes constant boolean := true;");
    if (options.owner) text = text.replace("requested_owner constant uuid := null;", `requested_owner constant uuid := '${options.owner}';`);
    assert.equal(text.includes("apply_changes constant boolean := true;"), options.apply === true);
    return text;
}
type Report = { action: string; target: string; rows: number }[];
async function run(db: PGlite, text: string): Promise<Report> {
    const results = await db.exec(text);
    return results.at(-1)!.rows.map(row => ({ ...(row as { action: string; target: string }), rows: Number((row as { rows: unknown }).rows) }));
}
const lines = (report: Report, action: string) => report.filter(row => row.action === action);

const ids = {
    first: "aaaaaaaa-0000-4000-8000-000000000001", second: "bbbbbbbb-0000-4000-8000-000000000002", current: "cccccccc-0000-4000-8000-000000000003",
    seedA: "dddddddd-0000-4000-8000-000000000004", seedB: "eeeeeeee-0000-4000-8000-000000000005",
};
const stamps = { conversation: "2026-08-14T01:02:03Z", project: "2026-07-20T00:00:00Z", task: "2026-07-10T00:00:00Z", document: "2026-07-12T00:00:00Z" };

async function productionShape(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec("create role anon; create role authenticated;");
    await db.exec(updatedAtFunction);
    for (const table of ["user_profiles", "projects", "conversations", "messages", "scheduled_tasks", "knowledge_documents"]) await db.exec(tableDdl(table));
    await db.query(`insert into user_profiles (id, display_name, system_prompt, preferences, created_at) values
        ($1, 'Owner', 'July prompt', '{"voice":{"voiceName":"Kore"}}', '2026-07-01'), ($2, 'Owner', 'Mid-July prompt', '{}', '2026-07-04'),
        ($3, 'Owner', 'Current prompt', '{}', '2026-07-30'), ($4, 'Owner', $6, '{}', '2026-08-04'), ($5, 'Owner', $6, '{}', '2026-08-16')`,
    [ids.first, ids.second, ids.current, ids.seedA, ids.seedB, seedPrompt]);
    await db.exec(`
        insert into conversations (id, user_profile_id) values
          ('10000000-0000-4000-8000-000000000001', null), ('10000000-0000-4000-8000-000000000002', null),
          ('10000000-0000-4000-8000-000000000003', null), ('10000000-0000-4000-8000-000000000004', '${ids.first}'),
          ('10000000-0000-4000-8000-000000000005', '${ids.current}');
        update conversations set updated_at = '${stamps.conversation}';
        insert into messages (user_profile_id, conversation_id, role, content, created_at) values
          ('${ids.first}', '10000000-0000-4000-8000-000000000001', 'user', 'July question', '2026-07-03'),
          ('${ids.first}', '10000000-0000-4000-8000-000000000001', 'assistant', 'July answer', '2026-07-03 00:01'),
          ('${ids.first}', '10000000-0000-4000-8000-000000000004', 'user', 'Owned chat', '2026-07-10'),
          ('${ids.second}', '10000000-0000-4000-8000-000000000002', 'user', 'Mid-July question', '2026-07-20'),
          ('${ids.second}', '10000000-0000-4000-8000-000000000003', 'user', 'Mixed chat', '2026-07-25'),
          ('${ids.current}', '10000000-0000-4000-8000-000000000005', 'user', 'Latest question', '2026-09-30'),
          ('${ids.current}', '10000000-0000-4000-8000-000000000005', 'assistant', 'Latest answer', '2026-09-30 00:01');
        insert into messages (user_profile_id, role, content, channel, created_at) values (null, 'user', 'Ownerless telegram', 'telegram', '2026-07-30');
        insert into projects (user_profile_id, name) values ('${ids.second}', 'Old project'), ('${ids.current}', 'Current project');
        update projects set updated_at = '${stamps.project}';
        insert into scheduled_tasks (user_profile_id, title, instruction, schedule_type) values
          ('${ids.first}', 'Morning', 'Brief me', 'once'), ('${ids.first}', 'Evening', 'Wrap up', 'once');
        update scheduled_tasks set updated_at = '${stamps.task}';
        insert into knowledge_documents (id, path, title, content_hash, user_profile_id) values
          ('doc-shared', 'wiki/shared.md', 'Shared', 'h1', null), ('doc-owned', 'wiki/owned.md', 'Owned', 'h2', '${ids.second}');
        update knowledge_documents set updated_at = '${stamps.document}';`);
    // Triggers go on last so the fixture timestamps above survive.
    for (const table of ["user_profiles", "conversations", "projects", "scheduled_tasks", "knowledge_documents"]) await db.exec(triggerDdl(table));
    return db;
}
async function snapshot(db: PGlite) {
    return (await db.query(`select
        (select json_agg(id order by id) from user_profiles) as profiles,
        (select json_agg(json_build_object('owner', user_profile_id, 'content', content) order by content) from messages) as messages,
        (select json_agg(json_build_object('owner', user_profile_id, 'updated', updated_at) order by id) from conversations) as conversations,
        (select json_agg(json_build_object('owner', user_profile_id, 'updated', updated_at) order by name) from projects) as projects,
        (select json_agg(json_build_object('owner', user_profile_id, 'updated', updated_at) order by title) from scheduled_tasks) as tasks,
        (select json_agg(json_build_object('owner', user_profile_id, 'updated', updated_at) order by id) from knowledge_documents) as documents`)).rows[0];
}

await check("preview reports the production-shaped plan and changes nothing", async () => {
    const db = await productionShape();
    const before = await snapshot(db);
    const report = await run(db, variant());
    assert.deepEqual(await snapshot(db), before);
    assert.match(lines(report, "mode")[0].target, /^preview only/);
    assert.deepEqual(lines(report, "keep profile"), [{ action: "keep profile", target: `${ids.current} (holds the newest message)`, rows: 1 }]);
    assert.deepEqual(lines(report, "remove profile").map(row => row.target), [
        `${ids.first} created 2026-07-01, own settings kept in the archive`, `${ids.second} created 2026-07-04, own settings kept in the archive`,
        `${ids.seedA} created 2026-08-04, setup seed copy`, `${ids.seedB} created 2026-08-16, setup seed copy`,
    ]);
    assert.deepEqual(lines(report, "move rows").map(row => [row.target, row.rows]), [
        ["conversations.user_profile_id", 1], ["knowledge_documents.user_profile_id", 1], ["messages.user_profile_id", 5],
        ["projects.user_profile_id", 1], ["scheduled_tasks.user_profile_id", 2],
    ]);
    assert.deepEqual(lines(report, "assign ownerless").map(row => [row.target, row.rows]), [["conversations", 3], ["messages", 1]]);
    assert.equal(await count(db, "select count(*) as n from pg_tables where tablename = 'user_profile_merge_archive'"), 0);
});

await check("apply keeps one profile, moves every reference and preserves updated_at", async () => {
    const db = await productionShape();
    const report = await run(db, variant({ apply: true }));
    assert.equal(lines(report, "mode")[0].target, "applied");
    const after = await snapshot(db) as Record<string, { owner: string | null; updated?: string }[] | string[]>;
    assert.deepEqual(after.profiles, [ids.current]);
    for (const key of ["messages", "conversations", "projects", "tasks"]) {
        assert.ok((after[key] as { owner: string }[]).every(row => row.owner === ids.current), `${key} must all belong to the kept profile`);
    }
    assert.deepEqual((after.documents as { owner: string | null }[]).map(row => row.owner), [ids.current, null], "Shared knowledge stays ownerless");
    for (const [key, stamp] of [["conversations", stamps.conversation], ["projects", stamps.project], ["tasks", stamps.task], ["documents", stamps.document]] as const) {
        assert.ok((after[key] as { updated: string }[]).every(row => new Date(row.updated).getTime() === new Date(stamp).getTime()), `${key} updated_at must not change`);
    }
    const kept = (await db.query<{ system_prompt: string; preferences: unknown }>("select system_prompt, preferences from user_profiles")).rows[0];
    assert.deepEqual(kept, { system_prompt: "Current prompt", preferences: {} });
    const archive = (await db.query<{ id: string; system_prompt: string; preferences: unknown; merged_into: string }>(
        "select id, system_prompt, preferences, merged_into from user_profile_merge_archive order by created_at")).rows;
    assert.deepEqual(archive.map(row => row.id), [ids.first, ids.second, ids.seedA, ids.seedB]);
    assert.deepEqual(archive[0], { id: ids.first, system_prompt: "July prompt", preferences: { voice: { voiceName: "Kore" } }, merged_into: ids.current });
    assert.deepEqual(lines(report, "delete profiles").map(row => row.rows), [4]);
    await assert.rejects(db.query("insert into user_profiles (display_name) values ('Second')"), /duplicate key|unique/i);
    await db.query("update conversations set title = 'Renamed' where id = '10000000-0000-4000-8000-000000000005'");
    const renamed = (await db.query<{ updated_at: string }>("select updated_at from conversations where id = '10000000-0000-4000-8000-000000000005'")).rows[0];
    assert.notEqual(new Date(renamed.updated_at).getTime(), new Date(stamps.conversation).getTime(), "updated_at triggers are re-enabled");

    const rerun = await run(db, variant({ apply: true }));
    assert.deepEqual(lines(rerun, "move rows"), []);
    assert.deepEqual(lines(rerun, "assign ownerless").map(row => row.rows), [0, 0]);
    assert.deepEqual(lines(rerun, "delete profiles").map(row => row.rows), [0]);
    assert.deepEqual(lines(rerun, "keep profile").map(row => row.target), [`${ids.current} (holds the newest message)`]);
});

await check("a requested owner overrides the newest-message choice", async () => {
    const db = await productionShape();
    const report = await run(db, variant({ apply: true, owner: ids.first }));
    assert.deepEqual(lines(report, "keep profile").map(row => row.target), [`${ids.first} (requested)`]);
    assert.equal(await count(db, "select count(*) as n from messages where user_profile_id is distinct from $1", [ids.first]), 0);
    await assert.rejects(run(await productionShape(), variant({ owner: "99999999-0000-4000-8000-000000000009" })), /is not a profile/);
});

await check("a failed move leaves every row, profile and trigger as it was", async () => {
    const db = await productionShape();
    await db.exec(`create table profile_settings (user_profile_id uuid primary key references user_profiles(id) on delete cascade, theme text);
        insert into profile_settings values ('${ids.first}', 'dark'), ('${ids.current}', 'light');`);
    const before = await snapshot(db);
    await assert.rejects(run(db, variant({ apply: true })), /Could not move profile_settings\.user_profile_id onto the kept profile/);
    assert.deepEqual(await snapshot(db), before);
    assert.equal(await count(db, "select count(*) as n from pg_trigger where tgname = 'trigger_conversations_updated_at' and tgenabled = 'O'"), 1);
    assert.equal(await count(db, "select count(*) as n from pg_tables where tablename = 'user_profile_merge_archive'"), 0);
});

await check("an empty or already consolidated database is left alone", async () => {
    const empty = await profileTable();
    await empty.exec("create role anon; create role authenticated; create table messages (id uuid primary key, user_profile_id uuid references user_profiles(id), created_at timestamptz); create table conversations (id uuid primary key, user_profile_id uuid references user_profiles(id));");
    assert.deepEqual((await run(empty, variant({ apply: true }))).map(row => row.action), ["mode", "nothing to do"]);
    await empty.exec(seedInsert);
    const single = await run(empty, variant({ apply: true }));
    assert.match(lines(single, "keep profile")[0].target, /\(oldest profile, no messages yet\)$/);
    assert.deepEqual(lines(single, "remove profile"), []);
    assert.equal(await count(empty, "select count(*) as n from pg_indexes where indexname = 'user_profiles_single_owner'"), 1);
});

console.log(`\nOwner profile: ${passed} checks passed. No hosted database was used.`);
