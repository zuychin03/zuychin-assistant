import type { ResearchEntry, ResearchQuestion, ResearchSource, ResearchWorkspace } from "../src/lib/research/contracts";

export const researchFixtureMarkdown = "# Retrieval methods\n\nThe experiment compared keyword retrieval with dense retrieval on a held-out set of 120 questions.\n\nDense retrieval improved answer accuracy by 5 percentage points.\n\nLimitations include a small single-domain dataset and no user study.\n";
const questionId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
const projectId = "99999999-9999-4999-8999-999999999999", documentId = "fixture-retrieval-paper", sha = "a".repeat(40);
const quote = "Dense retrieval improved answer accuracy by 5 percentage points.";
const source: ResearchSource = { id: sourceId, questionId, documentId, path: "wiki/research/retrieval-methods.md", commitSha: sha, contentHash: "b".repeat(64), title: "Retrieval methods study", version: 1, removedAt: null };
export const researchFixtureWorkspace: ResearchWorkspace = {
    question: { id: questionId, projectId, title: "When does dense retrieval improve answers?", question: "Compare retrieval methods, evaluation findings and limitations before choosing an approach for a small knowledge library.", status: "active", version: 1, updatedAt: "2026-09-28T00:00:00Z" },
    sources: [source], documents: [{ id: documentId, path: source.path, title: source.title, project_id: projectId, scope: "project", status: "active" }],
    entries: [{ id: "33333333-3333-4333-8333-333333333333", questionId, sourceId, kind: "finding", text: "Dense retrieval improved accuracy in the reported evaluation. The result may not generalise to our documents.", version: 1, updatedAt: "2026-09-28T00:00:00Z",
        evidence: { version: 1, documentId, path: source.path, commitSha: sha, contentHash: source.contentHash, quote, quoteHash: "c".repeat(64), startOffset: researchFixtureMarkdown.indexOf(quote), endOffset: researchFixtureMarkdown.indexOf(quote) + quote.length } },
    { id: "44444444-4444-4444-8444-444444444444", questionId, sourceId: null, kind: "interpretation", text: "My interpretation: test both methods on our own question set before adopting either.", evidence: null, version: 1, updatedAt: "2026-09-28T00:00:00Z" }],
};

export function installResearchFixture() {
    const originalFetch = window.fetch.bind(window), workspace = structuredClone(researchFixtureWorkspace);
    const questions = [workspace.question];
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "X-Research-Profile": "77777777-7777-4777-8777-777777777777" } });
    const raw = (row: ResearchEntry | ResearchSource | ResearchQuestion) => ({ ...row, ...("sourceId" in row ? { source_id: row.sourceId } : {}) });
    let conflictNext = false;
    window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
        if (!url.pathname.startsWith("/api/research")) return originalFetch(input, init);
        const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : {};
        if (method === "GET") {
            if (url.pathname.endsWith("/sources")) return json({ source: workspace.sources.find((item) => item.id === url.searchParams.get("sourceId")), markdown: researchFixtureMarkdown });
            if (url.searchParams.has("questionId")) {
                const question = questions.find((item) => item.id === url.searchParams.get("questionId"));
                return json({ ...workspace, question: question ?? workspace.question, ...(question?.id !== questionId ? { sources: [], entries: [] } : {}) });
            }
            return json({ projects: [{ id: projectId, name: "Personal AI study" }], questions });
        }
        if (url.pathname.endsWith("/sources")) {
            const existing = workspace.sources.find((item) => item.id === body.id) ?? workspace.sources[0];
            if (method === "PATCH") {
                if (conflictNext || body.version !== existing.version) { conflictNext = false; existing.version++; existing.title = "Label updated in another session"; return json({ error: "This source changed. Your draft is retained.", current: raw(existing) }, 409); }
                Object.assign(existing, { title: body.title ?? existing.title, removedAt: body.remove ? new Date().toISOString() : existing.removedAt, version: existing.version + 1 });
            } else existing.removedAt = null;
            return json({ source: existing });
        }
        if (url.pathname.endsWith("/entries")) {
            const existing = workspace.entries.find((item) => item.id === body.id);
            if (existing && (conflictNext || body.version !== existing.version)) { conflictNext = false; existing.version++; existing.text = "Saved note changed in another session."; return json({ error: "This note changed. Your draft is retained.", current: raw(existing) }, 409); }
            if (method === "DELETE") { workspace.entries = workspace.entries.filter((item) => item.id !== body.id); return json({ deleted: true }); }
            const evidence = body.kind === "interpretation" ? null : { version: 1 as const, documentId, path: source.path, commitSha: sha, contentHash: source.contentHash, quote: body.quote, quoteHash: "d".repeat(64), startOffset: body.startOffset, endOffset: body.startOffset + body.quote.length };
            const entry: ResearchEntry = { ...body, sourceId: body.sourceId ?? null, evidence, version: (existing?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
            if (existing) Object.assign(existing, entry); else workspace.entries.push(entry);
            return json({ entry });
        }
        const existing = questions.find((item) => item.id === body.id);
        if (existing && (conflictNext || body.version !== existing.version)) { conflictNext = false; existing.version++; return json({ error: "This question changed. Your draft is retained.", current: raw(existing) }, 409); }
        const question: ResearchQuestion = { ...body, version: (existing?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, question); else questions.push(question);
        return json({ question });
    };
    return { conflictNext: () => { conflictNext = true; }, reset: () => { window.fetch = originalFetch; } };
}
