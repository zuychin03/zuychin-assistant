# Zuychin Assistant

A personal AI chatbot you can talk to from the web, Discord, or Telegram. It lets you
switch chat model providers per message (Google Gemini, OpenRouter, NVIDIA NIM, OpenCode Zen),
keeps long-term memory with a pgvector RAG store, handles file uploads, and can use a set of
tools (Google Calendar, Gmail, a to-do list and a knowledge base) plus Google Search and Maps
grounding.

## Features

- Multi-provider chat: switch the model per message between Gemini, OpenRouter (Nemotron),
  NVIDIA NIM (MiniMax M3, DeepSeek V4) and OpenCode Zen (MiMo), straight from the chat header
- RAG memory: a model-aware pgvector store. Each embedding model keeps its own memory
  partition (Gemini 768-dim, Nemotron 2048-dim), with rerank, summarization and dedup
- Chat history: conversation sidebar with auto-titling and full CRUD
- File upload: images, audio, video, PDFs and code/text files (up to 20 MB)
- MCP tools: 11 tools covering calendar, Gmail, a to-do list, notes, knowledge search,
  current time and recent conversations
- Web search: Gemini grounds answers with real-time Google Search (inline citations + URL context); the other models get a `search_web` tool so they can pull live info too, automatically or on demand with `/search`
- Maps grounding: location questions get routed to Google Maps (places, directions, hours)
- Think mode: a deep-reasoning toggle (`/think`), tunable per model
- Hyperparameters: optional temperature / top-p / max-tokens controls in the header
- Dark / light mode: theme toggle that remembers your choice and respects the system setting
- Multi-channel: web UI, Discord bot and Telegram bot all share the same RAG pipeline
- Cron jobs: daily briefing, event reminders and proactive check-ins
- Export: save conversations to PDF or DOCX (Markdown-aware)
- Admin dashboard: stats and a live personality/system-prompt editor at `/admin`
- Password auth: cookie-based access control via middleware

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Chat models | Gemini 3 Flash, OpenRouter (Nemotron), NVIDIA NIM (MiniMax M3, DeepSeek V4), OpenCode Zen (MiMo, Nemotron) |
| Embeddings | Gemini Embedding 2 (768d), OpenRouter Nemotron Embed VL 1B v2 (2048d) |
| Grounding | Google Search, Google Maps, URL context (Gemini path only) |
| Database | Supabase (PostgreSQL + pgvector) |
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
| OpenRouter / NVIDIA NIM / OpenCode Zen keys | Optional, extra chat models (and the free embedding model on OpenRouter) |
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
| `OPENROUTER_API_KEY` | OpenRouter key (Nemotron chat + Nemotron embeddings) |
| `OPENROUTER_SITE_URL` | Optional `HTTP-Referer` for OpenRouter rankings |
| `OPENROUTER_APP_NAME` | Optional `X-Title` for OpenRouter rankings |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM key (`nvapi-…`), MiniMax M3 / DeepSeek V4 |
| `OPENCODE_ZEN_API_KEY` | OpenCode Zen key, MiMo V2.5, etc. |
| `TAVILY_API_KEY` | Web search for the non-Gemini models ([tavily.com](https://tavily.com), free tier). Without it those models can't search the web |

Optional auth, integrations, channels and cron:

| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server writes (falls back to the anon key) |
| `ACCESS_PASSWORD` | Password for web UI access (leave empty to disable auth) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Google OAuth, Calendar + Gmail |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` | Discord channel |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | Telegram channel |
| `CRON_SECRET` | Bearer token required by the cron endpoints |

### 3. Database

Open your Supabase project, go to the SQL Editor, and run the contents of
[`supabase-setup.sql`](supabase-setup.sql). It creates everything in one go: the pgvector
extension, all tables (`user_profiles`, `conversations`, `messages`, `embeddings`, `todos`),
the row-level-security policies, the `match_embeddings` search function and a default profile.
The script is safe to run more than once.

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

- Pick the chat model and embedding model from the dropdowns in the header.
- Toggle dark/light mode, start a new conversation, or open history from the header buttons.
- Open the sliders in the message bar to set temperature / top-p / max-tokens (optional).
- Prefix a message with `/think` for deeper reasoning or `/search` to force a web-grounded
  answer. These only apply to models that support them, and the UI hides toggles a model
  can't use.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | RAG chat with file, thinking, search and hyperparameters |
| GET | `/api/providers` | Available providers/models (filtered by configured keys) |
| GET/POST/DELETE | `/api/conversations` | Conversation list / create / delete |
| POST | `/api/export` | Export a conversation to PDF or DOCX |
| POST / DELETE | `/api/auth` | Login / logout |
| GET | `/api/auth/google/callback` | Google OAuth setup / token exchange |
| POST | `/api/telegram/webhook` | Telegram bot webhook (secret-header gated) |
| GET | `/api/telegram/test` | Telegram connectivity / config check |
| POST | `/api/cron/daily-briefing` | Morning briefing (emails + calendar) |
| POST | `/api/cron/reminders` | Imminent event reminders |
| POST | `/api/cron/proactive` | Proactive check-ins |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |

All routes except `/login`, `/api/auth`, `/api/cron`, `/api/chat` and `/api/telegram` require
the `zuychin-auth` cookie when `ACCESS_PASSWORD` is set (see `middleware.ts`).

## Providers & Models

The chat model is chosen per message from the header dropdown (saved in `localStorage`). A
second dropdown picks the embedding model, and a settings panel tunes hyperparameters. Only
providers whose API key is set show up in the UI. Discord/Telegram and cron always use the
default (Gemini Flash). The registry lives in [`src/lib/ai/providers.ts`](src/lib/ai/providers.ts),
so add models or providers there.

| Provider | Kind | Example models | Notes |
|----------|------|----------------|-------|
| Google Gemini | native | `gemini-3-flash-preview` | Full features: grounding, thinking, vision, function calling |
| OpenRouter | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free` | Chat plus the only non-Gemini embedding model (`nvidia/llama-nemotron-embed-vl-1b-v2:free`) |
| NVIDIA NIM | OpenAI-compatible | `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-pro`, `nvidia/nemotron-3-ultra-550b-a55b` | Free preview inference; MiniMax M3 is multimodal |
| OpenCode Zen | OpenAI-compatible | `mimo-v2.5-free`, `nemotron-3-ultra-free` | Chat only |

How it works:

- One OpenAI-compatible client ([`openai-compat.ts`](src/lib/ai/openai-compat.ts)) serves
  OpenRouter, NVIDIA NIM and OpenCode Zen with streamed responses. Gemini keeps its own
  native path.
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
| `read_email` | Read a full email body by message ID |
| `draft_gmail_reply` | Create a draft reply in Gmail |
| `send_email` | Compose and send a new email |
| `manage_todo_list` | Add / list / complete / delete to-do items |

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
- Honors `/search` and `/think` prefixes, downloads attachments (up to 20 MB) and chunks
  replies to Discord's 2000-char limit.
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

Proactive types: `morning_briefing`, `daily_check`, `reminder`.

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
│   ├── page.tsx                        # Chat UI (header selectors, theme, file upload, toggles)
│   ├── login/page.tsx                  # Login page
│   ├── admin/page.tsx                  # Admin dashboard
│   └── api/
│       ├── auth/                       # Login/logout + Google OAuth callback
│       ├── chat/route.ts               # RAG chat endpoint
│       ├── providers/route.ts          # Available providers/models
│       ├── conversations/route.ts      # Conversation CRUD
│       ├── export/route.ts             # PDF/DOCX export
│       ├── telegram/                   # Webhook + config check
│       ├── cron/                       # Briefing / reminders / proactive
│       └── admin/                      # Status + personality
├── lib/
│   ├── gemini.ts                       # Gemini client + model id
│   ├── supabase.ts                     # Supabase client
│   ├── db.ts                           # Database layer (messages, embeddings, todos, convos)
│   ├── types.ts                        # Shared types + MIME/size constants
│   ├── google-auth.ts                  # Google OAuth2 client
│   ├── ai/
│   │   ├── providers.ts                # Provider + chat/embedding model registry
│   │   ├── embeddings.ts               # Embedding dispatcher (Gemini / OpenAI-compatible)
│   │   ├── openai-compat.ts            # OpenRouter / NVIDIA NIM / OpenCode Zen client + tool loop
│   │   ├── rag-service.ts              # RAG pipeline; branches on provider + grounding fallback
│   │   ├── web-search.ts               # Real-time web search (Tavily) for non-Gemini models
│   │   └── mcp-service.ts              # MCP tool definitions + executors
│   ├── integrations/                   # Google Calendar + Gmail
│   └── messaging/                      # Discord + Telegram services
├── middleware.ts                       # Cookie auth middleware
discord-bot/
├── bot.js                              # Discord Gateway bot + health server
└── Procfile                            # Render deployment
supabase-setup.sql                      # One-shot database setup script
```

## License

Private, for personal use only.
