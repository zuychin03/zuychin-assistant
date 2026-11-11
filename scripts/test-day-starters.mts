import assert from "node:assert/strict";
import { dayStarters, FIXED_STARTERS, STARTER_COUNT } from "../src/app/home/day-starters";
import type { TodayResponse } from "../src/lib/today";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const now = local(11, 9, 30);
const iso = (date: Date) => date.toISOString();
const empty: TodayResponse = { dueTodos: [], todos: [], events: [] };
let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }

check("nothing on falls back to the fixed set", () => {
    assert.deepEqual(dayStarters(empty, 0, now), FIXED_STARTERS);
    assert.deepEqual(dayStarters(null, 0, now), FIXED_STARTERS);
});

check("live starters lead and the fixed set tops the list up to five", () => {
    const starters = dayStarters({
        events: [{ summary: "Team sync", start: iso(local(11, 14)) }],
        dueTodos: [{ id: "a", title: "Pay electricity bill", priority: "high", dueDate: "2026-11-11" }],
        todos: [],
    }, 6, now);
    assert.deepEqual(starters.map((starter) => starter.kind), ["event", "due", "study", "plan", "inbox"]);
    assert.equal(starters.length, STARTER_COUNT);
    assert.deepEqual(starters[0], { kind: "event", label: "Prepare for Team sync", meta: "14:00", fill: "Help me prepare for “Team sync” at 14:00." });
    assert.deepEqual(starters[1], { kind: "due", label: "Pay electricity bill", meta: "Due today", tone: "accent", fill: "Help me get “Pay electricity bill” done. It is due today." });
    assert.deepEqual(starters[2], { kind: "study", label: "Review 6 study cards", meta: "Study", href: "/study" });
    assert.equal(dayStarters(empty, 1, now)[0].label, "Review 1 study card");
});

check("the next event is the earliest timed one still to start", () => {
    const [first] = dayStarters({ ...empty, events: [
        { summary: "Birthday", start: "2026-11-11" },
        { summary: "Stand-up", start: iso(local(11, 9)) },
        { summary: "Dentist", start: iso(local(12, 10, 15)), location: "Main St" },
        { summary: "Lecture", start: iso(local(13, 9)) },
    ] }, 0, now);
    assert.equal(first.label, "Prepare for Dentist");
    assert.equal(first.meta, "Tomorrow 10:15");
    assert.equal(first.fill, "Help me prepare for “Dentist” tomorrow at 10:15, at Main St.");
    const later = dayStarters({ ...empty, events: [{ summary: "Lecture", start: iso(local(13, 9)) }] }, 0, now)[0];
    assert.match(later.meta ?? "", /^Fri 09:00$/);
});

check("the most urgent to-do comes from either list, overdue first, then priority", () => {
    const [first] = dayStarters({ ...empty,
        dueTodos: [{ id: "a", title: "Submit report", priority: "low", dueDate: "2026-11-12" }],
        todos: [
            { id: "b", title: "Renew licence", priority: "medium", dueDate: iso(local(10, 17)) },
            { id: "c", title: "Book flights", priority: "high", dueDate: null },
        ] }, 0, now);
    assert.deepEqual(first, { kind: "due", label: "Renew licence", meta: "Overdue", tone: "danger", fill: "Help me get “Renew licence” done. It is overdue." });
    const tie = dayStarters({ ...empty, todos: [
        { id: "d", title: "Low one", priority: "low", dueDate: "2026-11-12" },
        { id: "e", title: "High one", priority: "high", dueDate: "2026-11-12" },
    ] }, 0, now)[0];
    assert.equal(tie.label, "High one");
    assert.equal(tie.meta, "Due tomorrow");
    assert.equal(tie.tone, undefined);
});

check("to-dos due after tomorrow or overdue for over a week stay out", () => {
    const starters = dayStarters({ ...empty, todos: [
        { id: "f", title: "Later", priority: "high", dueDate: "2026-11-13" },
        { id: "g", title: "Pay gas bill", priority: "high", dueDate: "2026-09-02" },
        { id: "h", title: "Old enrolment", priority: "high", dueDate: iso(local(4, 9)) },
    ] }, 0, now);
    assert.deepEqual(starters, FIXED_STARTERS);
    assert.equal(dayStarters({ ...empty, todos: [{ id: "i", title: "Upgrade account", priority: "medium", dueDate: "2026-11-08" }] }, 0, now)[0].label, "Upgrade account");
});

console.log(`Day starters: ${passed} checks passed.`);
