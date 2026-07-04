# Zuychin Assistant

A personal AI chatbot you can talk to from the web, Discord, or Telegram. It lets you
switch chat model providers per message (Google Gemini, OpenRouter, NVIDIA NIM, OpenCode Zen),
keeps long-term memory with a pgvector RAG store, handles file uploads, and can use a set of
tools (Google Calendar, Gmail, a to-do list and a knowledge base) plus Google Search and Maps
grounding. Its second-brain wiki vault comes with an interactive Obsidian-style 3D graph view
where pages and links can be inspected, edited and deleted in place.

## Features

- Multi-provider chat: switch the model per message between Gemini, OpenRouter (Nemotron,
  Laguna M.1, Gemma 4), NVIDIA NIM (MiniMax M3, DeepSeek V4, Gemma 4) and OpenCode Zen (MiMo),
  straight from the chat header
- RAG memory: a model-aware pgvector store. Each embedding model keeps its own memory
  partition (Gemini 768-dim, Nemotron 2048-dim), with rerank, summarization and dedup
- Chat history: conversation sidebar with auto-titling and full CRUD
- File upload: images, audio, video, PDFs and code/text files (up to 20 MB)
- MCP tools: 18 tools covering calendar, Gmail, a to-do list, notes, knowledge search,
  the second-brain vault, current time and recent conversations
- Agent mode: complex requests are auto-routed (or forced with the agent switch / `/agent`)
  to a multi-step agent loop with live step streaming, parallel sub-agents, reusable skills
  and downloadable artifacts (documents, code files, zip bundles). Sub-agents default to
  free fast models (DeepSeek V4 Flash, Step 3.7 Flash, any Fast-tagged tool-capable model)
  with Gemini only as the fallback
- Slash commands: type `/` in the message bar for a drop-up of 20 ready-made commands
  (`/plan_day`, `/triage_emails`, `/research`, `/code`, `/debug`, `/vault_save`, …) that
  expand into full prompts — skill-backed ones force the agent loop
- Notes checklist: a collapsible panel lists the agent's undated notes/tasks; ticking a box
  completes the task and the agent never reminds you about it again. Pending undated tasks
  are surfaced once a day, at the end of the first reply
- Second brain: a Karpathy-style LLM-wiki in a private GitHub repo — the agent ingests
  research into interlinked Markdown pages (auto-linked via pgvector + LLM curation,
  verified before every commit) and a lint curator keeps the graph healthy
- 3D knowledge graph: an Obsidian-style force-directed graph of the vault at `/graph` —
  rotate/zoom, search with camera fly-to, category filters, local mode, physics sliders,
  AI-suggested links, and click-to-edit/delete pages and connections with every change
  landing as an atomic Git commit
- Web search: Gemini grounds answers with real-time Google Search (inline citations + URL context); the other models get a `search_web` tool so they can pull live info too, automatically or on demand with `/search`
- Maps grounding: location questions get routed to Google Maps (places, directions, hours)
- Date awareness: the current date/time (in your timezone) is injected into the model's context on every request, so it doesn't guess the date when discussing plans or schedules
- Think mode: a deep-reasoning toggle (`/think`), tunable per model
- Hyperparameters: optional temperature / top-p / max-tokens controls in the header
- Dark / light mode: theme toggle that remembers your choice and respects the system setting
- Multi-channel: web UI, Discord bot and Telegram bot all share the same RAG pipeline
- Cron jobs: daily briefing (LLM-triaged inbox — only the emails that matter, icon-coded
  by urgency), event reminders and proactive check-ins
- Export: save conversations to PDF or DOCX (Markdown-aware)
- Admin dashboard: stats and a live personality/system-prompt editor at `/admin`
- Password auth: cookie-based access control via the auth proxy

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Chat models | Gemini 3.5 / 3 Flash, OpenRouter (Nemotron, Laguna M.1, Gemma 4), NVIDIA NIM (MiniMax M3, DeepSeek V4, Gemma 4), OpenCode Zen (MiMo, DeepSeek) |
| Embeddings | Gemini Embedding 2 (768d), NVIDIA NIM Llama Nemotron Embed 1B v2 (2048d) & Llama Embed Nemotron 8B (4096d) |
| Grounding | Google Search, Google Maps, URL context (Gemini path only) |
| Database | Supabase (PostgreSQL + pgvector) |
| 3D graph | 3d-force-graph (three.js + d3-force-3d), three-spritetext |
| Integrations | Google Calendar API, Gmail API |
| Messaging | Discord.js, Telegram Bot API |
| Export | docx, pdfkit |
| Hosting | Vercel (web/API), Render (Discord bot) |

## Prerequisites

You only really need the first two to run the core app. Everything else is optional and
unlocks the matching feature.

| Requirement | For |
|-------------|-----|
| Node.js 20+ and npm | Required |
| Supabase project (URL + anon key) | Required, for chat history and RAG memory |
| Google AI Studio key ([aistudio.google.com](https://aistudio.google.com/apikey)) | Required, the default chat + embedding provider |
| OpenRouter / NVIDIA NIM / OpenCode Zen keys | Optional, extra chat models (and the free NVIDIA NIM embedding models) |
| Google Cloud OAuth client | Optional, Calendar + Gmail tools |
| Discord bot token | Optional, Discord channel |
| Telegram bot token | Optional, Telegram channel |

## Quick Start

### 1. Install

```bash
git clone <your-repo-url>
cd zuychin-assistant
npm install
```

### 2. Environment variables

```bash
cp .env.example .env.local
```

Required:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `GEMINI_API_KEY` | Google AI Studio API key (default chat + embedding provider) |

Optional extra model providers (a provider with no key is hidden in the UI):

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter key (Nemotron / Laguna / Gemma 4 chat) |
| `OPENROUTER_SITE_URL` | Optional `HTTP-Referer` for OpenRouter rankings |
| `OPENROUTER_APP_NAME` | Optional `X-Title` for OpenRouter rankings |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM key (`nvapi-…`): MiniMax M3 / DeepSeek V4 / Gemma 4 chat + the non-Gemini embedding models |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen key, MiMo V2.5, etc. |
| `TAVILY_API_KEY` | Web search for the non-Gemini models ([tavily.com](https://tavily.com), free tier). Without it those models can't search the web |

Optional auth, integrations, channels and cron:

| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server writes (falls back to the anon key) |
| `APP_TIMEZONE` | Timezone for the date/time the model is given each request (default `Australia/Sydney`) |
| `ACCESS_PASSWORD` | Password for web UI access (leave empty to disable auth) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Google OAuth, Calendar + Gmail |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` | Discord channel |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | Telegram channel |
| `CRON_SECRET` | Bearer token required by the cron endpoints |
| `GITHUB_VAULT_REPO` | Second-brain vault repo as `owner/repo` (private GitHub repo) |
| `GITHUB_VAULT_TOKEN` | Fine-grained PAT scoped to that one repo, Contents read/write |
| `GITHUB_VAULT_BRANCH` | Vault branch (default `main`) |

### 3. Database

Open your Supabase project, go to the SQL Editor, and run the contents of
[`supabase-setup.sql`](supabase-setup.sql). It creates everything in one go: the pgvector
extension, all tables (`user_profiles`, `conversations`, `messages`, `embeddings`, `todos`,
`artifacts`, `vault_pages`), the row-level-security policies, the `match_embeddings` and
`match_vault_pages` search functions and a default profile. The script is safe to run more
than once.

### 4. Google OAuth (optional, Calendar + Gmail)

Create an OAuth client in the Google Cloud Console with the redirect URI
`http://localhost:3000/api/auth/google/callback`, then visit that URL while the app is running
to finish the flow and copy the refresh token into `GOOGLE_REFRESH_TOKEN`. You can run
`node test-google-auth.js` afterwards to check the credentials in `.env.local`.

### 5. Run

```bash
npm run dev
```

- Web UI: [http://localhost:3000](http://localhost:3000)
- Admin: [http://localhost:3000/admin](http://localhost:3000/admin)

## Using the app

- Pick the chat model from the header dropdown. The **Graph** button next to it opens the
  3D knowledge-graph view of the second-brain vault.
- Open the sliders in the message bar for temperature / top-p / max-tokens, the embedding
  model picker and the **Agent mode** switch (forces the multi-step agent loop for every
  message; off = auto-detect).
- Type `/` in the message bar to open the slash-command drop-up (arrow keys / Tab / Enter
  to pick). Commands expand into full prompts server-side; the raw command stays in history.
- The checklist icon in the header opens the **Notes** panel — undated tasks the agent has
  remembered. Ticking one completes it for good.
- Toggle dark/light mode, start a new conversation, or open history from the header buttons.
- Prefix a message with `/think` for deeper reasoning or `/search` to force a web-grounded
  answer. These only apply to models that support them, and the UI hides toggles a model
  can't use.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | RAG chat with file, thinking, search and hyperparameters |
| POST | `/api/chat/stream` | Same as `/api/chat` but streams agent steps + tokens over SSE (web UI) |
| GET | `/api/providers` | Available providers/models (filtered by configured keys) |
| GET/POST/DELETE | `/api/conversations` | Conversation list / create / delete |
| GET/PATCH/DELETE | `/api/todos` | Notes checklist: list / set status / delete |
| GET | `/api/artifacts/[id]` | Download a generated file (report, code, zip) |
| POST | `/api/export` | Export a conversation to PDF or DOCX |
| POST / DELETE | `/api/auth` | Login / logout |
| GET | `/api/auth/google/callback` | Google OAuth setup / token exchange |
| POST | `/api/telegram/webhook` | Telegram bot webhook (secret-header gated) |
| GET | `/api/telegram/test` | Telegram connectivity / config check |
| POST | `/api/cron/daily-briefing` | Morning briefing (emails + calendar) |
| POST | `/api/cron/reminders` | Imminent event reminders |
| POST | `/api/cron/proactive` | Proactive check-ins |
| POST | `/api/cron/vault-lint` | Second-brain vault lint (`?mode=suggest` to report only) |
| GET | `/api/vault/health` | Vault repo connectivity / permissions check |
| GET | `/api/vault/graph` | Vault as graph data: nodes, edges, similarity link suggestions |
| GET/PUT/DELETE | `/api/vault/page` | Read / edit / cascade-delete a wiki page |
| POST/DELETE | `/api/vault/link` | Create / remove a bidirectional wikilink between two pages |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |

All routes except `/login`, `/api/auth`, `/api/cron`, `/api/chat` and `/api/telegram` require
the `zuychin-auth` cookie when `ACCESS_PASSWORD` is set (see `src/proxy.ts`).

## Providers & Models

The chat model is chosen per message from the header dropdown (saved in `localStorage`). A
second dropdown picks the embedding model, and a settings panel tunes hyperparameters. Only
providers whose API key is set show up in the UI. Discord/Telegram and cron always use the
default (Gemini Flash). The registry lives in [`src/lib/ai/providers.ts`](src/lib/ai/providers.ts),
so add models or providers there.

| Provider | Kind | Example models | Notes |
|----------|------|----------------|-------|
| Google Gemini | native | `gemini-3.5-flash`, `gemini-3-flash-preview` | Full features: grounding, thinking, vision, function calling |
| OpenRouter | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-m.1:free`, `google/gemma-4-31b-it:free` | Chat only |
| NVIDIA NIM | OpenAI-compatible | `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-pro`, `nvidia/nemotron-3-ultra-550b-a55b`, `google/gemma-4-31b-it` | Free preview inference (MiniMax M3 & Gemma 4 are multimodal); also the non-Gemini **embedding** models (`llama-nemotron-embed-1b-v2`, `llama-embed-nemotron-8b`) |
| OpenCode Zen | OpenAI-compatible | `mimo-v2.5-free`, `deepseek-v4-flash-free` | Chat only |

How it works:

- One OpenAI-compatible client ([`openai-compat.ts`](src/lib/ai/openai-compat.ts)) serves
  OpenRouter, NVIDIA NIM and OpenCode Zen with streamed responses. Gemini keeps
  its own native path.
- MCP tool-calling works on all providers. If a model rejects tools, the request retries
  without them.
- Each model declares `supportsThinking` and `supportsSearch`. `/think` and `/search` are
  enforced on the server (so they hold on every channel) and the UI hides toggles a model
  can't use. Reasoning (`/think`) maps to Gemini `thinkingConfig`, OpenRouter `reasoning` and
  NIM `chat_template_kwargs.enable_thinking`.
- Web search works two ways depending on the model. Gemini uses native Google Search/Maps
  grounding. The OpenAI-compatible models can't reach the internet, so they get a `search_web`
  tool (backed by Tavily, see `TAVILY_API_KEY`): they call it on their own when an answer needs
  current info, and `/search` forces it. The `search_web` tool is intentionally not given to
  Gemini.
- Hyperparameters (temperature, top_p, max tokens) are optional, sanitized on the server and
  mapped per provider. NIM requests backfill NVIDIA's recommended defaults so models like
  MiniMax M3 always get a token budget.
- Embeddings are model-aware: each embedding model writes and reads its own partition of the
  vector store, because vectors from different models (and dimensions) aren't comparable.
  Switching the embedding model switches which memories are visible; it doesn't corrupt the
  existing ones.

## MCP Tools

The model can call these tools during a chat turn (see `lib/ai/mcp-service.ts`):

| Tool | Purpose |
|------|---------|
| `get_current_time` | Current date/time in a given timezone |
| `search_web` | Real-time internet search (OpenAI-compatible models only; Gemini grounds natively) |
| `search_knowledge` | Semantic search over the pgvector knowledge base |
| `save_note` | Persist a note as an embedding for later recall |
| `get_recent_conversations` | Summary of recent messages across channels |
| `manage_calendar_event` | Create or delete a Google Calendar event |
| `list_calendar_events` | List upcoming events within N hours |
| `list_unread_emails` | List unread Gmail (supports search filters) |
| `list_recent_emails` | List recent Gmail, read or unread (defaults to last 7 days) |
| `read_email` | Read a full email body by message ID |
| `draft_gmail_reply` | Create a draft reply in Gmail |
| `send_email` | Compose and send a new email |
| `manage_todo_list` | Add / list / complete / delete to-do items (feeds the web Notes checklist) |
| `vault_search` | Semantic search over second-brain wiki pages |
| `vault_read` | Read a wiki page from the vault |
| `vault_ingest` | Full ingest pipeline: raw capture → authored page → links → verified commit |
| `vault_write` | Direct wiki page write (index/log/embedding kept consistent) |
| `vault_lint` | Vault health check / auto-fix curator |

Agent runs additionally get `create_document` / `create_code_file` / `create_code_bundle`
(downloadable artifacts — generated documents are auto-embedded into the knowledge base),
`update_plan` (live step tracker), `use_skill` (loads a skill's full instructions) and
`run_subagents` (parallel workers on free fast models).

## Models on Discord / Telegram

The messaging channels have no model dropdown, so they default to free models and pick the
first one whose provider key is set, in this order:

1. DeepSeek V4 Flash (NVIDIA NIM, then OpenCode Zen)
2. MiMo V2.5 (OpenCode Zen)
3. Gemini 3.5 Flash (always available)

Switch the model from inside a chat with the `/model` command. The choice is saved per channel
and reused until you change it again. Every command also accepts a `!` prefix (e.g. `!model`)
since Discord reserves `/` for its own slash-command UI:

- `/model` (or `/model list`) shows the current model and every available provider + model.
- `/model <provider> <model>` switches and remembers the choice, e.g.
  `/model nvidia-nim deepseek-v4-flash` or `/model gemini gemini-3.5-flash`.
- `/embed-model` lists the embedding models; `/embed-model <provider> <model>` switches which
  memory partition the channel uses (memories are stored per embedding model).

### Files and agent mode on messaging

When a request produces a file — a report, a code file, or a zip bundle — the bot delivers it as
a real attachment (Telegram document / Discord upload), not a wall of text. This works on the
normal fast path too, so "make me a report about X" returns a document without any special flag.

Prefix a message with `/agent` (or `!agent`) to force the full multi-step **agent loop** (plans,
web search, parallel sub-agents, skills) instead of a single reply. Keep agent tasks modest here:
Discord runs allow up to ~300s, but the Telegram webhook is capped at ~60s, so heavy agent work
is better done in the web UI.

## Discord Bot (optional)

The Discord bot runs as a separate process (`discord-bot/`) that listens on the Gateway and
forwards messages to the web app's `/api/chat`:

```bash
cd discord-bot
cp .env.example .env   # set DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, ZUYCHIN_API_URL
npm install
node bot.js
```

- Set `ZUYCHIN_API_URL` to your deployed web app (defaults to `http://localhost:3000`).
- Honors `/search`, `/think`, `/agent`, `/model` and `/embed-model` prefixes (use the `!` variant
  so Discord doesn't capture `/`), downloads attachments (up to 20 MB), uploads any generated
  files (reports/code) as attachments, and chunks replies to Discord's 2000-char limit.
- Exposes a health endpoint on `PORT` (default `3001`) and ships a `Procfile` for Render.

## Telegram Bot (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and set `TELEGRAM_BOT_TOKEN`.
2. Choose a random `TELEGRAM_WEBHOOK_SECRET` and set `TELEGRAM_CHAT_ID` to your chat.
3. Point Telegram at your deployed webhook (it must be public HTTPS):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-app>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

`GET /api/telegram/test` checks the configuration.

## Cron Jobs (optional)

Point an external scheduler (for example cron-job.org) at these endpoints with the header
`Authorization: Bearer <CRON_SECRET>`. Proactive and reminder messages go to all configured
channels (Discord + Telegram).

| Endpoint | Schedule | Body |
|----------|----------|------|
| `/api/cron/daily-briefing` | Daily 7:00 AM | `{}` |
| `/api/cron/reminders` | Every 15 min | `{}` |
| `/api/cron/proactive` | As needed | `{ "type": "morning_briefing" }` |
| `/api/cron/vault-lint` | Weekly (quiet hour) | `{}` |

Proactive types: `morning_briefing`, `daily_check`, `reminder`.

## Second Brain (optional)

A long-term research/study knowledge base following Andrej Karpathy's LLM-wiki pattern:
the agent writes interlinked Markdown wiki pages into a **private GitHub repo** and keeps
them cross-linked, catalogued and healthy. It complements (not replaces) pgvector RAG —
`search_knowledge`/`save_note` stay for personal/temporal memory; the vault holds durable
knowledge worth keeping.

Setup:

1. Create a private GitHub repo and seed it with the contents of
   [`vault-template/`](vault-template/) (`agents.md` schema, empty `index.md`/`log.md`,
   `raw/` + `wiki/` folders).
2. Create a fine-grained PAT scoped to that one repo with **Contents read/write**, and set
   `GITHUB_VAULT_REPO`, `GITHUB_VAULT_TOKEN`, `GITHUB_VAULT_BRANCH` in `.env.local` / Vercel.
3. Check `GET /api/vault/health` returns `"ok": true`.

The assistant then gets five tools: `vault_search` (pgvector over page summaries),
`vault_read`, `vault_ingest` (full pipeline: raw capture → authored wiki page → auto-linked
bidirectional `[[wikilinks]]` → catalogue/log update → independent verification → one atomic
`learn:` commit), `vault_write` (direct page edits) and `vault_lint` (suggest/auto curator —
also runs on the weekly cron above with `curator:` commits). Every change is a Git commit,
so any bad write is one revert away.

### 3D graph view

The **Graph** button in the header (or `/graph`) opens an interactive 3D force-directed
view of the vault, in the spirit of Obsidian's graph:

- Nodes are wiki pages (colored by category, sized by connection count, recently updated
  pages glow); edges are `[[wikilinks]]`.
- Click a page to read/edit its Markdown or delete it — deletion also strips every
  reference in other pages, the `index.md` entry and the pgvector row, in one atomic commit.
- Click a connection to remove it (both directions, readable text kept) or to add a new
  labelled link from the page panel.
- Toggle **suggested links**: dashed edges between similar-but-unlinked pages, computed
  from the stored embeddings — click one to materialize it as a real link.
- Search with camera fly-to, per-category filters, orphan toggle, physics sliders, and a
  local mode (double-click a node) that isolates its 1–2 hop neighborhood.

You can still point Obsidian at a clone of the repo — the on-disk format is plain
Markdown + wikilinks.

## Deployment

- Web app: Vercel. Add every `.env.local` variable under Project > Settings > Environment
  Variables. Update the Google OAuth redirect URI and the Telegram webhook URL to your
  production domain.
- Discord bot: Render (or any always-on host) using `discord-bot/Procfile`, with
  `ZUYCHIN_API_URL` pointing at the deployed web app.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                        # Chat UI (state, handlers, layout)
│   ├── home/
│   │   ├── controls.tsx                # Model dropdown, param sliders, model-info modal
│   │   └── styles.ts                   # Chat page style objects
│   ├── graph/page.tsx                  # 3D knowledge-graph view of the vault
│   ├── login/page.tsx                  # Login page
│   ├── admin/page.tsx                  # Admin dashboard
│   └── api/
│       ├── auth/                       # Login/logout + Google OAuth callback
│       ├── chat/route.ts               # RAG chat endpoint (+ chat/stream for SSE)
│       ├── providers/route.ts          # Available providers/models
│       ├── conversations/route.ts      # Conversation CRUD
│       ├── todos/route.ts              # Notes checklist backend
│       ├── export/route.ts             # PDF/DOCX export
│       ├── telegram/                   # Webhook + config check
│       ├── cron/                       # Briefing / reminders / proactive / vault lint
│       ├── vault/                      # health, graph data, page CRUD, link create/delete
│       ├── artifacts/[id]/route.ts     # Download generated files
│       └── admin/                      # Status + personality
├── lib/
│   ├── gemini.ts                       # Gemini client + model id
│   ├── supabase.ts                     # Supabase client
│   ├── db.ts                           # Database layer (messages, embeddings, todos, convos)
│   ├── types.ts                        # Shared types + MIME/size constants
│   ├── commands.ts                     # Slash-command registry (shared client/server)
│   ├── datetime.ts                     # Current date/time context injected on every request
│   ├── google-auth.ts                  # Google OAuth2 client
│   ├── ai/
│   │   ├── providers.ts                # Provider + chat/embedding model registry
│   │   ├── embeddings.ts               # Embedding dispatcher (Gemini / OpenAI-compatible)
│   │   ├── openai-compat.ts            # OpenRouter / NVIDIA NIM / OpenCode Zen client + tool loop
│   │   ├── rag-service.ts              # RAG pipeline; branches on provider + grounding fallback
│   │   ├── web-search.ts               # Real-time web search (Tavily) for non-Gemini models
│   │   ├── mcp-service.ts              # MCP tool definitions + executors
│   │   ├── agent/                      # Intent router, orchestrator, sub-agent workers
│   │   └── skills/                     # Reusable skill registry (reports, code, second brain…)
│   ├── vault/                          # Second brain: GitHub client, ingest, lint, graph ops, page index
│   ├── artifacts/                      # Generated-file storage (documents, code, zips)
│   ├── integrations/                   # Google Calendar + Gmail
│   └── messaging/                      # Discord + Telegram services
├── proxy.ts                            # Cookie auth proxy (Next 16 middleware convention)
discord-bot/
├── bot.js                              # Discord Gateway bot + health server
└── Procfile                            # Render deployment
supabase-setup.sql                      # One-shot database setup script
```

## License

[MIT](LICENSE) © Duy Nguyen
