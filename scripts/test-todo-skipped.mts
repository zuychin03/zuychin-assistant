import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { convert } from "telegram-markdown-v2";
import { shortenOnWord } from "../src/lib/short-text";
import { notesReminderText } from "../src/lib/notes-reminder";

let passed = 0;
async function check(name: string, test: () => Promise<void> | void) { await test(); passed++; console.log(`PASS ${name}`); }

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const migration = await read("./migrations/todo-skipped.sql");
const setup = await read("../supabase-setup.sql");

async function database(): Promise<PGlite> {
    const db = new PGlite();
    // The todos status column as supabase-setup.sql creates it.
    await db.exec(`create table todos (id uuid primary key default gen_random_uuid(), title text not null,
        status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')));
        insert into todos (title, status) values ('ticked before', 'done'), ('open', 'pending');`);
    return db;
}

const statements = (sql: string) => sql.replace(/^--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean);

await check("the migration is embedded in setup verbatim with LF endings", () => {
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== Skipped tasks =====\n-- todo-skipped.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed todo-skipped.sql verbatim");
    assert.match(setup, /status text not null default 'pending' check \(status in \('pending', 'in_progress', 'done'\)\)/, "the test table matches setup's todos status column");
});

await check("applied twice, skipped is accepted, other values are refused and ticked tasks stay done", async () => {
    const db = await database();
    try {
        await assert.rejects(db.query("update todos set status = 'skipped' where title = 'open'"), /check/i);
        await db.exec(migration);
        await db.exec(migration);
        await db.query("update todos set status = 'skipped' where title = 'open'");
        await assert.rejects(db.query("update todos set status = 'dropped' where title = 'open'"), /check/i);
        const rows = await db.query<{ title: string; status: string }>("select title, status from todos order by title");
        assert.deepEqual(rows.rows, [{ title: "open", status: "skipped" }, { title: "ticked before", status: "done" }]);
    } finally { await db.close(); }
});

await check("it also works one statement at a time, as a tool that splits the file runs it", async () => {
    const db = await database();
    try {
        for (const sql of [...statements(migration), ...statements(migration)]) await db.exec(sql);
        await db.query("update todos set status = 'skipped' where title = 'open'");
    } finally { await db.close(); }
});

await check("titles are cut on a whole word with an ellipsis, and short ones are left alone", () => {
    assert.equal(shortenOnWord("  Read   the water bill ", 56), "Read the water bill");
    assert.equal(shortenOnWord("What monitoring detects idempotency violations in live traffic?", 56), "What monitoring detects idempotency violations in live…");
    assert.equal(shortenOnWord("alpha beta gamma delta, epsilon", 23), "alpha beta gamma delta…");
    assert.equal(shortenOnWord("Supercalifragilisticexpialidocious", 10), "Supercalif…");
    const cut = "Follow up: " + shortenOnWord("What minimal CI/CD gates prevent regression of the new permission-boundary and execution guards?", 80);
    assert.equal(cut, "Follow up: What minimal CI/CD gates prevent regression of the new permission-boundary and…");
});

await check("the reminder lists three tasks, drops the Follow up prefix and counts the rest", () => {
    assert.equal(notesReminderText([]), "");
    const one = notesReminderText([{ title: "Pay fee notice" }]);
    assert.match(one, /First chat of the day: 1 task has no date\.\n\n- Pay fee notice\n\nIn the Notes panel, tick off what is done or skip what you won't do\.$/);
    const titles = [
        "Follow up: What minimal CI/CD gates prevent regression of the new permission‑boundary and e",
        "Follow up: Can loop‑termination guards be expressed in a language‑agnostic way across heter",
        "Follow up: What monitoring detects idempotency violations in live traffic?",
        ...Array.from({ length: 21 }, (_, index) => ({ title: `Task ${index}` })).map((task) => task.title),
    ].map((title) => ({ title }));
    const text = notesReminderText(titles);
    assert.match(text, /^\n\n---\n📌 First chat of the day: 24 tasks have no date\.\n\n/);
    const bullets = text.split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(bullets, [
        "- What minimal CI/CD gates prevent regression of the new…",
        "- Can loop‑termination guards be expressed in a…",
        "- What monitoring detects idempotency violations in live…",
    ]);
    assert.match(text, /\n\nand 21 more\. In the Notes panel, tick off what is done or skip what you won't do\.$/);
    const telegram = convert(text);
    assert.equal(telegram.split("\n").filter((line) => line.startsWith("•")).length, 3, "Telegram shows the list as bullets");
});

console.log(`\n${passed} skipped task checks passed.`);
