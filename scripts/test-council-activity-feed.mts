import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { appendActivity, type HostActivity } from "../src/app/council/host-client.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/council/activity-feed.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const loaded = { exports: {} as { ActivityFeed: React.ComponentType<Record<string, unknown>> } };
runInNewContext(output, { exports: loaded.exports, module: loaded, require, Map });

let clock = 0;
const event = (agent: string, kind: string, detail: string): HostActivity => ({ agent, kind, detail, at: new Date(Date.UTC(2026, 9, 6, 0, 0, clock++)).toISOString() });
const feed = (events: HostActivity[]) => events.reduce(appendActivity, [] as HostActivity[]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("streamed words from one agent become one entry", () => {
    const list = feed(["checks", " required", " the", " run"].map((word) => event("codex-1", "agent_message_chunk", word)));
    assert.equal(list.length, 1);
    assert.equal(list[0].detail, "checks required the run");
});

test("chunks only join the same agent and the same kind", () => {
    const list = feed([
        event("codex-1", "agent_message_chunk", "one"),
        event("claude-a", "agent_message_chunk", "two"),
        event("claude-a", "agent_thought_chunk", "three"),
        event("claude-a", "agent_message_chunk", " four"),
    ]);
    assert.deepEqual(list.map((item) => item.detail), ["one", "two", "three", " four"]);
});

test("id-only updates, session noise and empty rows are dropped", () => {
    const list = feed([
        event("codex-1", "tool_call_update", "call_8f2"),
        event("codex-1", "usage_update", ""),
        event("host", "log", "  "),
        event("codex-1", "tool_call", "npm run lint"),
    ]);
    assert.deepEqual(list.map((item) => item.kind), ["tool_call"]);
});

test("the feed keeps its newest entries and the tail of a long reply", () => {
    const list = feed(Array.from({ length: 200 }, (_, i) => event("host", "log", `line ${i}`)));
    assert.equal(list.length, 150);
    assert.equal(list.at(-1)?.detail, "line 199");
    const long = feed([event("codex-1", "agent_message_chunk", "x".repeat(5000)), event("codex-1", "agent_message_chunk", "y".repeat(2000))]);
    assert.equal(long[0].detail.length, 6000);
    assert.ok(long[0].detail.endsWith("y".repeat(2000)));
});

test("the rendered feed reads as sentences, tool lines and what each agent is doing", () => {
    const list = feed([
        event("codex-1", "agent_thought_chunk", "weighing the merge order"),
        ...["Both", " merges", " fast-forwarded."].map((word) => event("codex-1", "agent_message_chunk", word)),
        event("codex-1", "tool_call", "npm run lint"),
        event("codex-1", "tool_call_update", "call_8f2"),
        event("claude-a", "agent_exit", "exited (1)"),
    ]);
    const html = renderToStaticMarkup(createElement(loaded.exports.ActivityFeed, {
        activity: list, agents: [{ name: "codex-1", state: "busy" }, { name: "claude-a", state: "idle" }],
    }));
    const visible = text(html);
    assert.match(visible, /Both merges fast-forwarded\./);
    assert.match(html, /<details[^>]*><summary>/);
    assert.match(html, /<code[^>]*>npm run lint<\/code>/);
    assert.match(visible, /codex-1 running npm run lint/);
    assert.match(visible, /claude-a idle/);
    assert.match(visible, /claude-a exited \(1\)/);
    for (const raw of ["agent_message_chunk", "tool_call_update", "call_8f2"]) assert.ok(!html.includes(raw), raw);
});

test("an empty feed renders nothing", () => {
    assert.equal(renderToStaticMarkup(createElement(loaded.exports.ActivityFeed, { activity: [], agents: [] })), "");
});
