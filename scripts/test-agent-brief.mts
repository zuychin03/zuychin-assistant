import assert from "node:assert/strict";
import { CLAIM_PLACEHOLDER, knowledgeAgentSetup } from "../src/lib/agents/brief.ts";

let passed = 0;
let failed = 0;
function check(name: string, test: () => void): void {
    try {
        test();
        passed++;
        console.log(`ok ${name}`);
    } catch {
        failed++;
        console.error(`FAIL ${name}`);
    }
}

const brief = knowledgeAgentSetup({ baseUrl: "https://knowledge.example.invalid", claim: "zkc_fixture_claim" });
const text = brief.replace(/\s+/g, " ");

check("the brief targets the supplied endpoint and claim, with a pasteable fallback", () => {
    assert(brief.includes("https://knowledge.example.invalid/api/agent/claim"));
    assert(brief.includes("https://knowledge.example.invalid/api/mcp/mcp"));
    assert(brief.includes("zkc_fixture_claim"));
    assert(knowledgeAgentSetup({ baseUrl: "https://other.example.invalid" }).includes(CLAIM_PLACEHOLDER));
    assert(!brief.includes(CLAIM_PLACEHOLDER));
});

check("claim exchange keeps the durable credential out of output and command arguments", () => {
    assert.match(text, /capture the response privately in (?:process )?memory/i);
    assert.match(text, /write (?:the )?key directly to (?:your |the )?client config/i);
    assert.match(text, /do not (?:print|emit).*response.*(?:chat|logs)/i);
    assert.match(text, /never.*(?:command-line arguments|argv)/i);
    assert(!/\bcurl\b|claude mcp add/i.test(text));
});

check("migration replaces the same-endpoint credential and preserves unrelated servers", () => {
    assert.match(text, /replace.*existing.*credential/i);
    assert.match(text, /same (?:MCP )?endpoint/i);
    assert.match(text, /(?:do not|never) add a duplicate/i);
    assert.match(text, /preserve unrelated (?:MCP )?servers/i);
    assert(!/leave it alone and add.*beside/i.test(text));
});

check("all four access levels accurately describe increasing knowledge and convening authority", () => {
    assert.match(text, /read\s+read-only.*search and read/i);
    assert.match(text, /notes\s+notes read\/write.*save_note.*update_note.*delete_note/i);
    assert.match(text, /full\s+full read\/write.*vault_ingest.*vault_write/i);
    assert.match(text, /council\s+full read\/write.*convene.*council:owner/i);
    assert.match(text, /read, notes and full cannot convene/i);
    assert(!/no key issued this way can convene/i.test(text));
});

check("Council owner access does not replace seat or dedicated host credentials", () => {
    assert.match(text, /participation.*separate.*seat credential.*council:seat/i);
    assert.match(text, /host.*dedicated.*credential.*council:host/i);
    assert.match(text, /this key grants neither seat nor host authority/i);
});

check("setup verification remains read-only even for a Council-capable client", () => {
    assert.match(text, /call search_knowledge once with a harmless query/i);
    assert.match(text, /do not.*(?:write|mutate).*convene.*test/i);
    assert.match(text, /tool visibility.*(?:does not|is not).*access/i);
    assert.match(text, /accessLevel.*(?:claim response|response)/i);
});

check("the report requests useful migration evidence without config contents or secrets", () => {
    assert.match(text, /report.*config (?:file )?path/i);
    assert.match(text, /report.*access level.*(?:result|proof)/i);
    assert.match(text, /(?:do not|never).*config contents/i);
    assert.match(text, /(?:do not|never).*claim.*key.*authorization header/i);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
