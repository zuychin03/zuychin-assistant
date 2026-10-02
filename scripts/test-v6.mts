import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = [
    "knowledge-only-chat",
    "free-only-chat",
    "stream-usage",
    "document-continuity",
    "markdown-reader",
    "chat-ux",
    "chat-free-selection",
    "chat-preferences",
    "chat-preference-race",
    "provider-registry",
    "model-picker",
    "shared-control-accessibility",
    "anchored-menu",
    "cosmos-label-layout",
    "graph-mutation-state",
    "scheduled-task-models",
    "kilo-adapter",
    "model-observations",
    "model-health",
    "seat-key-load-gate",
    "admin-panel-state",
    "conversation-context",
    "gemini-chat-stream",
    "reply-trace",
    "reply-trace-ui",
    "chat-late-cancel",
    "conversation-branches",
    "branch-request",
    "resume-scope",
    "research-workbench",
    "research-draft-guards",
    "research-capacity",
    "study-scheduler",
    "study-service",
    "study-pending",
    "study-review-attempt",
    "study-draft-guards",
    "study-settings-draft",
    "unsaved-changes",
    "capture-clear-confirmation",
    "capture-inbox",
    "capture-routes",
    "offline-library",
    "offline-shell",
    "offline-privacy",
    "offline-reader-ui",
    "knowledge-revisions",
    "knowledge-revision-routes",
    "knowledge-revision-github",
    "workspace-recovery",
    "unattended-policy",
    "scheduled-safety",
    "tasks-ui",
    "task-run-request",
    "data-routing",
    "vault-model-observations",
    "speech-observations",
    "approval-observations",
    "jev-decisions",
    "owner-profile",
    "server-only-tables",
    "v6-migrations"
];
const failed: string[] = [];
for (const test of tests) {
    console.log(`\nV6 suite: ${test}`);
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", `scripts/test-${test}.mts`], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed.push(test);
}
if (failed.length) { console.error(`Failed V6 suites: ${failed.join(", ")}`); process.exit(1); }
console.log(`\n${tests.length} V6 regression suites passed. No live services were exercised.`);
