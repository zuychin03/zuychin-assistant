# Zuychin Assistant

A personal AI chatbot you can talk to from the web, Discord, or Telegram. It lets you
switch chat model providers per message (Google Gemini, OpenRouter, NVIDIA NIM, OpenCode Zen),
keeps long-term memory with a pgvector RAG store, handles file uploads, and can use a set of
tools (Google Calendar, Gmail, a to-do list and a knowledge base) plus Google Search and Maps
grounding. It can schedule its own recurring tasks, watch the inbox for bills and deadlines,
and remember durable facts about you across conversations. It installs as a PWA with push
notifications, holds hands-free voice conversations (replies are spoken back), and can decide
on its own when something is worth reaching out about. Its second-brain wiki vault comes
with an interactive Obsidian-style 3D graph view where pages and links can be inspected,
edited and deleted in place.

## Features

- Multi-provider chat: switch the model per message between Gemini, OpenRouter (Nemotron,
  Laguna M.1, Gemma 4), NVIDIA NIM (MiniMax M3, DeepSeek V4, Gemma 4) and OpenCode Zen (MiMo),
  straight from the chat header
- RAG memory: a model-aware pgvector store. Each embedding model keeps its own memory
  partition (Gemini 768-dim, Nemotron 2048-dim), with rerank, summarization and dedup
- Chat history: conversation sidebar with auto-titling and full CRUD
- Projects: group conversations into collapsible sidebar sections, each with its own
  instructions injected into every chat inside it; extracted facts can be scoped to a
  project so they only surface in that project's chats
- File upload: images, audio, video, PDFs and code/text files (up to 20 MB)
- MCP tools: 23 tools covering calendar, Gmail, a to-do list, notes, knowledge search,
  message-history search, the second-brain vault, scheduled tasks, current time and recent
  conversations
- Voice conversations: send a Telegram voice note or tap the web mic — the audio is passed
  to the model natively (it hears you, not a transcript) and the reply is spoken back with
  Gemini TTS, streamed so speech starts in a couple of seconds. The web mic runs a
  hands-free loop: silence auto-sends, the reply plays, the mic reopens — say
  "Zuychin, stop" (or tap the ✕ chip) to end it. Telegram voice notes are answered with a
  voice note too. Spoken replies fire only on voice input
- Agent mode: complex requests are auto-routed (or forced with the agent switch / `/agent`)
  to a multi-step agent loop with live step streaming, parallel sub-agents, reusable skills
  and downloadable artifacts (documents, code files, zip bundles). Sub-agents default to
  free fast models (DeepSeek V4 Flash, Step 3.7 Flash, any Fast-tagged tool-capable model)
  with Gemini only as the fallback — 3 Flash for simple subtasks, 3.5 Flash for complex ones
- Run durability: every agent run is traced to an `agent_runs` row (plan, step timeline,
  token usage); long runs self-compact their context, and if a stream dies mid-run the web
  UI offers a **Resume run** chip that continues from where it stopped. Interrupted plain
  chat turns (e.g. the phone backgrounds the app mid-reply) recover the saved reply from the
  server, or offer a one-tap **Retry** instead of a raw fetch error
- Streaming replies: chat responses form token-by-token in the bubble as the model
  generates them (Gemini and OpenAI-compatible providers alike); agent runs stream their
  plan and step events the same way
- Initiative engine: a cron where the agent *decides* whether anything is worth proactively
  messaging you about (overdue todos, calendar conflicts, forgotten follow-ups) — hard code
  gates run before any model call (quiet hours, ≥3 h spacing, ≤3/day, skips while you're
  active), and Telegram nudges carry 👍/👎 buttons whose feedback steers future decisions
- Nightly run review: a cron inspects failed or expensive agent runs and files draft skills
  for approval in the admin panel — it can propose improvements but never self-approve
- History search: `/history <query>` (backed by the `search_history` tool) semantically
  searches your own past messages across channels, with links that jump to the conversation
- Today card: the empty chat state shows a dismissible digest of the next 48 hours — due
  todos, calendar events and pending tasks
- PWA + push: installable app (manifest + service worker) with web-push notifications for
  reminders, email-trigger digests, initiative nudges and agent-run completion — suppressed
  while the app is focused
- Fact memory: durable facts about you are extracted after each turn (Mem0-style
  add/update/delete consolidation) and injected as "Known Facts" alongside the raw-message
  RAG memories; editable in the admin dashboard. Personal-life facts are stored only when
  you explicitly state them; work/study observations are tracked as unconfirmed patterns
  and only become facts once the same pattern repeats 3 times across different
  conversations. Facts live in one shared embedding partition, so they're remembered no
  matter which embedding model a chat uses
- Scheduled tasks: ask in chat for one-off or recurring jobs ("every weekday at 8am send me
  a workout reminder on telegram") — stored with a 5-field cron schedule, executed through
  the real chat pipeline and delivered to Telegram, Discord or a web conversation
- Email triggers: the inbox is scanned every few hours for concrete obligations (bills,
  deadlines, appointments, renewals) — each one becomes a todo with a due date, a calendar
  event when dated, and a digest message, with a dedup ledger so nothing fires twice
- Shared MCP server: a real Model Context Protocol endpoint (`/api/mcp/mcp`) so your other
  AI agents and chatbots can search and contribute to the same knowledge base and read the
  second-brain vault, gated by a bearer token
- Cancel in flight: a stop button appears while a reply streams. Stopping is a true drop —
  it aborts the model work server-side, saves no reply, and removes the message you sent,
  so a mistaken send leaves no trace (works for agent runs too)
- Message queue: keep typing while a reply streams — each send queues (shown as dimmed
  bubbles you can remove) and fires one at a time as responses complete; stop clears the
  queue too
- Mobile-friendly composer: on phones the Enter key inserts a newline and only the send
  button submits; on desktop Enter sends and Shift+Enter breaks the line. Ctrl/Cmd+Enter
  always sends, whatever the window size
- Reply to a message: quote any earlier message (yours or the assistant's) from the reply
  arrow next to its bubble; the quote is shown in the thread and given to the model as context
- Slash commands: type `/` in the message bar for a drop-up of 29 ready-made commands
  (`/plan_day`, `/weekly_review`, `/remind`, `/history`, `/new_app`, `/update_app`,
  `/facts`, `/skill`, `/research`, `/code`, `/debug`, `/vault_save`, …) that expand into
  full prompts — skill-backed ones force the agent loop
- Notes checklist: a collapsible panel lists the agent's undated notes/tasks; ticking a box
  completes the task and the agent never reminds you about it again. Pending undated tasks
  are surfaced once a day, at the end of the first reply
- Unified knowledge workspace: `/knowledge` provides a searchable document library,
  chunk inspection, explainable hybrid recall, grounded answers with abstention, a lifecycle
  timeline, safe corrections/promotions/archives/merges, and a governed maintenance queue
- Obsidian portability: lossless ZIP import/export preserves Markdown, frontmatter,
  wikilinks, attachments and `.obsidian` settings; stable `zuychin_id` properties survive
  renames, while signed GitHub webhooks support incremental synchronization

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
  by urgency), event reminders + due-todo nagging, scheduled-task dispatch, email triggers,
  initiative decisions, the nightly run review and proactive check-ins
- Export: every long reply gets a collapsed **Generate ▾** menu for a DOCX / PDF / MD
  download; whole conversations export to PDF or DOCX (Markdown-aware)
- Live embedding switcher: changing the embedding model in settings (behind a confirm
  modal) re-embeds the entire knowledge store in resumable batches and flips the active
  partition at runtime — no script run or redeploy needed
- Admin dashboard: stats, a live personality/system-prompt editor, agent-run traces
  (status, duration, tokens, expandable step timeline), a fact-memory editor and a
  skills panel (approve/edit/delete agent-authored skill drafts) at `/admin`
- Self-authoring skills: after a novel multi-step task the agent can save its procedure
  as a draft skill; once approved in the admin panel it joins the skill index for future runs
- Password auth: cookie-based access control via the auth proxy

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Chat models | Gemini 3.5 / 3 Flash, OpenRouter (Nemotron, Laguna M.1, Gemma 4), NVIDIA NIM (MiniMax M3, DeepSeek V4, Gemma 4), OpenCode Zen (MiMo, DeepSeek) |
| Embeddings | Gemini Embedding 2 (768d), NVIDIA NIM Llama Nemotron Embed 1B v2 (2048d) & Llama Embed Nemotron 8B (4096d) |
| Grounding | Google Search, Google Maps, URL context (Gemini path only) |
| Voice replies | Gemini TTS (`gemini-3.1-flash-tts-preview`), streamed PCM → WAV / Web Audio |
| Push | web-push (VAPID) + service worker (PWA) |
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
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM key (`nvapi-…`): MiniMax M3 / DeepSeek V4 / Gemma 4 chat + Llama Nemotron, the default embedding model for the knowledge store |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen key, MiMo V2.5, etc. |
| `KNOWLEDGE_EMBEDDING_MODEL` | Optional: swap the knowledge store to another registered embedding model (fallback if NIM is down). After changing it, run `npx tsx --env-file=<env> scripts/reembed-knowledge.ts` to re-embed the store |
| `TAVILY_API_KEY` | Web search for the non-Gemini models ([tavily.com](https://tavily.com), free tier). Without it those models can't search the web |

Optional auth, integrations, channels and cron:

| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server-only knowledge writes; required in production |
| `APP_TIMEZONE` | Timezone for the date/time the model is given each request (default `Australia/Sydney`) |
| `ACCESS_PASSWORD` | Password for web UI access (leave empty to disable auth) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Google OAuth, Calendar + Gmail |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` | Discord: bot token + legacy single channel (fallback for the per-purpose ids below) |
| `DISCORD_ASK_CHANNEL_ID` | The one Discord channel the bot converses in (`#ask-zuychin`) |
| `DISCORD_CH_BRIEFING` / `_REMINDERS` / `_TASKS` / `_CALENDAR` / `_BILLS` / `_COWORKING` / `_SYSTEM` | Per-purpose notification channels; each falls back to `DISCORD_CHANNEL_ID` (`_SYSTEM` stays silent unless set) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | Telegram channel |
| `CRON_SECRET` | Bearer token required by the cron endpoints |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web-push key pair (`npx web-push generate-vapid-keys`); both unset = push disabled |
| `VAPID_SUBJECT` | `mailto:` contact sent to the push service (falls back to a baked-in address) |
| `GEMINI_TTS_MODEL` | Optional override of the voice-reply TTS model (default `gemini-3.1-flash-tts-preview`) |
| `MCP_API_KEY` | Read + write bearer for the shared MCP server (`/api/mcp/mcp`) |
| `MCP_API_KEY_READONLY` | Read-only bearer for the shared MCP server; both unset = endpoint locked |
| `GITHUB_VAULT_REPO` | Second-brain vault repo as `owner/repo` (private GitHub repo) |
| `GITHUB_VAULT_TOKEN` | Fine-grained PAT scoped to that one repo, Contents read/write |
| `GITHUB_VAULT_BRANCH` | Vault branch (default `main`) |
| `GITHUB_VAULT_WEBHOOK_SECRET` | HMAC secret for incremental GitHub push webhooks |
| `NEXT_PUBLIC_OBSIDIAN_VAULT_NAME` | Optional vault name used by `obsidian://` open links |

### 3. Database

Open your Supabase project, go to the SQL Editor, and run the contents of
[`supabase-setup.sql`](supabase-setup.sql). It creates everything in one go: the pgvector
extension, core tables (`user_profiles`, `conversations`, `messages`, `embeddings`, `todos`,
`artifacts`, `vault_pages`, `agent_runs`, `memories`, `scheduled_tasks`, `processed_emails`,
`projects`, `custom_skills`, `initiative_log`, `cron_state`, `push_subscriptions`),
the row-level-security policies, the search functions (`match_embeddings`,
`match_vault_pages`, `match_memories` plus the hybrid keyword+vector
`hybrid_match_knowledge` and `hybrid_match_vault_pages`) and a default profile. The script
is safe to run more than once — re-run it after upgrading to pick up new tables and columns.

The same script creates the unified knowledge domain (`knowledge_documents`,
`knowledge_chunks`, `knowledge_links`, `knowledge_assertions`,
`knowledge_events`, `knowledge_sync_state` and `knowledge_suggestions`) plus atomic
replacement RPCs and chunk-level hybrid recall. Knowledge tables are server-only under
RLS, so production requires `SUPABASE_SERVICE_ROLE_KEY`.


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

- Pick the chat model from the header dropdown. **Knowledge** opens the unified workspace;
  its Graph action opens the 3D vault view.
- Open the sliders in the message bar for temperature / top-p / max-tokens, the embedding
  model picker and the **Agent mode** switch (forces the multi-step agent loop for every
  message; off = auto-detect).
- Type `/` in the message bar to open the slash-command drop-up (arrow keys / Tab / Enter
  to pick). Commands expand into full prompts server-side; the raw command stays in history.
- Tap the mic for a hands-free voice chat: it auto-sends when you pause, speaks the reply,
  and listens again. Say "Zuychin, stop" or tap the ✕ on the status chip to end the loop.
- The checklist icon in the header opens the **Notes** panel — undated tasks the agent has
  remembered. Ticking one completes it for good.
- Toggle dark/light mode, start a new conversation, or open history from the header buttons.
- In the history sidebar, **New project** creates a collapsible group: use the folder icon
  on a chat row to move it into a project, and the project's ⋯ menu to rename it, edit the
  instructions injected into its chats, or delete it (chats fall back to Ungrouped).
- Prefix a message with `/think` for deeper reasoning or `/search` to force a web-grounded
  answer. These only apply to models that support them, and the UI hides toggles a model
  can't use.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | RAG chat with file, thinking, search and hyperparameters |
| POST | `/api/chat/stream` | Same as `/api/chat` but streams agent steps + tokens over SSE (web UI) |
| GET | `/api/providers` | Available providers/models (filtered by configured keys) |
| GET/POST/PUT/DELETE | `/api/conversations` | Conversation list / create (optionally in a project) / move between projects / delete |
| GET/POST/PUT/DELETE | `/api/projects` | Project list / create / rename + edit instructions / delete (chats drop to Ungrouped) |
| GET/PATCH/DELETE | `/api/todos` | Notes checklist: list / set status / delete |
| GET | `/api/today` | Today-card digest: next-48 h events + due and pending todos |
| GET/POST | `/api/tts` | Voice-reply prefs / synthesize speech (`stream: true` streams raw PCM) |
| POST/DELETE | `/api/push/subscribe` | Register / remove a web-push subscription |
| GET | `/api/artifacts/[id]` | Download a generated file (report, code, zip) |
| POST | `/api/export` | Export a conversation to PDF or DOCX |
| POST / DELETE | `/api/auth` | Login / logout |
| GET | `/api/auth/google/callback` | Google OAuth setup / token exchange |
| POST | `/api/telegram/webhook` | Telegram bot webhook (secret-header gated) |
| GET/POST/DELETE | `/api/mcp/[transport]` | Shared MCP server, Streamable HTTP at `/api/mcp/mcp` (Bearer `MCP_API_KEY`) |
| GET | `/api/telegram/test` | Telegram connectivity / config check |
| POST | `/api/cron/daily-briefing` | Morning briefing (emails + calendar) |
| POST | `/api/cron/reminders` | Imminent event reminders + due-todo nagging |
| POST | `/api/cron/scheduled-tasks` | Run due user-scheduled tasks (claims up to 3 per invocation) |
| POST | `/api/cron/email-triggers` | Scan inbox for bills/deadlines → todos + calendar events |
| POST | `/api/cron/initiative` | Agent-initiated outreach: gated decide-then-maybe-message pass |
| POST | `/api/cron/run-review` | Nightly review of failed/expensive agent runs → draft skills |
| POST | `/api/cron/proactive` | Proactive check-ins |
| POST | `/api/cron/vault-lint` | Second-brain vault lint (`?mode=suggest` to report only) |
| GET | `/api/vault/health` | Vault repo connectivity / permissions check |
| GET | `/api/vault/graph` | Vault as graph data: nodes, edges, similarity link suggestions |
| GET/PUT/DELETE | `/api/vault/page` | Read / edit / cascade-delete a wiki page |
| POST/DELETE | `/api/vault/link` | Create / remove a bidirectional wikilink between two pages |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |
| GET | `/api/admin/runs` | Agent-run traces (list, or `?id=` for the full event timeline) |
| GET/POST/PUT/DELETE | `/api/admin/memories` | List / add / edit / delete extracted memory facts |
| GET/PUT/DELETE | `/api/admin/skills` | List custom + built-in skills, approve/edit drafts, delete |
| GET/POST | `/api/admin/reembed` | Re-embed progress / migrate the knowledge store to another embedding model (batched, resumable) |

All routes except `/login`, `/api/auth`, `/api/cron`, `/api/chat` and `/api/telegram` require
the `zuychin-auth` cookie when `ACCESS_PASSWORD` is set (see `src/proxy.ts`).

## Providers & Models

The chat model is chosen per message from the header dropdown (saved in `localStorage`). The
settings drop-up picks the embedding model — changing it (behind a confirm modal) migrates
the whole knowledge store to the new partition — and tunes hyperparameters. Only
providers whose API key is set show up in the UI. Discord/Telegram and cron always use the
default (Gemini Flash). The registry lives in [`src/lib/ai/providers.ts`](src/lib/ai/providers.ts),
so add models or providers there.

| Provider | Kind | Example models | Notes |
|----------|------|----------------|-------|
| Google Gemini | native | `gemini-3.6-flash`, `gemini-3.5-flash-lite` | Full features: grounding, thinking, vision, function calling |
| OpenRouter | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-m.1:free`, `poolside/laguna-s-2.1:free`, `google/gemma-4-31b-it:free`, `openai/gpt-oss-120b:free`, `qwen/qwen3-next-80b-a3b-instruct:free` | Chat only |
| NVIDIA NIM | OpenAI-compatible | `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-pro`, `nvidia/nemotron-3-ultra-550b-a55b`, `google/gemma-4-31b-it`, `z-ai/glm-5.2`, `qwen/qwen3-next-80b-a3b-instruct` | Free preview inference (MiniMax M3 & Gemma 4 are multimodal); also the non-Gemini **embedding** models (`llama-nemotron-embed-1b-v2`, `llama-embed-nemotron-8b`) |
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
  Switching the embedding model in settings runs a real migration: `/api/admin/reembed`
  re-embeds the store in resumable 20-row batches (embeddings + memories) and flips the
  active partition only once nothing is left, so a mid-migration failure never strands you.

## MCP Tools

The model can call these tools during a chat turn (see `lib/ai/mcp-service.ts`):

| Tool | Purpose |
|------|---------|
| `get_current_time` | Current date/time in a given timezone |
| `search_web` | Real-time internet search (OpenAI-compatible models only; Gemini grounds natively) |
| `search_knowledge` | Hybrid keyword + vector search over the pgvector knowledge base |
| `search_history` | Semantic search over your own past messages across channels, with links that open the conversation |
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
| `manage_scheduled_task` | Create / list / update / delete one-off or recurring scheduled tasks |
| `manage_memory_facts` | List / forget / correct the extracted long-term Known Facts |
| `manage_notes` | List / update / delete saved knowledge-base notes (by category) |
| `vault_search` | Hybrid keyword + vector search over second-brain wiki pages |
| `vault_read` | Read a wiki page from the vault |
| `vault_ingest` | Full ingest pipeline: raw capture → authored page → links → verified commit |
| `vault_write` | Direct wiki page write (index/log/embedding kept consistent) |
| `vault_delete` | Permanently delete a wiki page + every reference to it, in one commit |
| `vault_lint` | Vault health check / auto-fix curator |

Agent runs additionally get `create_document` / `create_code_file` / `create_code_bundle`
(downloadable artifacts — generated documents are auto-embedded into the knowledge base),
`update_plan` (live step tracker), `use_skill` (loads a skill's full instructions —
built-in or approved custom), `save_skill` (files a new draft skill for review) and
`run_subagents` (parallel workers on free fast models).

## Shared MCP Server

The tools above are the assistant's *internal* registry (passed to the model as function
declarations). Separately, the app also runs a real [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp/mcp`** (stateless Streamable HTTP, legacy SSE at `/api/mcp/sse`) so
your **other AI agents and chatbots** can share the knowledge base:

| MCP tool | Access | What it does |
|----------|--------|--------------|
| `search_knowledge` | read | Hybrid keyword + vector search over the shared knowledge base (optional note-category filter) |
| `list_notes` | read | Browse saved notes newest-first, optionally by category tag |
| `vault_search` | read | Search the second-brain vault pages (uses the vault's dominant embedding partition) |
| `vault_read` | read | Fetch a vault page's full Markdown by path |
| `get_recent_conversations` | read | Recent messages across channels, for shared context on what you've been working on |
| `save_note` | write | Store a note that becomes searchable by every connected agent and the assistant |
| `update_note` | write | Rewrite a saved note's text and/or category (re-embedded; for correcting stale info) |
| `delete_note` | write | Remove a saved note (never touches conversation history) |
| `vault_ingest` | write | File durable knowledge (study notes, project docs, plans) through the full vault pipeline |
| `vault_write` | write | Direct vault page create/overwrite with complete Markdown |

Knowledge tools pin the default embedding partition and no user filter, so external agents
read and write the **same global store** the assistant uses. Vault writes pin the vault's
dominant embedding partition so pages never fragment across models. `vault_delete` is
deliberately not exposed — page removal stays with the assistant and the graph UI.

**Two access levels.** `MCP_API_KEY` grants read + write; `MCP_API_KEY_READONLY` grants read
only (write tools return an error for a read-only key). Hand the read-only key to agents you
only want to *query* the brain, the read-write key to ones you trust to add to it.

Setup:

1. Set `MCP_API_KEY` and/or `MCP_API_KEY_READONLY` in `.env.local` / Vercel (any long random
   strings). While both are unset the endpoint answers 401 to everything.
2. Point a client at `https://<your-app>/api/mcp/mcp` with header
   `Authorization: Bearer <key>`. For example:

```bash
claude mcp add --transport http zuychin https://<your-app>/api/mcp/mcp \
  --header "Authorization: Bearer <key>"
```

Or test locally with the MCP Inspector (`npx @modelcontextprotocol/inspector`, transport
"Streamable HTTP"). Note that anything saved through `save_note` later surfaces in the
assistant's own context — only hand the key to agents you trust.

## Models on Discord / Telegram

The messaging channels have no model dropdown, so they default to free models and pick the
first one whose provider key is set, in this order:

1. DeepSeek V4 Flash (NVIDIA NIM, then OpenCode Zen)
2. MiMo V2.5 (OpenCode Zen)
3. Gemini 3.6 Flash (always available)

Switch the model from inside a chat with the `/model` command. The choice is saved per channel
and reused until you change it again. Every command also accepts a `!` prefix (e.g. `!model`)
since Discord reserves `/` for its own slash-command UI:

- `/model` (or `/model list`) shows the current model and every available provider + model.
- `/model <provider> <model>` switches and remembers the choice, e.g.
  `/model nvidia-nim deepseek-v4-flash` or `/model gemini gemini-3.6-flash`.
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
`Authorization: Bearer <CRON_SECRET>`. Delivery is centralized in the notification router
(`src/lib/messaging/router.ts`): each notification type routes to its dedicated Discord
channel, with push mirrored only for time-sensitive types and Telegram reserved for
conversational chat plus initiative nudges. See `docs/messaging-redesign.md` for the routing
table.

| Endpoint | Schedule | Body |
|----------|----------|------|
| `/api/cron/daily-briefing` | Daily 7:00 AM | `{}` |
| `/api/cron/reminders` | Every 15 min | `{}` |
| `/api/cron/scheduled-tasks` | Every 5–15 min | `{}` |
| `/api/cron/email-triggers` | Every 4 h | `{}` |
| `/api/cron/initiative` | Every 1–2 h | `{}` |
| `/api/cron/run-review` | Daily (quiet hour) | `{}` |
| `/api/cron/proactive` | As needed | `{ "type": "morning_briefing" }` |
| `/api/cron/vault-lint` | Weekly (quiet hour) | `{}` |
| `/api/cron/slack-watchdog` | Every 15–30 min | `{}` |
| `/api/cron/agent-standup` | Daily | `{}` |

Proactive types: `morning_briefing`, `daily_check`, `reminder`.

The reminders job covers imminent calendar events and todos due within 24 h (re-nagged
roughly daily while overdue). Scheduled-tasks is the dispatcher for user-created tasks
(`manage_scheduled_task`); email-triggers turns bills/deadlines found in the inbox into
todos and calendar events, deduplicated via the `processed_emails` ledger. Initiative asks
the agent whether anything warrants reaching out — code gates (quiet hours, spacing, daily
cap, user-active skip) run before any model call, so most invocations cost nothing.
Run-review reads the previous day's agent runs and files draft skills for anything that
failed or ran expensive; drafts wait for approval in `/admin`.

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

The assistant then gets six tools: `vault_search` (hybrid keyword + pgvector over pages),
`vault_read`, `vault_ingest` (full pipeline: raw capture → authored wiki page → auto-linked
bidirectional `[[wikilinks]]` → catalogue/log update → independent verification → one atomic
`learn:` commit), `vault_write` (direct page edits), `vault_delete` (cascade removal: the
page, every inbound wikilink, the `index.md` entry and the pgvector row in one commit) and
`vault_lint` (suggest/auto curator — also runs on the weekly cron above with `curator:`
commits). Every change is a Git commit, so any bad write is one revert away.

### Knowledge workspace

Open `/knowledge` for the primary knowledge interface:

- **Library** reads the GitHub Markdown source and shows indexed chunks, links, trust,
  sensitivity, scope and lifecycle status. Corrections create Git commits; archive,
  restore, retire and promote update frontmatter without deleting history.
- **Recall** exposes semantic, lexical, graph, authority, freshness and importance
  components for every result. Answers are extractive and abstain below the support
  threshold.
- **Timeline** records indexing, imports, corrections, promotions, merges and retirement.
- **Maintenance** runs deterministic checks for duplicates, stale episodic knowledge,
  orphans and broken links, then optionally adds clearly labelled advisory findings for
  contradictions, consolidation, links and promotions. Nothing is applied automatically.
  A merge requires selecting the canonical page and reviewing its complete Markdown.

GitHub Markdown remains the source of truth. PostgreSQL stores lifecycle metadata,
derived chunks, links, vectors, events and suggestions; a full reconciliation can rebuild
that derived state. Stable `zuychin_id` frontmatter keeps identity independent of path.
Unknown and nested Obsidian/plugin YAML is retained when managed frontmatter changes.

#### Obsidian round trip

- **Export** downloads every repository file as bytes, including attachments and
  `.obsidian`, plus `.zuychin/manifest.json` checksums.
- **Import** accepts a ZIP and always presents a dry-run create/update/unchanged plan
  before the apply step. Paths and archive sizes are validated.
- Set `NEXT_PUBLIC_OBSIDIAN_VAULT_NAME` to show direct `obsidian://` links.
- For incremental sync, create a GitHub **push** webhook pointing to
  `https://<host>/api/knowledge/webhook`, choose `application/json`, and use the same
  value for the webhook secret and `GITHUB_VAULT_WEBHOOK_SECRET`.

Relevant server routes are `/api/knowledge/documents`, `recall`, `events`,
`suggestions`, `sync`, `import`, `export` and the signed `webhook`. The import,
export and synchronization paths are repository adapters, so a future local-filesystem
Obsidian adapter can be added without changing lifecycle or retrieval services.


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
│   ├── manifest.ts                     # PWA manifest
│   ├── home/
│   │   ├── controls.tsx                # Model dropdown, param sliders, model-info modal
│   │   ├── conversation-list.tsx       # Sidebar list with project groups + move/rename menus
│   │   └── styles.ts                   # Chat page style objects
│   ├── graph/page.tsx                  # 3D knowledge-graph view of the vault
│   ├── login/page.tsx                  # Login page
│   ├── admin/                          # Dashboard + run-trace, memory and skills panels
│   └── api/
│       ├── auth/                       # Login/logout + Google OAuth callback
│       ├── chat/route.ts               # RAG chat endpoint (+ chat/stream for SSE)
│       ├── providers/route.ts          # Available providers/models
│       ├── conversations/route.ts      # Conversation CRUD + move between projects
│       ├── projects/route.ts           # Project CRUD
│       ├── todos/route.ts              # Notes checklist backend
│       ├── today/route.ts              # Today-card digest (events + todos)
│       ├── tts/route.ts                # Voice-reply synthesis (blocking or streamed PCM)
│       ├── push/subscribe/route.ts     # Web-push subscription registry
│       ├── export/route.ts             # PDF/DOCX export
│       ├── telegram/                   # Webhook + config check
│       ├── cron/                       # Briefing / reminders / scheduled tasks / email triggers / initiative / run review / proactive / vault lint
│       ├── vault/                      # health, graph data, page CRUD, link create/delete
│       ├── artifacts/[id]/route.ts     # Download generated files
│       └── admin/                      # Status, personality, run traces, memories, skills
├── lib/
│   ├── gemini.ts                       # Gemini client + model id
│   ├── supabase.ts                     # Supabase client
│   ├── db.ts                           # Database layer (messages, embeddings, todos, convos)
│   ├── projects.ts                     # Project CRUD + conversation→project resolution
│   ├── types.ts                        # Shared types + MIME/size constants
│   ├── commands.ts                     # Slash-command registry (shared client/server)
│   ├── speech.ts                       # Markdown → speakable text (shared client/server)
│   ├── datetime.ts                     # Current date/time context injected on every request
│   ├── google-auth.ts                  # Google OAuth2 client
│   ├── ai/
│   │   ├── providers.ts                # Provider + chat/embedding model registry
│   │   ├── embeddings.ts               # Embedding dispatcher (Gemini / OpenAI-compatible)
│   │   ├── openai-compat.ts            # OpenRouter / NVIDIA NIM / OpenCode Zen client + tool loop
│   │   ├── rag-service.ts              # RAG pipeline; branches on provider + grounding fallback
│   │   ├── web-search.ts               # Real-time web search (Tavily) for non-Gemini models
│   │   ├── mcp-service.ts              # MCP tool definitions + executors
│   │   ├── tts.ts                      # Gemini TTS pipeline (streamed PCM → WAV)
│   │   ├── initiative-store.ts         # Initiative decision log + send gates + feedback
│   │   ├── embedding-override.ts       # Runtime knowledge-store partition override
│   │   ├── agent/                      # Intent router, orchestrator, sub-agent workers
│   │   └── skills/                     # Skill registry: built-in playbooks + agent-authored custom skills
│   ├── vault/                          # Second brain: GitHub client, ingest, lint, graph ops, page index
│   ├── artifacts/                      # Generated-file storage (documents, code, zips)
│   ├── integrations/                   # Google Calendar + Gmail
│   └── messaging/                      # Discord + Telegram + web-push services
├── proxy.ts                            # Cookie auth proxy (Next 16 middleware convention)
public/sw.js                            # Service worker: push display + click-through
discord-bot/
├── bot.js                              # Discord Gateway bot + health server
└── Procfile                            # Render deployment
supabase-setup.sql                      # One-shot database setup script
```

## License

[MIT](LICENSE) © Duy Nguyen
