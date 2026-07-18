import assert from "node:assert/strict";
import { chunkMarkdown } from "../src/lib/knowledge/chunker.ts";
import { computeKnowledgeScore, groundRecall } from "../src/lib/knowledge/recall.ts";
import type { KnowledgeRecallHit } from "../src/lib/knowledge/types.ts";
import { parseFrontmatter, serializeFrontmatter } from "../src/lib/knowledge/markdown.ts";
import { safeVaultPath } from "../src/lib/knowledge/paths.ts";

const markdown = `---
title: Retrieval Test
---

# Overview

A short introduction about semantic retrieval and citations.

## Implementation

The index keeps fenced code intact.

\`\`\`ts
export function search(query: string) {
    return query.trim();
}
\`\`\`

A second paragraph explains hybrid keyword and vector retrieval.

## Operations

Evergreen procedures remain available even when they have not been accessed recently.
`;

const chunks = chunkMarkdown({
    documentId: "zuychin-test",
    path: "wiki/concepts/retrieval-test.md",
    markdown,
    options: { targetTokens: 35, overlapTokens: 8, maxTokens: 80 },
});

assert.ok(chunks.length >= 3, "heading-aware chunking should create multiple chunks");
assert.ok(chunks.some((chunk) => chunk.heading === "Implementation"), "headings must be retained");
assert.ok(
    chunks.some((chunk) => chunk.content.includes("export function search") && chunk.content.includes("}\n\`\`\`")),
    "fenced code must remain intact",
);
assert.ok(chunks.every((chunk, index) => chunk.ordinal === index), "chunk ordinals must be deterministic");
assert.equal(
    chunks.map((chunk) => chunk.id).join(","),
    chunkMarkdown({
        documentId: "zuychin-test",
        path: "wiki/concepts/retrieval-test.md",
        markdown,
        options: { targetTokens: 35, overlapTokens: 8, maxTokens: 80 },
    }).map((chunk) => chunk.id).join(","),
    "the same document must produce stable chunk ids",
);

const evergreen = computeKnowledgeScore({
    semantic: 0.8,
    lexical: 0.5,
    kind: "procedural",
    trust: "trusted",
    ageDays: 2000,
});
assert.equal(evergreen.freshness, 1, "procedural knowledge must not decay");

const episodic = computeKnowledgeScore({
    semantic: 0.8,
    lexical: 0.5,
    kind: "episodic",
    trust: "reviewed",
    ageDays: 2000,
});
assert.ok(episodic.freshness < 0.01, "old episodic knowledge should receive a freshness penalty");

const hit: KnowledgeRecallHit = {
    documentId: "zuychin-test",
    chunkId: chunks[0].id,
    path: "wiki/concepts/retrieval-test.md",
    title: "Retrieval Test",
    heading: "Overview",
    excerpt: "Semantic retrieval combines vector and keyword evidence.",
    category: "concepts",
    score: evergreen,
    provenance: [],
};

const obsidian = parseFrontmatter(`---
title: Portable Note
aliases:
  - Portable
plugin_data:
  nested: true
tags:
  - knowledge
  - obsidian
---

# Portable Note
`);
assert.deepEqual(obsidian.attributes.aliases, ["Portable"]);
assert.deepEqual(obsidian.attributes.tags, ["knowledge", "obsidian"]);
obsidian.attributes.zuychin_id = "zuychin-portable";
obsidian.attributes.status = "active";
const portable = serializeFrontmatter(obsidian);
assert.match(portable, /aliases:\n  - Portable/);
assert.match(portable, /plugin_data:\n  nested: true/);
assert.match(portable, /tags: \[knowledge, obsidian\]/);
assert.match(portable, /zuychin_id: zuychin-portable/);


assert.equal(groundRecall("How does semantic retrieval work?", [hit]).supported, true);
const unrelated = { ...hit, score: { ...hit.score, semantic: 0.1 } };
assert.equal(groundRecall("What is the payroll password?", [unrelated], 0.8).supported, false);
assert.equal(safeVaultPath("Notes\\Research.md"), "Notes/Research.md");
assert.throws(() => safeVaultPath("../secrets.md"));
assert.throws(() => safeVaultPath(".git/config"));


console.log(`Knowledge evaluation passed: ${chunks.length} chunks, grounding and decay checks verified.`);
