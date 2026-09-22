import assert from "node:assert/strict";
import { test } from "node:test";
import {
    buildAdjacency, deriveVisible, localNodeIds, readCategories, visiblePath, writeCategories,
    type ApiGraph, type GLink, type GNode, type VisibleParams,
} from "../src/app/graph/cosmos/model";
import { CATEGORIES } from "../src/app/graph/cosmos/palette";

const node = (id: string, overrides: Partial<GNode> = {}): GNode => ({
    id, title: id, category: "concepts", summary: "", links: 1, updated: null,
    created: "2026-01-02", trust: "trusted", status: "active", scope: "user",
    sensitivity: "private", kind: "note", cluster: 0, centrality: 0.5,
    words: 20, health: [], dangling: 0, ...overrides,
});

const data: ApiGraph = {
    nodes: [
        node("root"), node("near", { category: "sources" }), node("two-hops"),
        node("three-hops"), node("unrelated", { links: 0, health: ["orphan"] }),
    ],
    edges: [
        { source: "root", target: "near", mutual: true },
        { source: "near", target: "two-hops", mutual: true },
        { source: "two-hops", target: "three-hops", mutual: true },
    ],
    suggestions: [{ source: "root", target: "unrelated", similarity: 0.8 }],
    clusters: [], health: { orphan: 1, stale: 0, dangling: 0, malformed: 0, unreviewed: 0 },
    builtAt: "2026-01-03T00:00:00Z",
};

function slice(overrides: Partial<VisibleParams> = {}) {
    return deriveVisible({
        data, adjacency: buildAdjacency(data.edges), categoryFilter: {}, showOrphans: true,
        showSuggestions: true, localRoot: null, localDepth: 1, timeCutoff: null,
        onlyFindings: null, onlyTrust: null, nodeCache: new Map(), linkCache: new Map(),
        ...overrides,
    });
}

test("all category combinations survive the share URL", () => {
    for (let mask = 0; mask < 2 ** CATEGORIES.length; mask++) {
        const filter = Object.fromEntries(CATEGORIES.map((category, index) => [category, Boolean(mask & (1 << index))]));
        const encoded = writeCategories(filter);
        const params = new URLSearchParams();
        if (encoded !== null) params.set("cat", encoded);
        const restored = readCategories(new URLSearchParams(params.toString()).get("cat"));
        for (const category of CATEGORIES) assert.equal(restored[category] !== false, filter[category]);
    }
});

test("disabling one category preserves untouched categories", () => {
    const restored = readCategories(writeCategories({ sources: false }));
    assert.equal(restored.sources, false);
    for (const category of CATEGORIES.filter((item) => item !== "sources")) assert.equal(restored[category], true);
    assert.equal(writeCategories({ sources: true }), null);
    assert.deepEqual(readCategories(null), {});
});

test("a hidden or deleted local root cannot reveal unrelated stars", () => {
    const cases: Partial<VisibleParams>[] = [
        { categoryFilter: { concepts: false } },
        { timeCutoff: Date.parse("2026-01-01") },
        { onlyFindings: ["orphan"] },
        { onlyTrust: ["unreviewed"] },
        { localRoot: "deleted" },
    ];
    for (const filters of cases) {
        const visible = slice({ localRoot: "root", ...filters });
        assert.deepEqual(visible.nodes, []);
        assert.deepEqual(visible.links, []);
    }
});

test("local depth remains bounded while filters hide intermediate stars", () => {
    assert.deepEqual([...localNodeIds("root", 1, buildAdjacency(data.edges))], ["root", "near"]);
    const visible = slice({ localRoot: "root", localDepth: 2, categoryFilter: { sources: false } });
    assert.deepEqual(visible.nodes.map((item) => item.id), ["root", "two-hops"]);
    assert.deepEqual(visible.links, []);
});

test("routes use only visible real links", () => {
    assert.deepEqual(visiblePath("root", "two-hops", slice()), ["root", "near", "two-hops"]);
    assert.deepEqual(visiblePath("root", "two-hops", slice({ categoryFilter: { sources: false } })), []);
    assert.deepEqual(visiblePath("root", "three-hops", slice({ localRoot: "root", localDepth: 1 })), []);
    assert.deepEqual(visiblePath("root", "unrelated", slice()), []);
    assert.deepEqual(visiblePath("deleted", "deleted", slice()), []);
    assert.deepEqual(visiblePath("unrelated", "unrelated", slice()), ["unrelated"]);
});

test("cached positions and resolved link endpoints survive filter changes", () => {
    const nodeCache = new Map<string, GNode>();
    const linkCache = new Map<string, GLink>();
    const first = slice({ nodeCache, linkCache });
    first.nodes[0].x = 42;
    first.links[0].source = first.nodes[0];
    first.links[0].target = first.nodes[1];
    slice({ nodeCache, linkCache, categoryFilter: { sources: false } });
    const restored = slice({ nodeCache, linkCache });
    assert.equal(restored.nodes[0], first.nodes[0]);
    assert.equal(restored.nodes[0].x, 42);
    assert.deepEqual(visiblePath("root", "two-hops", restored), ["root", "near", "two-hops"]);
});
