# Zuychin Assistant

A personal AI chatbot powered by **Gemini 3 Flash** with RAG memory, multimodal file uploads, MCP tool integrations (Google Calendar, Gmail, to-do list), and multi-channel messaging via Discord and Telegram.

## Features

- 🧠 **RAG Memory** — pgvector embeddings for persistent long-term context
- 💬 **Chat History** — Conversation sidebar with auto-titling and CRUD
- 📎 **File Upload** — Images, video, PDFs, code files (up to 20 MB)
- 🔍 **Google Search** — Real-time web grounding via `/search` command
- 💭 **Think Mode** — Deep reasoning via `/think` command
- 🛠️ **MCP Tools** — Calendar events, Gmail, to-do list, knowledge base, notes
- 📡 **Multi-channel** — Web UI, Discord bot, Telegram bot
- ⏰ **Cron Jobs** — Daily briefing, event reminders, proactive check-ins
- 📄 **Export** — Export conversations to PDF or DOCX
- 🎛️ **Admin Dashboard** — Stats, personality config at `/admin`
- 🔒 **Password Auth** — Cookie-based access control

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript |
| AI | Gemini 3 Flash, Gemini Embedding 2 |
| Database | Supabase (PostgreSQL + pgvector) |
| Integrations | Google Calendar API, Gmail API |
| Messaging | Discord.js, Telegram Bot API |
| Export | docx, pdfkit |
| Hosting | Vercel, Render |

## Quick Start

### 1. Install

```bash
git clone <your-repo-url>
cd zuychin-assistant
npm install
```

### 2. Environment Variables

```bash
cp .env.example .env.local
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `GEMINI_API_KEY` | Google AI Studio API key |
| `ACCESS_PASSWORD` | Password for web UI access |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_CHANNEL_ID` | Discord channel to listen on |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for cron messages |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook secret for Telegram |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth refresh token |
| `CRON_SECRET` | Bearer token for cron endpoints |

### 3. Google OAuth Setup

Visit `http://localhost:3000/api/auth/google/callback` to start the OAuth flow. Copy the refresh token into `.env.local`.

### 4. Run

```bash
npm run dev
```

- Web UI: [http://localhost:3000](http://localhost:3000)
- Admin: [http://localhost:3000/admin](http://localhost:3000/admin)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | RAG chat with file + thinking support |
| GET/POST/DELETE | `/api/conversations` | Conversation CRUD |
| POST | `/api/export` | Export to PDF or DOCX |
| POST | `/api/auth` | Login |
| DELETE | `/api/auth` | Logout |
| GET | `/api/auth/google/callback` | Google OAuth setup |
| POST | `/api/telegram/webhook` | Telegram bot webhook |
| POST | `/api/cron/daily-briefing` | Morning briefing (emails + calendar) |
| POST | `/api/cron/reminders` | Imminent event reminders |
| POST | `/api/cron/proactive` | Proactive check-ins |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |

## Discord Bot

The Discord bot runs as a separate process in `discord-bot/`:

```bash
cd discord-bot
npm install
node bot.js
```

## Cron Jobs

Configure external cron (e.g. cron-job.org) to POST with `Authorization: Bearer <CRON_SECRET>`:

| Endpoint | Schedule | Body |
|----------|----------|------|
| `/api/cron/daily-briefing` | Daily 7:00 AM | `{}` |
| `/api/cron/reminders` | Every 15 min | `{}` |
| `/api/cron/proactive` | As needed | `{ "type": "morning_briefing" }` |

Proactive types: `morning_briefing`, `daily_check`, `reminder`

## Project Structure

```
src/
├── app/
│   ├── page.tsx                        # Chat UI
│   ├── login/page.tsx                  # Login page
│   ├── admin/page.tsx                  # Admin dashboard
│   └── api/
│       ├── auth/                       # Login/logout + Google OAuth
│       ├── chat/route.ts               # RAG chat endpoint
│       ├── conversations/route.ts      # Conversation CRUD
│       ├── export/route.ts             # PDF/DOCX export
│       ├── telegram/webhook/route.ts   # Telegram bot
│       ├── cron/
│       │   ├── daily-briefing/         # Morning briefing
│       │   ├── reminders/              # Event reminders
│       │   └── proactive/              # Proactive messages
│       └── admin/
│           ├── status/                 # Bot stats
│           └── personality/            # System prompt
├── lib/
│   ├── gemini.ts                       # Gemini client + embeddings
│   ├── supabase.ts                     # Supabase client
│   ├── db.ts                           # Database layer
│   ├── types.ts                        # Shared types
│   ├── google-auth.ts                  # Google OAuth2
│   ├── ai/
│   │   ├── rag-service.ts              # RAG pipeline
│   │   └── mcp-service.ts              # MCP tools
│   ├── integrations/
│   │   ├── calendar-service.ts         # Google Calendar
│   │   └── gmail-service.ts            # Gmail
│   └── messaging/
│       ├── discord-service.ts          # Discord REST API
│       └── telegram-service.ts         # Telegram Bot API
├── middleware.ts                        # Auth middleware
discord-bot/
└── bot.js                              # Discord Gateway bot
supabase/
└── migrations/                         # SQL schema
```

## License

Private — personal use only.
