# Zuychin Assistant

A personal AI chatbot you can talk to from the web, Discord, or Telegram. It lets you
switch chat model providers per message (Google Gemini, DeepSeek, OpenRouter, NVIDIA NIM, OpenCode Zen),
keeps long-term memory with a pgvector RAG store, handles file uploads, and can use a set of
tools (Google Calendar, Gmail, a to-do list and a knowledge base) plus Google Search and Maps
grounding. It can schedule its own recurring tasks, watch the inbox for bills and deadlines,
and remember durable facts about you across conversations. It installs as a PWA with push
notifications, holds hands-free voice conversations (replies are spoken back), and can decide
on its own when something is worth reaching out about. The web app supports passkey sign-in
with device biometrics, password plus TOTP recovery, and a shared council for collaborating
with external coding agents. Its second-brain wiki vault comes
with an interactive Obsidian-style 3D graph view where pages and links can be inspected,
edited and deleted in place.

## Features

- Multi-provider chat: switch the model per message between Gemini (paid or a free-tier key),
  DeepSeek (V4 Flash, V4 Pro), OpenRouter (Nemotron, Laguna S 2.1, Gemma 4), NVIDIA NIM
  (MiniMax M3, DeepSeek V4, Step, GLM, Gemma 4) and OpenCode Zen (MiMo, DeepSeek, Laguna S 2.1,
  Ling 3.0 Flash), straight from the chat header
- RAG memory: a model-aware pgvector store. Each embedding model keeps its own memory
  partition (Gemini 768-dim, Nemotron 2048-dim), with rerank, summarization and dedup
- Chat history: conversation sidebar with auto-titling and full CRUD
- Projects: group conversations into collapsible sidebar sections, each with its own
  instructions injected into every chat inside it; extracted facts can be scoped to a
  project so they only surface in that project's chats
- File upload: images, audio, video, PDFs and code/text files (up to 20 MB)
- MCP tools: two dozen tools covering calendar, Gmail, a to-do list, notes, knowledge search,
  message-history search, the second-brain vault, scheduled tasks, current time and recent
  conversations
- Passkey-first PWA sign-in: WebAuthn device biometrics, PIN or a hardware security key with
  short-lived signed sessions; password confirmation protects enrolment and TOTP provides a
  recovery path
- Council workspace: ask Zuychin for a council and launch it from a card in the chat, watch it live
  at `/council`, and let a local ACP host start the agents, push each turn and mediate their file access
- Voice conversations: send a Telegram voice note or tap the web mic - the audio is passed
  to the model natively (it hears you, not a transcript) and the reply is spoken back with
  Gemini TTS, streamed so speech starts in a couple of seconds. The web mic runs a
  hands-free loop: silence auto-sends, the reply plays, the mic reopens - say
  "Zuychin, stop" (or tap the ✕ chip) to end it. Telegram voice notes are answered with a
  voice note too. Spoken replies fire only on voice input
- Agent mode: complex requests are auto-routed (or forced with the agent switch / `/agent`)
  to a multi-step agent loop with live step streaming, parallel sub-agents, reusable skills
  and downloadable artifacts (documents, code files, zip bundles). Sub-agents default to
  free fast models (DeepSeek V4 Flash, Step 3.7 Flash, any Fast-tagged tool-capable model)
  with Gemini only as the fallback - 3 Flash for simple subtasks, 3.5 Flash for complex ones
- Run durability: every agent run is traced to an `agent_runs` row (plan, step timeline,
  token usage); long runs self-compact their context, and if a stream dies mid-run the web
  UI offers a **Resume run** chip that continues from where it stopped. Interrupted plain
  chat turns (e.g. the phone backgrounds the app mid-reply) recover the saved reply from the
  server, or offer a one-tap **Retry** instead of a raw fetch error
- Streaming replies: chat responses form token-by-token in the bubble as the model
  generates them (Gemini and OpenAI-compatible providers alike); agent runs stream their
  plan and step events the same way
- Initiative engine: a cron where the agent *decides* whether anything is worth proactively
  messaging you about (overdue todos, calendar conflicts, forgotten follow-ups) - hard code
  gates run before any model call (quiet hours, ≥3 h spacing, ≤3/day, skips while you're
  active), and Telegram nudges carry 👍/👎 buttons whose feedback steers future decisions
- Nightly run review: a cron inspects failed or expensive agent runs and files draft skills
  for approval in the admin panel - it can propose improvements but never self-approve
- History search: `/history <query>` (backed by the `search_history` tool) semantically
  searches your own past messages across channels, with links that jump to the conversation
- Today card: the empty chat state shows a dismissible digest of the next 48 hours - due
  todos, calendar events and pending tasks
- PWA + push: installable app (manifest + service worker) with web-push notifications for
  reminders, email-trigger digests, initiative nudges and agent-run completion - suppressed
  while the app is focused
- Fact memory: durable facts about you are extracted after each turn (Mem0-style
  add/update/delete consolidation) and injected as "Known Facts" alongside the raw-message
  RAG memories; editable in the admin dashboard. Personal-life facts are stored only when
  you explicitly state them; work/study observations are tracked as unconfirmed patterns
  and only become facts once the same pattern repeats 3 times across different
  conversations. Facts live in one shared embedding partition, so they're remembered no
  matter which embedding model a chat uses
- Scheduled tasks: ask in chat for one-off or recurring jobs ("every weekday at 8am send me
  a workout reminder on telegram") - stored with a 5-field cron schedule, executed through
  the real chat pipeline and delivered to Telegram, Discord or a web conversation
- Email triggers: the inbox is scanned every few hours for concrete obligations (bills,
  deadlines, appointments, renewals) - each one becomes a todo with a due date, a calendar
  event when dated, and a digest message, with a dedup ledger so nothing fires twice
- Shared MCP server: a real Model Context Protocol endpoint (`/api/mcp/mcp`) so your other
  AI agents and chatbots can search and contribute to the same knowledge base and read the
  second-brain vault, gated by a bearer token
- Cancel in flight: a stop button appears while a reply streams. Stopping is a true drop -
  it aborts the model work server-side, saves no reply, and removes the message you sent,
  so a mistaken send leaves no trace (works for agent runs too)
- Message queue: keep typing while a reply streams - each send queues (shown as dimmed
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
  full prompts - skill-backed ones force the agent loop
- Notes checklist: a collapsible panel lists the agent's undated notes/tasks; ticking a box
  completes the task and the agent never reminds you about it again. Pending undated tasks
  are surfaced once a day, at the end of the first reply
- Unified knowledge workspace: `/knowledge` provides a searchable document library,
  chunk inspection, explainable hybrid recall, grounded answers with abstention, a lifecycle
  timeline, safe corrections/promotions/archives/merges, and a governed maintenance queue
- Obsidian portability: lossless ZIP import/export preserves Markdown, frontmatter,
  wikilinks, attachments and `.obsidian` settings; stable `zuychin_id` properties survive
  renames, while signed GitHub webhooks support incremental synchronization

- Second brain: a Karpathy-style LLM-wiki in a private GitHub repo - the agent ingests
  research into interlinked Markdown pages (auto-linked via pgvector + LLM curation,
  verified before every commit) and a lint curator keeps the graph healthy
- Knowledge cosmos: a dark, planetarium-style 3D view of the vault at `/graph` where each page
  is a star sized by its connectedness. Five lenses recolour it (category, constellation,
  trust, health, recency), semantic search flares the matching stars, route-finding lights the
  chain of links between any two pages, detected communities separate into named
  constellations, and a time scrubber replays the vault's growth. Health findings (orphans,
  dead links, stale and unreviewed pages) surface on the graph itself, and pages and
  connections stay editable in place with every change landing as an atomic Git commit
- Web search: Gemini grounds answers with real-time Google Search (inline citations + URL context); the other models get a `search_web` tool so they can pull live info too, automatically or on demand with `/search`
- Maps grounding: location questions get routed to Google Maps (places, directions, hours)
- Date awareness: the current date/time (in your timezone) is injected into the model's context on every request, so it doesn't guess the date when discussing plans or schedules
- Think mode: a deep-reasoning toggle (`/think`), tunable per model
- Hyperparameters: optional temperature / top-p / max-tokens controls in the header
- Dark / light mode: theme toggle that remembers your choice and respects the system setting
- Multi-channel: web UI, Discord bot and Telegram bot all share the same RAG pipeline
- Cron jobs: daily briefing (LLM-triaged inbox - only the emails that matter, icon-coded
  by urgency), event reminders + due-todo nagging, scheduled-task dispatch, email triggers,
  initiative decisions, the nightly run review and proactive check-ins
- Export: every long reply gets a collapsed **Generate ▾** menu for a DOCX / PDF / MD
  download; whole conversations export to PDF or DOCX (Markdown-aware)
- Live embedding switcher: changing the embedding model in settings (behind a confirm
  modal) re-embeds the entire knowledge store in resumable batches and flips the active
  partition at runtime - no script run or redeploy needed
- Admin dashboard: stats, a live personality/system-prompt editor, agent-run traces
  (status, duration, tokens, expandable step timeline), a fact-memory editor and a
  skills panel (approve/edit/delete agent-authored skill drafts) at `/admin`
- Self-authoring skills: after a novel multi-step task the agent can save its procedure
  as a draft skill; once approved in the admin panel it joins the skill index for future runs
- Resilient replies: a provider response that stops at its length limit is resumed and stitched
  together rather than silently ending mid-answer
- Secure web and API access: passkeys and password plus TOTP recovery protect the PWA; cron
  and headless chat callers require dedicated bearer credentials in production

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Chat models | Gemini 3.6 / 3.5 Flash (paid or free-tier key), DeepSeek V4 Flash / Pro, OpenRouter (Nemotron, Laguna S 2.1, Gemma 4), NVIDIA NIM (MiniMax M3, DeepSeek V4, Nemotron, Gemma 4, Step, GLM), OpenCode Zen (MiMo, DeepSeek, Laguna S 2.1, Ling 3.0 Flash) |
| Embeddings | Gemini Embedding 2 (768d), NVIDIA NIM Llama Nemotron Embed 1B v2 (2048d) & Llama Embed Nemotron 8B (4096d) |
| Grounding | Google Search, Google Maps, URL context (Gemini path only) |
| Voice replies | Gemini TTS (`gemini-3.1-flash-tts-preview`), streamed PCM → WAV / Web Audio |
| Push | web-push (VAPID) + service worker (PWA) |
| Database | Supabase (PostgreSQL + pgvector) |
| 3D graph | 3d-force-graph (three.js + d3-force-3d), three (sprite stars, planet bodies, bloom), HTML label overlay |
| Integrations | Google Calendar API, Gmail API |
| Messaging | Discord.js, Telegram Bot API |
| Agent council | Agent Client Protocol (`@agentclientprotocol/sdk`) over stdio, `ws` loopback control channel, git worktree isolation |
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
| `GEMINI_FREE_API_KEY` | Second Google AI Studio key on a free-tier project. Lists the same Gemini models a second time as "(free)", and calls made with them go to that key's quota rather than the paid project's |
| `DEEPSEEK_API_KEY` | DeepSeek key ([platform.deepseek.com](https://platform.deepseek.com)): V4 Flash and V4 Pro on DeepSeek's own API. **Metered** - unlike the other optional providers here it bills per token, so it is excluded from the free sub-agent pool |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM key (`nvapi-…`): MiniMax M3 / DeepSeek V4 / Gemma 4 chat + Llama Nemotron, the default embedding model for the knowledge store |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen key, MiMo V2.5, etc. |
| `TOKENROUTER_API_KEY` | TokenRouter key ([tokenrouter.com](https://www.tokenrouter.com)): Kimi K3 chat |
| `KNOWLEDGE_EMBEDDING_MODEL` | Optional: swap the knowledge store to another registered embedding model (fallback if NIM is down). After changing it, run `npx tsx --env-file=<env> scripts/reembed-knowledge.ts` to re-embed the store |
| `TAVILY_API_KEY` | Web search for the non-Gemini models ([tavily.com](https://tavily.com), free tier). Without it those models can't search the web |

Optional auth, integrations, channels and cron:

| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server-only knowledge writes; required in production |
| `APP_TIMEZONE` | Timezone for the date/time the model is given each request (default `Australia/Sydney`) |
| `ACCESS_PASSWORD` | Recovery password and confirmation for passkey or TOTP enrolment. Set it for a private deployment. |
| `AUTH_SESSION_SECRET` | A stable, random 32-byte secret for signed sessions and encrypted TOTP data. Required for production auth. |
| `AUTH_RP_ID` | Passkey relying-party ID, for example `your-app.example.com`. |
| `AUTH_ORIGIN` | Exact public application origin without a trailing slash, for example `https://your-app.example.com`. |
| `AUTH_OWNER_NAME` / `AUTH_TOTP_ISSUER` | Display label for the owner and authenticator app. |
| `CHAT_API_KEY` | Bearer token for non-browser calls to `/api/chat`, including the Discord bot. Set the same value in both environments. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Google OAuth, Calendar + Gmail |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` | Discord: bot token + legacy single channel (fallback for the per-purpose ids below) |
| `DISCORD_ASK_CHANNEL_ID` | The one Discord channel the bot converses in (`#ask-zuychin`) |
| `DISCORD_CH_BRIEFING` / `_REMINDERS` / `_TASKS` / `_CALENDAR` / `_BILLS` / `_COWORKING` / `_SYSTEM` | Per-purpose notification channels; each falls back to `DISCORD_CHANNEL_ID` (`_SYSTEM` stays silent unless set) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | Telegram channel |
| `CRON_SECRET` | Bearer token required by the cron endpoints |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web-push key pair (`npx web-push generate-vapid-keys`); either unset = push disabled |
| `VAPID_SUBJECT` | Your `mailto:` contact for the push service, e.g. `mailto:you@example.com`. Required: push stays disabled without it |
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
is safe to run more than once - re-run it after upgrading to pick up new tables and columns.

The same script creates the unified knowledge domain (`knowledge_documents`,
`knowledge_chunks`, `knowledge_links`, `knowledge_assertions`,
`knowledge_events`, `knowledge_sync_state` and `knowledge_suggestions`) plus atomic
replacement RPCs and chunk-level hybrid recall. Knowledge tables are server-only under
RLS, so production requires `SUPABASE_SERVICE_ROLE_KEY`.

The `-- ===== Knowledge graph wave =====` block at the bottom adds `vault_graph_snapshot` and
`vault_page_links`, which back the cached `/graph` payload and the derived vault adjacency.
Both are rebuildable from the repo, so they can be dropped and regenerated at any time; the
graph still works without them, it just rebuilds from GitHub on every load.


### Web authentication

For a private production deployment, set `ACCESS_PASSWORD`, `AUTH_SESSION_SECRET`,
`AUTH_RP_ID` and `AUTH_ORIGIN` before deploying. Generate `AUTH_SESSION_SECRET` once and
keep it stable:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

After signing in with the password, open **Security** in the sidebar, or visit `/security`.
Add a passkey using your device's biometric prompt, Windows Hello, Samsung Pass, a password
manager or a FIDO2 key. Register at least two passkeys on separate devices before relying on
them. The same screen creates a QR code for an authenticator app; confirm its six-digit code
to enable password-plus-TOTP recovery.

Passkeys are bound to the configured public domain. Use these values locally instead:

```env
AUTH_RP_ID=localhost
AUTH_ORIGIN=http://localhost:3000
```

The database script also creates the server-only `auth_passkeys`, `auth_challenges` and
`auth_totp` tables. Re-run it after upgrading so the auth schema is present before the first
passkey enrolment.

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
- The checklist icon in the header opens the **Notes** panel - undated tasks the agent has
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
| GET / POST | `/api/auth/passkey` | List passkeys or run WebAuthn sign-in, enrolment and removal actions |
| GET / POST | `/api/auth/totp` | Read TOTP status, set up an authenticator app, verify recovery codes |
| GET | `/api/council` | Open councils and participant rosters for the council dashboard |
| GET | `/api/council/[code]` | One council's status and transcript for the council dashboard |
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
| GET | `/api/vault/graph` | Vault as graph data: nodes with lifecycle/cluster/centrality/health, edges, link suggestions. Served from a cached snapshot, revalidated in the background; `?refresh=1` forces a rebuild |
| GET | `/api/vault/search` | Semantic (hybrid keyword + vector) page search for the graph's search box |
| GET | `/api/vault/suggestions` | Link candidates for one page (`?path=`), ranked by cosine against stored vectors |
| GET/PUT/DELETE | `/api/vault/page` | Read / edit / cascade-delete a wiki page |
| POST/DELETE | `/api/vault/link` | Create / remove a bidirectional wikilink between two pages |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |
| GET | `/api/admin/runs` | Agent-run traces (list, or `?id=` for the full event timeline) |
| GET/POST/PUT/DELETE | `/api/admin/memories` | List / add / edit / delete extracted memory facts |
| GET/PUT/DELETE | `/api/admin/skills` | List custom + built-in skills, approve/edit drafts, delete |
| GET/POST | `/api/admin/reembed` | Re-embed progress / migrate the knowledge store to another embedding model (batched, resumable) |

Browser routes require the signed `zuychin-auth` session when authentication is enabled. The
public webhook, cron and headless-chat routes protect themselves with bearer credentials:
`CRON_SECRET` for cron endpoints and `CHAT_API_KEY` for `/api/chat`. See `src/proxy.ts` and
`src/lib/auth/guard.ts` for the enforcement boundary.

## Providers & Models

The chat model is chosen per message from the header dropdown (saved in `localStorage`). The
settings drop-up picks the embedding model - changing it (behind a confirm modal) migrates
the whole knowledge store to the new partition - and tunes hyperparameters. Only
providers whose API key is set show up in the UI. Discord/Telegram and cron always use the
default (Gemini Flash). The registry lives in [`src/lib/ai/providers.ts`](src/lib/ai/providers.ts),
so add models or providers there.

| Provider | Kind | Example models | Notes |
|----------|------|----------------|-------|
| Google Gemini | native | `gemini-3.6-flash`, `gemini-3.5-flash-lite` | Full features: grounding, thinking, vision, function calling |
| Google Gemini (free) | native | the same two ids | Same models on a free-tier project's key. Picking one routes the call through that key's own client, so it draws on the free quota instead of the paid project |
| DeepSeek | OpenAI-compatible | `deepseek-v4-flash`, `deepseek-v4-pro` | DeepSeek's own API. **Metered**, so it is kept out of the free sub-agent pool. Thinks by default: `/think` off sends `thinking: {type: "disabled"}` rather than paying for reasoning on every turn. `json_object` only, no `json_schema` |
| OpenRouter | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-s-2.1:free`, `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it` | Chat only |
| NVIDIA NIM | OpenAI-compatible | `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-pro`, `deepseek-ai/deepseek-v4-flash`, `nvidia/nemotron-3-ultra-550b-a55b`, `google/gemma-4-31b-it`, `google/diffusiongemma-26b-a4b-it`, `stepfun-ai/step-3.7-flash`, `z-ai/glm-5.2` | Free preview inference (MiniMax M3 & Gemma 4 are multimodal); also the non-Gemini **embedding** models (`llama-nemotron-embed-1b-v2`, `llama-embed-nemotron-8b`) |
| OpenCode Zen | OpenAI-compatible | `mimo-v2.5-free`, `deepseek-v4-flash-free`, `laguna-s-2.1-free`, `ling-3.0-flash-free` | Chat only; every model here takes a 131,072-token output budget |

How it works:

- One OpenAI-compatible client ([`openai-compat.ts`](src/lib/ai/openai-compat.ts)) serves
  OpenRouter, NVIDIA NIM and OpenCode Zen with streamed responses. Gemini keeps
  its own native path.
- MCP tool-calling works on all providers. If a model rejects tools, the request retries
  without them.
- Each model declares `supportsThinking` and `supportsSearch`. `/think` and `/search` are
  enforced on the server (so they hold on every channel) and the UI hides toggles a model
  can't use. Reasoning (`/think`) maps to Gemini `thinkingConfig`, OpenRouter `reasoning`,
  NIM `chat_template_kwargs.enable_thinking` and DeepSeek `thinking` + `reasoning_effort`.
  DeepSeek is the one provider that reasons unless told not to, so its branch runs on every
  request rather than only when `/think` is on.
- Web search works two ways depending on the model. Gemini uses native Google Search/Maps
  grounding. The OpenAI-compatible models can't reach the internet, so they get a `search_web`
  tool (backed by Tavily, see `TAVILY_API_KEY`): they call it on their own when an answer needs
  current info, and `/search` forces it. The `search_web` tool is intentionally not given to
  Gemini.
- Hyperparameters (temperature, top_p, max tokens) are optional, sanitized on the server and
  mapped per provider. NIM requests backfill NVIDIA's recommended defaults so models like
  MiniMax M3 always get a token budget.
- Max tokens is bounded **per model** by that model's output ceiling rather than one
  global cap, so the slider goes to 393,216 on DeepSeek's own V4 models, 131,072 on MiniMax M3,
  65,536 on Gemini 3.6 Flash, and 16,384 on Gemma 4 26B. Ceilings were measured against each
  platform (`models.get` for Gemini, `top_provider.max_completion_tokens` for OpenRouter, and
  direct `chat/completions` probes for NVIDIA NIM and OpenCode Zen, whose model lists omit them);
  DeepSeek's is read from its published 384K rather than probed.
  Requests are clamped to the resolved model's ceiling server-side, because exceeding it makes
  the provider reject the whole call instead of quietly truncating.
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
| `council_propose` | Draft a council and render a Launch card in chat; creates nothing until you click |
| `council_convene` | Open a council now and return a paste-in kickoff block per agent |
| `council_status` | How the open councils are going, or one council's state and recent transcript |
| `council_close` | Force a council closed and file the outcome, writing a verdict if none was given |

Agent runs additionally get `create_document` / `create_code_file` / `create_code_bundle`
(downloadable artifacts - generated documents are auto-embedded into the knowledge base),
`update_plan` (live step tracker), `use_skill` (loads a skill's full instructions -
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
| `council_transcript` | read | Read a council transcript without participating (the observer's tool) |
| `council_convene` | write | Open a council and get one ready-to-paste kickoff block per participant |
| `council_join` | write | Join a council you were invited to and receive the rulebook |
| `council_speak` | write | Say one thing, then block until someone replies (the fused primary tool) |
| `council_wait` | write | Block up to 30 s for a peer to speak; an empty result is normal, not an error |
| `council_pass` | write | Nothing to add this round, or leave the council for good |
| `council_conclude` | write | Closer-only: write the verdict, optionally create assigned implementation tasks, mirror to Discord and file a quarantined vault page |
| `council_work_status` | read | Campaign progress and per-agent task state, without claiming work |
| `council_work_next` | write | Claim or resume the caller's assigned implementation task |
| `council_work_heartbeat` | write | Record meaningful progress on an active task |
| `council_work_complete` | write | Submit a committed, verified task for closer review |
| `council_work_block` | write | Record a human or external dependency blocker |
| `council_work_review` | write | Closer-only: accept a task or return it with feedback |
| `council_dispatch` | write | Local host only: non-blocking multi-agent read returning JSON plus each owned agent's rendered turn |
| `council_open` | write | Local host only: open councils and their rosters as JSON, so an idle host can tell an unclaimed seat from a hand-driven one |

### zuychin-council

The debate tools plus six `council_work_*` tools make a **bounded decision room** and a
**durable implementation campaign** for your external coding agents. Ask the assistant for a
council and it drafts one: a card appears under its reply with a **Launch** button that starts
the whole thing on the local host. Nothing exists until you click - no session, no expiry, no
slot. For agents in desktop apps or on another machine, ask it to convene instead and paste the
generated block into each terminal. Either way the verdict lands in Discord `#coworking`.

An MCP server cannot wake an idle agent, but an agent inside its own loop is already calling
tools - so `council_speak` posts **and then blocks** for up to 30 s. One tool call is one turn,
handoff is sub-second, and it runs on stateless serverless with no daemon. Ordering is total
per session (compare-and-swap on one row); deadlock is covered by a quorum gate, an 8 s
silence election, a 50 s floor TTL, an SQL-derived escalation ladder, hard caps and a
5-minute sweep cron. Agents driven by the local ACP host skip the long poll entirely - the host
has no per-tool-call timeout, so it pushes their turns instead - but they go through the same
server-side ordering, which is what lets pushed and hand-attached agents share one council.

Council output is filed to the vault as `trust: untrusted`, `status: suggested` at
`wiki/synthesis/council-<code>.md`, so an unreviewed agent debate cannot outrank
human-reviewed material in the assistant's own recall. Promote it yourself with `vault_ingest`
if it earns it. Council messages are never embedded or indexed anywhere else.

The council and campaign tables live in the `-- ===== Council wave =====`,
`-- ===== Council work campaign wave =====` and `-- ===== Council ACP host wave =====` blocks at
the bottom of `supabase-setup.sql`; run all three in the Supabase SQL Editor before first use.

Knowledge tools pin the default embedding partition and no user filter, so external agents
read and write the **same global store** the assistant uses. Vault writes pin the vault's
dominant embedding partition so pages never fragment across models. `vault_delete` is
deliberately not exposed - page removal stays with the assistant and the graph UI.

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
assistant's own context - only hand the key to agents you trust.

### Run a council on the local ACP host

`scripts/council-host.mts` is a long-lived local process that owns the agents. Zuychin is
serverless and cannot start anything on your machine, and a browser page has no `child_process`,
so the host is the only place the Agent Client Protocol client can live. It holds **one ACP
session per agent for the whole council** (so agents keep their context between turns), mediates
every file and terminal call against that agent's worktree, pushes each turn with
`session/prompt`, and serves a loopback control channel to `/council`.

Setup:

1. Copy `scripts/council-agents.example.json` to `scripts/council-agents.json`. It is gitignored
   because it describes local commands. **The host takes the command only from this file, never
   from the council record**, so convening a council can never choose what runs on your machine.
2. `agents` holds one adapter per provider, each with a `mode`. `acp` means the host drives it;
   `shell` is the old one-process-per-turn behaviour. Verify the ACP entry point against your
   installed version - `claude` itself has no `--acp` flag, so `claude-code` uses Zed's adapter
   (`npx -y @zed-industries/claude-code-acp`). `scripts/council-acp-probe.mts` starts a candidate
   command exactly as the host will and reports whether the handshake, the MCP server passed in
   `session/new`, streaming and permission requests all work:
   `npx tsx --env-file=.env.local scripts/council-acp-probe.mts --prompt -- codex acp`.
   Hand `docs/COUNCIL_AGENT_SETUP.md` to an agent and it can do this step itself (`docs/` is
   gitignored, so that guide lives only in the working copy).
3. `instances` gives unique participant names pointing at those adapters, for example `codex-1`
   and `codex-2` both on `codex`, or three Claude instances on `claude-code`.
4. Run the `-- ===== Council ACP host wave =====` block at the bottom of `supabase-setup.sql`.

**Where the host points.** `mcpUrl` in `council-agents.json` decides which app instance serves the
council. Pointed at the deployed URL, a council needs no local dev server at all and `/council` on
the deployed site shows it; pointed at `http://localhost:3000/api/mcp/mcp`, you get local changes but
must keep `npm run dev` running. Both hit the same Supabase, so the councils are the same councils.

**Running the host.** `scripts/council-host-start.cmd` starts one for this checkout, deriving every
path from its own location. An idle host is a single ~88 MB node process with two timers that return
immediately, so leaving it running costs approximately nothing. To have it always available, drop a
one-line shim in your Startup folder that runs that script hidden:

```bash
node --no-warnings --import tsx --env-file=.env.local scripts/council-host.mts --repo .
```

Convene with the CLI, which starts the host if it is not already running:

```bash
npx tsx --env-file=.env.local scripts/council-launch.mts \
  --topic "Should we adopt X?" --brief "Constraints and current evidence" \
  --agents claude-a,claude-b,codex-1 --closer claude-a \
  --type code --repo /path/to/repo --dry-run
```

`--dry-run` stops before anything exists in Postgres or on disk. Remove it to convene. Pick the
discussion template with `--type`: `debate` for decisions and dissent, `code` for implementation
and test planning, `research` for evidence and confidence, `audit` for ranked risk findings, or
`debug` for reproduction and root-cause work. The host keeps running after the CLI exits; stop it
from `/council` or by killing the printed PID.

**Isolation is enforced, not conventional.** Each agent gets its own git worktree and branch, and
every `fs/read_text_file`, `fs/write_text_file` and permission request is checked against it with
`path.relative` over `realpath`, so neither a sibling directory sharing the same prefix nor a
symlink planted inside the tree gets out. Terminals are created with `cwd` forced to the worktree.
Anything outside it prompts you in `/council` and is **denied** if nobody answers within 120 s.

**Turn dispatch.** The host polls `council_dispatch` every 1.5 s and pushes a rendered turn to any
agent with something to read or the floor. Ordering, quorum and floor election all stay in
Postgres: the host reads a tick and calls the same server-side election every long-polling agent
does, and computes no floor of its own. Delivery is at-least-once - the read cursor advances only
when the host confirms a turn landed, so killing the host mid-turn redelivers that batch instead of
skipping it. Agents it owns are marked `dispatch_mode`, which makes `council_wait` return
immediately for them and `council_speak` stop blocking, so an agent can never be driven twice.

`/council` shows the connection state, each agent's worktree, branch and live ACP activity, the
permission queue, and a convene form. It reaches the host at `127.0.0.1:8787-8791` with a token
you pair once using the code the host prints; requests without it get 401, and only allow-listed
origins are answered. The token and code are reused from `../.council-host/host-<port>.json` across
restarts, so a host that starts hidden at login does not silently invalidate your pairing - delete
that file to rotate them. From `localhost:3000` there is no browser permission prompt; from a
deployed origin Chrome raises its Local Network Access prompt, and denying it leaves the page in
observe-only mode. A phone is observe-only by definition - there is no host on it.

An open council the host did not create gets an **Adopt** button in the same rail, which hands it
over on the spot. Set `"autoAdopt": true` under `host` in `council-agents.json` to have an idle
host do that unprompted, which is what makes a council convened from a phone actually start. It is
off by default and deliberately stricter than the button: it claims a council only when it can run
*every* live participant, since a half-adopted council leaves seats nobody is driving and nobody
watching. Authenticated `/health` also lists the instances this machine can run, which is how the
chat proposal card knows a name will not fail at spawn.

Agents whose vendor has no ACP support yet (antigravity today) stay on `shell` mode: they get a
worktree and their turns still work, but through the old long-poll with no permission mediation
and no streamed activity. The adapter's `warn` string is surfaced in `/council` so a degraded
participant is visible rather than silently different.

When the closer includes `workItems` in `council_conclude`, each agent claims only its assigned
work from `council_work_next`. It heartbeats progress, commits and verifies its change, then stops
at `awaiting_review`; the closer accepts it with `council_work_review` or sends it back with
feedback. The campaign completes only when every item is verified. The host supervises this on the
same ACP sessions, so a separate supervisor script is no longer needed.

If the host or the machine restarts, reattach to a running council - the agents get fresh sessions,
keep their worktrees, and are redelivered whatever they never acknowledged:

```bash
npx tsx --env-file=.env.local scripts/council-host.mts --repo /path/to/repo --attach CN-XXXX
```

An agent on **another machine** needs none of this: no host, no ACP adapter, no checkout of this
repo. It adds the MCP server itself and joins by hand. `/council` has a **Show brief** panel
holding a paste-in setup brief for exactly that, with the API key left as a placeholder to fill in.
Give that seat a name this machine has *not* configured (`codex-remote`, `workstation-1`), or the
local host's claim rule takes it while it is still `invited`, before the remote agent joins.

Attaching is also how you get a **mixed council**, because convening from the host makes every
named participant host-owned. Convene the ordinary way with all the names, paste the kickoff block
into whatever you are driving by hand, then attach. The host claims only participants that are
configured locally *and* either still `invited` or already in `dispatch_mode`, so an agent someone
is already polling by hand is left alone rather than run twice under one name.

Review and merge the named worktree branches yourself when the campaign is complete.

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

When a request produces a file - a report, a code file, or a zip bundle - the bot delivers it as
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
table (`docs/` is gitignored, so it lives only in the working copy).

| Endpoint | Schedule | Body |
|----------|----------|------|
| `/api/cron/daily-briefing` | Daily 7:00 AM | `{}` |
| `/api/cron/reminders` | Every 15 min | `{}` |
| `/api/cron/scheduled-tasks` | Every 5–15 min | `{}` |
| `/api/cron/email-triggers` | Every 4 h | `{}` |
| `/api/cron/initiative` | Every 1–2 h | `{}` |
| `/api/cron/run-review` | Daily (quiet hour) | `{}` |
| `/api/cron/conversation-cleanup` | Weekly (quiet hour) | `{}` |
| `/api/cron/proactive` | As needed | `{ "type": "morning_briefing" }` |
| `/api/cron/vault-lint` | Weekly (quiet hour) | `{}` |
| `/api/cron/council-sweep` | Every 5 min | `{}` |

Proactive types: `morning_briefing`, `daily_check`, `reminder`.

The reminders job covers imminent calendar events and todos due within 24 h (re-nagged
roughly daily while overdue). Scheduled-tasks is the dispatcher for user-created tasks
(`manage_scheduled_task`); email-triggers turns bills/deadlines found in the inbox into
todos and calendar events, deduplicated via the `processed_emails` ledger. Initiative asks
the agent whether anything warrants reaching out - code gates (quiet hours, spacing, daily
cap, user-active skip) run before any model call, so most invocations cost nothing.
Run-review reads the previous day's agent runs and files draft skills for anything that
failed or ran expensive; drafts wait for approval in `/admin`.
Conversation cleanup reviews inactive chats weekly, surfaces only conservative deletion suggestions in
Dashboard, and never deletes a conversation without your selection.

## Second Brain (optional)

A long-term research/study knowledge base following Andrej Karpathy's LLM-wiki pattern:
the agent writes interlinked Markdown wiki pages into a **private GitHub repo** and keeps
them cross-linked, catalogued and healthy. It complements (not replaces) pgvector RAG -
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
`vault_lint` (suggest/auto curator - also runs on the weekly cron above with `curator:`
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


### Knowledge cosmos (`/graph`)

The **Graph** button in the header (or `/graph`) opens the vault as a dark planetarium. It is
deliberately dark-only whatever the app theme is set to. Every visual property carries
information: a page is a star, its size is its degree, its brightness is its PageRank
centrality, and its shape says what kind of page it is - a crisp main-sequence star is
reviewed, a hazy protostar has never been reviewed, a swollen red giant has gone stale, and a
white dwarf has been archived or superseded.

- **Lenses** (keys `1`-`5`) recolour without moving anything: category, constellation, trust,
  health, recency. Each ships its own legend, and a lens that fades pages into the background
  hides their labels too, so no name is ever left floating over an invisible star.
- **Trust** shows one steel-blue baseline for reviewed pages with the exceptions picked out in
  colour, and its legend rows are filters with counts - clicking *Unreviewed or suggested*
  narrows the graph to exactly the pages waiting on you.
- **Semantic search** (`/` to focus) runs hybrid keyword + vector recall, so "attention" finds
  pages about transformers. Matches flare, everything else fades to dust. A local substring
  pass answers instantly while the request is in flight.
- **Routes** answer "how are these two connected": right-click two stars, and the shortest
  chain of links lights up as a corridor with every hop listed. It says so plainly when no
  route exists, which itself tells you the vault is fragmented there.
- **Constellations** are detected communities (label propagation), each with its own hue, a
  soft nebula, and a name taken from its most central page. A cohesion force pulls each one
  together so they physically separate.
- **Health** surfaces what the vault lint cron finds - orphans, links pointing at nothing,
  stale pages, malformed frontmatter, unreviewed pages - as a filter over the graph. Filtering
  to *unreviewed* turns the view into a review queue, which is where council output lands.
- **Time travel** replays the vault's growth from a scrubber; stars ignite in creation order.
  Page dates are real, link dates are inferred from their endpoints, and the UI says so.
- **Section systems**: isolating a page ("System", or double-click a star) turns its own
  headings into planets orbiting it, with sub-headings as their moons - sized by how much prose
  each section holds, on concentric orbits that scale to any heading count. Click a planet to
  read that section; the page panel scrolls to it. Neighbouring pages stay stars, because a
  wikilink is symmetric and has no parent to orbit, whereas a heading really does belong to its
  page.
- **Gravity wells** ranks the most central and most weakly held pages.
- Click a page to read, edit or delete it - deletion strips every reference in other pages,
  the `index.md` entry and the pgvector row in one atomic commit. Click a connection to remove
  it in both directions.
- **Suggested arcs** are curved cyan links between similar-but-unlinked pages. The page panel
  also lists candidates for that one page with a checkbox column, so several can be accepted at
  once (each as its own commit).
- Every view is addressable: lens, query, selection, route ends, local mode and the timeline
  position all live in the URL, so a view can be bookmarked or pasted into chat.
- Labels are an HTML overlay with distance culling rather than per-node textures, and a bloom
  pass turns itself off above 600 nodes or on a software renderer. `Full effects` in the
  Explore panel is the manual override.

You can still point Obsidian at a clone of the repo - the on-disk format is plain
Markdown + wikilinks.

## Deployment

- Web app: Vercel. Add every `.env.local` variable under Project > Settings > Environment
  Variables. Update the Google OAuth redirect URI and the Telegram webhook URL to your
  production domain. Set `AUTH_RP_ID` and `AUTH_ORIGIN` to that exact domain before enrolling
  a passkey. Do not rotate `AUTH_SESSION_SECRET` without also resetting TOTP recovery data.
- Apply `supabase-setup.sql` after deployment upgrades. It is idempotent and includes the
  passkey, TOTP and council schema.
- Give the Discord bot `CHAT_API_KEY` and the web app the identical value; cron callers need
  `Authorization: Bearer <CRON_SECRET>`.
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
│   │   ├── council-card.tsx            # Proposed-council card in chat, with the Launch button
│   │   └── styles.ts                   # Chat page style objects
│   ├── graph/page.tsx                  # 3D knowledge-graph view of the vault
│   ├── council/
│   │   ├── page.tsx                    # Live council view + local-host control surface
│   │   ├── host-client.ts              # Loopback host probe, pairing, WebSocket client, launch
│   │   └── remote-setup.ts             # Paste-in brief for agents on other machines
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
│   ├── council/                        # Deliberation room: protocol constants, store, long-poll + host dispatch, renderers, campaign
│   ├── vault/                          # Second brain: GitHub client, ingest, lint, graph ops, page index
│   ├── artifacts/                      # Generated-file storage (documents, code, zips)
│   ├── integrations/                   # Google Calendar + Gmail
│   └── messaging/                      # Discord + Telegram + web-push services
├── proxy.ts                            # Cookie auth proxy (Next 16 middleware convention)
public/sw.js                            # Service worker: push display + click-through
discord-bot/
├── bot.js                              # Discord Gateway bot + health server
└── Procfile                            # Render deployment
scripts/
├── council-host.mts                    # Local ACP host: agent sessions, permission gate, dispatch loop, control channel
├── council-host-paths.mts              # Worktree containment, command resolution, process-tree kill
├── council-launch.mts                  # CLI onto the host: preflight, start or attach, convene
├── council-acp-probe.mts               # Verify a vendor's ACP command the way the host will run it
├── council-host-start.cmd              # Start a host for this checkout (portable; used by the Startup shim)
├── council-agents.example.json         # Adapter template (copy to council-agents.json, gitignored)
├── evaluate-knowledge.ts               # Knowledge-store retrieval eval
└── reembed-knowledge.ts                # Manual store re-embed
supabase-setup.sql                      # One-shot database setup script
```

## License

[MIT](LICENSE) © Duy Nguyen
