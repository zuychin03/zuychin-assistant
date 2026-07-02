# Zuychin Assistant — Second Brain Vault

This is the seed for the private GitHub repository that backs the assistant's second brain (a Karpathy-style LLM Wiki). Push these files to a **private** repo, then point the assistant at it with `GITHUB_VAULT_REPO` / `GITHUB_VAULT_TOKEN`.

- `agents.md` — the schema the agent obeys (read this first).
- `index.md` — the page catalogue.
- `log.md` — the append-only history.
- `raw/` — immutable sources (agent reads, never edits).
- `wiki/` — agent-authored, interlinked Markdown pages.

You can open the same repo in Obsidian as an optional graph viewer — it is never a runtime dependency.
