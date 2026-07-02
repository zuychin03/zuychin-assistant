# Vault Schema — Zuychin Assistant Second Brain

This file is the contract between the human and the agent. The agent reads it before every ingest, query, or lint. It defines the structure, conventions, and workflows of this knowledge base.

Modelled on Andrej Karpathy's LLM-Wiki pattern: synthesis happens **once, at ingest, and is persisted** — not re-derived on every query.

## Roles

- **The human** curates sources, directs analysis, and asks good questions.
- **The agent** does everything else: reading sources, writing pages, cross-linking, keeping the index and log current, and flagging contradictions.

## Layout

```
raw/      Immutable original sources (papers, articles, transcripts, notes). Read-only. Never edited.
wiki/     Agent-authored Markdown pages. The only place the agent writes knowledge.
index.md  Catalogue: every wiki page with a one-line summary, grouped by category. Read this FIRST.
log.md    Append-only chronicle of every ingest / query-writeback / lint.
agents.md This file.
```

### Page categories (under `wiki/`)

- `wiki/sources/` — one page per ingested source: summary, key claims, citations back to the `raw/` file.
- `wiki/concepts/` — durable ideas, methods, definitions.
- `wiki/entities/` — people, tools, projects, organisations.
- `wiki/synthesis/` — cross-source articles that answer a question or connect multiple concepts.

## Page conventions

Every wiki page starts with frontmatter:

```markdown
---
title: <Human-readable title>
category: sources | concepts | entities | synthesis
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [raw/<file>.md]        # for source/synthesis pages
---

# <Title>

<body with [[wikilinks]] to related pages>
```

- Link related pages with `[[wiki/concepts/page-name]]` (path without `.md`). Links are **bidirectional**: if A links to B, B should link back to A.
- Keep claims cited. A claim from a source links to the `wiki/sources/` page (and thus to the `raw/` file).
- Filenames are lowercase kebab-case.

## Workflows

### INGEST (add a source)
1. Write the original to `raw/<slug>.md` (or store the URL if the body is large). Never modify it afterwards.
2. Create `wiki/sources/<slug>.md`: summary, key claims, citations.
3. **Auto-link:** the assistant embeds the new page and retrieves semantically similar existing pages (pgvector doc↔doc, cosine ≳ 0.40 — a generous proposal net; the LLM curator does the real selection). For each genuine relationship, add a labelled `[[wikilink]]` in BOTH pages (e.g. "extends", "contradicts", "example-of"). Discard weak/spurious candidates.
4. Update `index.md` (add the new page under its category with a one-line summary).
5. Append to `log.md`: `## [YYYY-MM-DD] ingest | <title>`.
6. **Verify before commit:** an independent check confirms the summary is faithful to the source and citations resolve. If it fails, do not commit.
7. Commit only the touched paths with a `learn:` prefix, e.g. `learn: ingest <title>`.

### QUERY (answer a question)
1. Read `index.md`, open the relevant pages, answer with citations.
2. If the answer is durable and worth keeping, file it back as a `wiki/synthesis/` page (run auto-link + index + log), committed with `learn: synthesis <question>`.

### LINT (periodic health check)
- Find orphan pages (no inbound links), contradictions, stale claims, and missing back-references.
- In `suggest` mode: report findings only. In `auto` mode: fix low-risk issues (add missing back-links, prune dead links), verify, then commit with a `curator:` prefix.
- Log the pass in `log.md`.

## Commit message conventions

- `learn: …` — new knowledge from ingest or query-writeback.
- `curator: …` — lint/maintenance edits.
- `chore: …` — structural/template changes (not knowledge).

Only ever stage the specific paths a change touched. Git history is the safety net — a bad write is one revert away.
