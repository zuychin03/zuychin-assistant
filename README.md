# Zuychin Assistant

A personal AI chatbot you can talk to from the web, Discord, or Telegram. It lets you
switch chat model providers per message (Google Gemini, DeepSeek, OpenRouter, NVIDIA NIM and Kilo),
keeps long-term memory with a pgvector RAG store, handles file uploads, and can use a set of
tools (Google Calendar, Gmail, a to-do list and a knowledge base) plus Google Search and Maps
grounding. It can schedule its own recurring tasks, watch the inbox for bills and deadlines,
and remember durable facts about you across conversations. It installs as a PWA with push
notifications, holds hands-free voice conversations (replies are spoken back), and can decide
on its own when something is worth reaching out about. The web app supports passkey sign-in
with device biometrics, password plus TOTP recovery, and councils where chat models
debate a question. Its second-brain wiki vault comes
with an interactive Obsidian-style 3D graph view where pages and links can be inspected,
edited and deleted in place.

## Features

- Multi-provider chat: switch the model per message between Gemini 3.8 Flash / 3.5 Flash-Lite,
  DeepSeek V4.1 Flash / V4 Pro, OpenRouter, NVIDIA NIM and Kilo, straight from the chat header.
  Retired model IDs resolve to replacements; unavailable gateways are hidden and excluded from workers
- Model catalogue: a daily check lists each provider's models, tests new free ones (chat, tool
  call, forced tool call, vision) and adds those that pass to the picker marked New. A model that
  drops off its provider's list twice is marked Missing but stays selectable. Worker runs and
  fallbacks use a discovered model only after you approve it in `/admin`; paid models are tested
  only when you press Test. Remove takes any model except the default out of every selectable
  list until you restore it, and a discovered model its provider has retired can be deleted.
  Embedding, speech, transcription, rerank, page reading, image, decision, live voice and
  translation models are listed and tested the same way, under their own tabs; for the last six
  you can choose the model a feature uses, or leave it on the first tested, approved one. The
  models in use are tested every day, and a notice goes out 30 and 7 days before a
  provider retires one. Each tab folds into sections (needs attention and in use open; other
  free, paid and removed models folded) with one line per model. Cloudflare Workers AI is listed
  too; when its free daily allowance runs out it rests until the reset, with one notice
- Model awareness: every chat model has purpose tags (research, coding, reasoning and more) and
  a speed measured from recent calls. A lookup on free sources drafts each model's profile, which
  you approve in `/admin` before the info modal or the agent uses it. Agent mode picks sub-agents
  by purpose, can ask or compare models directly, and rates the workers it used
- RAG memory: a model-aware pgvector store. Each embedding model keeps its own memory
  partition (Gemini 768-dim, Nemotron 2048-dim), with rerank, summarization and dedup. Chat
  search embeds the message as a query, and every search reads its similarity cut-off from the
  active embedding model, so a switch does not silently drop real matches. When a rerank model is
  approved, chat recall puts memories and knowledge in order with it (1.5 second limit, keyword
  ranking otherwise), and the reply details say which ranking ran
- Decision model: a small model that answers yes/no and score questions (Gemini Decision 1 by
  default) routes agent requests and decides whether a turn is worth remembering. Text a tool
  fetched is checked for prompt injection, and a flagged turn skips the memory extractor. Each
  question has a 3 second limit, and the old path runs when no decision model answers
- Photo search: photos saved through Capture, and vault photos indexed from Knowledge >
  Maintenance > Index photos (20 a run), are found by their image and their text. A cited photo
  shows as a thumbnail in web chat and is sent with the reply on Telegram and Discord
- Chat history: conversation sidebar with auto-titling and full CRUD
- Projects: group conversations into collapsible sidebar sections, each with its own
  instructions injected into every chat inside it; extracted facts can be scoped to a
  project so they only surface in that project's chats
- File upload: images, audio, video, PDFs and code/text files (up to 7 MB in web chat and Discord,
  where the file travels inside the request; Telegram files up to 20 MB)
- MCP tools: two dozen tools covering calendar, Gmail, a to-do list, notes, knowledge search,
  message-history search, the second-brain vault, scheduled tasks, current time and recent
  conversations
- Passkey-first PWA sign-in: WebAuthn device biometrics, PIN or a hardware security key with
  short-lived signed sessions; password confirmation protects enrolment and TOTP provides a
  recovery path
- Councils: a debate between chat models from the selectable list, run on the server, so it
  can be started from a card in the chat, a phone or Telegram and keeps going after the page closes.
  Watch it live at `/council`, pause it, and accept its verdict or send it back for more rounds.
  **Research first** runs one web search (and, if ticked, a search of your notes) before round 1,
  so seats argue from cited sources. Councils of coding agents on your own machine have moved to Converoom
- Per-agent credentials: the dashboard's **Agents** panel mints a setup brief for each coding agent,
  at a read-only, notes or full access level you choose. The brief carries a short-lived claim rather
  than a key, so nothing durable travels through the clipboard. Every key is tracked, shows its last
  use, and is revocable on its own
- Voice conversations: send a Telegram voice note or tap the web mic, and the reply is spoken
  back with Gemini TTS, streamed so speech starts in a couple of seconds. The web mic runs a
  hands-free loop: silence auto-sends, the reply plays, the mic reopens - say
  "That's enough, thank you" (or tap End) to end it. Each sentence is spoken as soon
  as it is written, while the rest of the reply still streams. While a voice turn waits on
  tools or agents, a short phrase such as "Just a minute" fills the silence. During a voice
  chat a star chart takes the message bar's place and shows each step: a wave runs out
  through the stars as you speak, lights hop between stars while it thinks, a red route
  traces tool use, and the whole field pulses with the spoken reply. Telegram voice
  notes are answered with a voice note too. Spoken replies fire only on voice input
- On-box speech-to-text: with the optional `stt-service` running, web voice turns are
  transcribed on your own server by Moonshine tiny, so any chat model can answer them and the
  audio never leaves the host. The transcript is sent as a normal message marked "Spoken", and
  the model is told it may hold recognition errors. The service runs only while voice is in use:
  tapping the mic starts it, and it exits after 10 quiet minutes. While its model loads, the
  voice stage says "Getting ready" and its stars switch on one by one; the mic opens once it is
  ready (or after 15 seconds), so the first turn is not slowed. The on-box voice starts loading
  next, while you speak: the box's small CPU loads the two faster one after the other.
  If the service is unset, busy or fails, the turn falls back to sending the audio to Gemini as
  before. The transcription order on `/admin#models` can add an approved API model (Gemini,
  Groq Whisper or OpenRouter): on-box only (the default), on-box first, API first or API only;
  sending the audio stays the last step in every order. Telegram voice notes of up to 5 minutes are transcribed the same way, in 30-second
  pieces, so any chat model can answer them; they fall back to audio on the same terms. A longer
  Telegram voice note or audio file comes back as a transcript with a Save to Capture button.
  Discord voice messages are transcribed too: up to 5 minutes the transcript is your message, and
  over 5 minutes the reply is the transcript
- On-box speech out: with the optional `tts-service` running, replies are spoken by a small local
  model (tiny-voca, English) instead of Gemini TTS. First audio takes about half a second on a
  1 GB box, and the reply text never leaves the host. If the service is unset, busy, loading or
  cannot read the text (not English), the same request falls back to the backup voice before any
  audio plays: any approved speech model chosen on `/admin#models` (Gemini, OpenRouter or Groq),
  or Gemini when none is chosen. Telegram voice replies follow the same rules. Discord gets a `reply.wav` attachment when
  the saved voice preference is "always". The `voice` preference takes `speechEngine` (`auto`,
  `gemini` or `local`) and `localVoice` (`M2` or `F2`). In Free only, the local voice needs no
  Gemini key
- Agent mode: complex requests are auto-routed (or forced with the agent switch / `/agent`)
  to a multi-step agent loop with live step streaming, parallel sub-agents, reusable skills
  and downloadable artifacts (documents, code files, zip bundles). Sub-agents default to
  free fast models (Nemotron 3.5 Lightning on NIM and OpenRouter, GLM-5.3 Flash, then approved free
  tool-capable models tagged Fast or whose last test answered within 10 seconds), with Gemini 3.5 Flash-Lite for simple fallback subtasks and 3.8 Flash
  for complex ones. Metered models stay out of the free worker pool
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
- Today panel: a collapsible panel beside the chat (docked on wide screens, a sheet on phones)
  draws the day to time scale with a now line, then what's coming up, what's due, other
  to-dos and scheduled tasks. Ticking a to-do completes it, and Skip beside the tick closes it as
  not done. Chat starters come from the same
  day: the next event, the most urgent to-do and the study cards due today
- Reply sources: each reply records the facts, memories, vault pages and tools it used, and
  the chat shows them as a small chart with a numbered list and a link into the Cosmos
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
- To-dos: the agent keeps a to-do list you can tick off or skip in the Today panel, and it never
  reminds you about a closed one again. A skipped task is never reported as done. Pending
  undated tasks are surfaced once a day, at the end of the first reply: up to three titles
  as a list, cut on a whole word, and a count of the rest
- Library: `/knowledge` provides a searchable document library grouped by page type with a
  reviewed/unreviewed filter, chunk inspection, explainable hybrid recall, grounded answers
  with abstention, a lifecycle timeline, safe corrections/promotions/archives/merges, and a
  governed maintenance queue. Each page shows a chart of the pages linking in and out, and
  suggests possible connections ranked by similarity
- Research workbench: `/research` holds a research question with its chosen Library sources,
  notes tied to source passages and a side-by-side evidence comparison
- Study: `/study` turns saved passages into cards. A model drafts a recall, explain or
  worked-exercise question with a reference answer, **Get feedback** compares your answer
  with the reference, and FSRS schedules reviews under a daily limit
- Capture inbox: `/capture` collects links, PDFs, passages, photos and audio recordings. Opening
  a link or PDF in Review reads its text into an editable Source text section. Pages the server
  can't read go through Tavily. A scanned PDF can be read page by page by a free page-reading
  model (**Read pages (free)**) or by Gemini on request (free or paid key, your pick each time).
  A photo is read the same way, with a short description from a free vision model when it holds
  little text. An audio recording of up to 2 hours is transcribed in 3-minute pieces and gets a
  title and summary. You review the text and where each one will be saved before it is filed,
  and can keep saved documents for offline reading. On Android, sharing a link, photo or PDF to
  the installed app opens the inbox with it filled in, and in chat the assistant can save a link
  or passage with `capture_add`
- Tasks and approvals: `/tasks` lists scheduled tasks with their schedule, next run and run
  history. When an unattended task wants to change something (send or draft mail, edit the
  calendar, write to the vault, change to-dos or memories), the action waits for your
  approval; read-only tools run without it. Each one also arrives in Telegram with Approve and
  Reject buttons, and the message updates with the outcome once it is decided anywhere
- Ask before sending: in every live chat, sending an email or changing the calendar waits for
  you (listing and reading events do not). Web chat shows an Approve card under the reply;
  Telegram and Discord requests arrive as Telegram buttons and on `/tasks`. The request expires
  after an hour, and the outcome is saved into the conversation. Outside a chat, a send runs
  only with an approval
- Branches: start a branch from any saved message to try another prompt or model, and compare the
  branches at `/conversations/compare`
- Knowledge only and Free only: one switch answers only from saved knowledge, with sources;
  the other keeps interactive chat on free models (scheduled tasks still use paid ones). Voice
  works in Free only while the on-box transcriber is up, and replies are spoken with the free
  Gemini key. The dashboard shows each model's recent health
- Knowledge revisions: compare versions of a Library page and restore an earlier one as a new
  revision
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
  connections stay editable in place with every change landing as an atomic Git commit.
  Opening a page reveals textured section planets and moons with exact document navigation,
  a sticky reader outline, orbital clearance, and pause, zoom and fit controls
- Web search: Gemini grounds answers with real-time Google Search (inline citations + URL context); the other models get a `search_web` tool so they can pull live info too, automatically or on demand with `/search`
- Maps grounding: location questions get routed to Google Maps (places, directions, hours)
- Date awareness: the current date/time (in your timezone) is injected into the model's context on every request, so it doesn't guess the date when discussing plans or schedules
- Think mode: a deep-reasoning toggle (`/think`), tunable per model
- Hyperparameters: optional temperature / top-p / max-tokens controls in the header
- Atlas design: graphite neutrals, one red accent and Hanken Grotesk, in light and dark
  themes picked from the sidebar (or matching the system). [DESIGN.md](DESIGN.md) records the
  design system
- Assistant identity: one source SVG generates the navigation mark, theme-aware favicon,
  Apple and PWA icons, notification badge and desktop icon assets; see the
  [brand asset guide](scripts/ASSISTANT_BRAND.md) for regeneration and verification. In the
  app the mark moves: it blinks now and then, its lens follows the pointer on the welcome
  screen, and the newest reply's mark turns red and moves while Zuychin thinks, writes or speaks
- Multi-channel: web UI, Discord bot and Telegram bot all share the same RAG pipeline
- Channel conversations: each Telegram chat and Discord's `#ask-zuychin` keep a real
  conversation. `/new` starts a fresh one, and so do 6 hours without messages. Telegram task
  results and nudges are saved into it, so a reply to one has it in context. They show in the web sidebar
  with a Telegram or Discord icon and open read-only there
- Cron jobs: daily briefing (LLM-triaged inbox - only the emails that matter, icon-coded
  by urgency), event reminders + due-todo nagging, scheduled-task dispatch, email triggers,
  initiative decisions, the nightly run review, the daily model check and proactive check-ins
- Export: every long reply gets a collapsed **Generate ▾** menu for a DOCX / PDF / MD
  download; whole conversations export to PDF or DOCX (Markdown-aware)
- Knowledge model switch: **Switch knowledge to this** on `/admin#models` re-embeds the whole
  knowledge store in a server job that shows its progress, pauses on a daily quota and resumes
  later, then makes the new model active. No script run or redeploy is needed. An approved route
  that returns identical vectors (marked Same space) takes over by itself when the main one fails
- Admin dashboard: stats, model health, the model catalogue, a live personality/system-prompt
  editor, agent-run traces (status, duration, tokens, expandable step timeline), a fact-memory
  editor and a skills panel (approve/edit/delete agent-authored skill drafts) at `/admin`
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
| Chat models | Gemini 3.8 Flash / 3.5 Flash-Lite, DeepSeek V4.1 Flash / V4 Pro, OpenRouter (Nemotron, Laguna, Gemma 4), NVIDIA NIM (Nemotron, Gemma 4, GLM-5.3 Flash, Laguna XS) |
| Embeddings | Stable Gemini Embedding 2 (768d), NVIDIA NIM Nemotron 3.5 Embed 1B (2048d, default); others discovered on `/admin`, and an approved same-space route as the backup |
| Grounding | Google Search, Google Maps, URL context (Gemini path only) |
| Media models | NVIDIA NIM Nemotron 3.5 Rerank 8B and Nemotron 3.5 Parse, Gemini Decision 1 (both keys); others discovered on `/admin`. Scanned PDF pages are drawn in the browser with pdf.js |
| Voice replies | Gemini TTS (`gemini-3.8-flash-lite-tts`), streamed PCM → WAV / Web Audio; or tiny-voca through a local `tts-service` (Python, onnxruntime), same PCM stream; a backup voice from any approved Gemini, OpenRouter or Groq speech model |
| Voice input | Moonshine tiny (English) through `sherpa-onnx-node` in a local `stt-service`; the browser converts recordings to 16 kHz PCM with Web Audio; optional API transcription (Gemini, Groq Whisper, OpenRouter) |
| Push | web-push (VAPID) + service worker (PWA) |
| Database | Supabase (PostgreSQL + pgvector) |
| 3D graph | 3d-force-graph (three.js + d3-force-3d), three (sprite stars, planet bodies, bloom), HTML label overlay |
| Integrations | Google Calendar API, Gmail API |
| Messaging | Discord.js, Telegram Bot API |
| Councils | Server-run debate loop over the provider chat APIs, fenced by a database host lease |
| Export | docx, pdfkit |
| Hosting | Self-hosted standalone Next server (web/API) and always-on Node processes (Discord bot, optional speech-to-text service) |

## Prerequisites

The core app needs Node.js, Supabase, a Gemini key and a configured embedding provider.
Other integrations unlock their matching features.

| Requirement | For |
|-------------|-----|
| Node.js 20+ and npm | Required |
| Supabase project (URL + anon key) | Required, for chat history and RAG memory |
| Google AI Studio key ([aistudio.google.com](https://aistudio.google.com/apikey)) | Default chat provider; also supports Gemini Embedding 2 |
| NVIDIA NIM key | Default knowledge embeddings and optional chat models; use a registered Gemini embedding override if NIM is not configured |
| OpenRouter / DeepSeek keys | Optional extra chat models; metered models are excluded from the free worker pool |
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
| `GEMINI_API_KEY` | Google AI Studio API key (default chat provider and optional Gemini embeddings) |

Model-provider configuration (missing keys and explicitly unavailable providers are hidden in the UI). Every provider key can also be saved on `/admin` instead; a saved key wins over its env var (see [Provider keys](#provider-keys)):

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter key (Nemotron / Laguna / Gemma 4 chat) |
| `OPENROUTER_SITE_URL` | Optional `HTTP-Referer` for OpenRouter rankings |
| `OPENROUTER_APP_NAME` | Optional `X-Title` for OpenRouter rankings |
| `KILO_API_KEY` | Kilo gateway key for the qualified free-only catalogue: Nemotron Ultra/Lightning, Ling Flash VL, Step 3.7 Flash and Laguna S. See [setup and verification](scripts/KILO_SETUP.md) |
| `GEMINI_FREE_API_KEY` | Second Google AI Studio key on a free-tier project. Lists the same Gemini models a second time as "(free)", and calls made with them go to that key's quota rather than the paid project's |
| `DEEPSEEK_API_KEY` | DeepSeek key ([platform.deepseek.com](https://platform.deepseek.com)): canonical `deepseek-flash` and `deepseek-v4-pro`. Metered and excluded from the free worker pool |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM chat and the default `nvidia/nemotron-3.5-embed-1b` knowledge embeddings |
| `GROQ_API_KEY` | Groq free-tier key ([console.groq.com](https://console.groq.com)). Its free models are seeded unapproved: they join the picker once a test passes, and automatic routes wait for Approve. The free tier allows 8K tokens per minute |
| `AGNES_API_KEY` | Agnes AI key ([platform.agnes-ai.com](https://platform.agnes-ai.com)), or save it on `/admin`. Its models come from discovery: they join the picker once a test passes, and automatic routes wait for Approve. Free at an "experience price" that may end; no data-use policy is published |
| `CLOUDFLARE_AI_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI token (Account, Workers AI, Read and Edit) and the 32-character account id, or save both on `/admin`. The token cannot read its own account, so the id is needed too. Free plan: 10,000 neurons a day shared by every model, reset at 00:00 UTC. Models come from discovery and need a passing test, then Approve |
| `LLAMA_CLOUD_API_KEY` | LlamaParse key (page to Markdown, 10,000 free credits a month), or save it on `/admin`. Its one catalogue row is a seed from `v8-free-providers.sql`, retested weekly |
| `OPENCODE_API_KEY` | OpenCode Console key (paid credits). Replaces `OPENCODE_ZEN_API_KEY`. Metered; no built-in models. See [setup](scripts/OPENCODE_CONSOLE_SETUP.md) |
| `PROVIDER_KEYS_SECRET` | Dev only. 32 random bytes, base64 (`openssl rand -base64 32`), that encrypt provider keys saved on `/admin`. Production reads a systemd credential instead. Unset = saving keys is off and env keys work as before |
| `PROVIDER_KEYS_SECRET_PREVIOUS` | Dev only, during a master key change: the old value, so saved keys are re-encrypted on start |
| `TOKENROUTER_API_KEY` | Retained configuration; unavailable because the configured key had no usable free endpoint in the 23/09/2026 audit |
| `MODEL_DISCOVERY` | Optional. `off` makes the daily model check return 204 and do nothing; the app keeps using the stored catalogue and the models in code. Check now in `/admin` still works |
| `MODEL_DISCOVERY_MAX_PROBES` | Optional. Free models tested per provider in each check, a whole number from 0 to 50 (default 10) |
| `MODEL_LOOKUP` | Optional. `off` skips profile lookups and the weekly retirement lookup for models in use in the daily model check. The Look up button in `/admin` still works |
| `MODEL_LOOKUP_MAX_PER_RUN` | Optional. Profile lookups per daily check (default 4) |
| `MODEL_TYPES_DISCOVERY` | Optional. `off` keeps the daily model check to chat models; embedding, speech and transcription models already listed are still tested. Default on |
| `MEDIA_KINDS` | Optional. `off` keeps rerank, page reading, image, decision, live and translation models out of the daily check and out of every feature, which then uses its fallback. Default on |
| `KNOWLEDGE_EMBEDDING_MODEL` | Optional registered model ID. Existing vectors require a switch on `/admin#models` or the migration below; changing this value alone does not migrate them. A saved runtime override takes precedence |
| `TAVILY_API_KEY` / `TAVILY_API_KEY_DEEP` | Web search for the non-Gemini models ([tavily.com](https://tavily.com), free tier). The first serves quick lookups and the second thorough ones; each borrows the other's credits when its own run out, and Gemini grounding covers the rest. With neither set, every search goes to Gemini. Capture also uses them to read a page the server is blocked from or can't reach |
| `CAPTURE_FETCH` | Optional. `off` stops Capture fetching links on the server; Review then asks you to paste the passage instead |

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
| `DISCORD_ALLOWED_USER_IDS` | Bot only: comma-separated Discord user ids it answers; unset answers anyone who can post where it reads |
| `DISCORD_CH_BRIEFING` / `_REMINDERS` / `_TASKS` / `_CALENDAR` / `_BILLS` / `_COWORKING` / `_SYSTEM` | Per-purpose notification channels; each falls back to `DISCORD_CHANNEL_ID` (`_SYSTEM` stays silent unless set) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` | Telegram channel. The webhook answers only `TELEGRAM_CHAT_ID` and any chat in `TELEGRAM_ALLOWED_CHAT_IDS`; production ignores every update while neither is set |
| `TELEGRAM_OWNER_USER_IDS` | Comma-separated Telegram user ids allowed to act as the owner. A private chat's id already names its owner, so this is needed only for a group chat |
| `CHANNEL_QUIET_GAP_MINUTES` | For live testing only: minutes without messages before a Telegram or Discord chat starts a new conversation (default 6 hours) |
| `CRON_SECRET` | Bearer token required by the cron endpoints |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web-push key pair (`npx web-push generate-vapid-keys`); either unset = push disabled |
| `VAPID_SUBJECT` | Your `mailto:` contact for the push service, e.g. `mailto:you@example.com`. Required: push stays disabled without it |
| `GEMINI_TTS_MODEL` | Optional override of the voice-reply TTS model (default `gemini-3.8-flash-lite-tts`) |
| `STT_SERVICE_URL` / `STT_SERVICE_TOKEN` | On-box speech-to-text service, for example `http://127.0.0.1:3010`, and its bearer token (the service's `STT_TOKEN`). Either unset = voice turns send the audio to Gemini, and voice stays off in Free only. See [Speech-to-text service](#speech-to-text-service-optional) |
| `TTS_SERVICE_URL` / `TTS_SERVICE_TOKEN` | On-box text-to-speech service, for example `http://127.0.0.1:3011`, and its bearer token (the service's `TTS_TOKEN`). Either unset = replies are spoken by Gemini. See [Text-to-speech service](#text-to-speech-service-optional) |
| `NEXT_PUBLIC_BASE_URL` | Address other machines reach this install on. Agent claims use it instead of the page they were minted from, so one copied on localhost still points somewhere a remote agent can reach. Falls back to `VERCEL_URL`, then the current origin |
| `COUNCIL_ONLINE_RESUME` | `on` or `off`. Whether this process picks up councils whose runner stopped, such as after a restart. Unset means on in production and off in development, so a dev server sharing the database never takes a council from the box |
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
row-level security, the search functions (`match_embeddings`,
`match_vault_pages`, `match_memories` plus the hybrid keyword+vector
`hybrid_match_knowledge` and `hybrid_match_vault_pages`) and a default profile. The script
is safe to run more than once - re-run it after upgrading to pick up new tables and columns.
Earlier versions added another default profile on every run; if yours did, run
[`scripts/migrations/owner-profile-consolidation.sql`](scripts/migrations/owner-profile-consolidation.sql)
once to merge them. It previews its changes until you set `apply_changes` to true.

Every table is server-only: the app uses the service role, which bypasses row-level security,
and the anon key reaches nothing. Earlier versions gave the anon key full access to the core
tables through "Allow all access" policies, and left Supabase's default anon grants on the other
tables, where row-level security alone hid the rows. On an existing project, run
[`scripts/migrations/server-only-tables.sql`](scripts/migrations/server-only-tables.sql) to
remove both; its final query lists anything in the public schema still open and should return
no rows.

The same script creates the unified knowledge domain (`knowledge_documents`,
`knowledge_chunks`, `knowledge_links`, `knowledge_assertions`,
`knowledge_events`, `knowledge_sync_state` and `knowledge_suggestions`) plus atomic
replacement RPCs and chunk-level hybrid recall. Knowledge tables are server-only under
RLS, so production requires `SUPABASE_SERVICE_ROLE_KEY`.

The `-- ===== Knowledge graph wave =====` block at the bottom adds `vault_graph_snapshot` and
`vault_page_links`, which back the cached `/graph` payload and the derived vault adjacency.
Both are rebuildable from the repo, so they can be dropped and regenerated at any time; the
graph still works without them, it just rebuilds from GitHub on every load.

The `-- ===== V7 model catalogue =====` block adds `model_catalogue` (every known chat model with
its test results, missing count and approval) and `model_discovery_runs` (one row per check; a
unique index on running rows is the lock), seeds them with the models in code, and allows the
`probe` purpose in model health. On an existing project, run
[`scripts/migrations/v7-model-catalogue.sql`](scripts/migrations/v7-model-catalogue.sql); it is
safe to run again. Without these tables the app serves the models in code and `/admin` says
which file to apply.

The `-- ===== V7 model awareness =====` block adds `model_profiles` (purpose tags, the drafted
and approved profile, its vault state and whether you removed it, per model route, seeded for
the models in code), `model_feedback` (worker ratings), the `assistant_model_speed` and
`assistant_model_feedback` functions, the `model_profile_approve` function behind one-click
Approve, the `lookup` and `consult` purposes in model health, and the delete grant on
`model_catalogue` that Delete needs. On an existing project, run
[`scripts/migrations/v7-model-awareness.sql`](scripts/migrations/v7-model-awareness.sql); it is
safe to run again. Without it, tags come from the models in code, speed from the latest test,
ratings are not stored, Remove and Delete are unavailable, and `/admin` says which file to apply.
If you applied an earlier copy, run it again to add the removal column and the grant.

The `-- ===== V7 provider keys =====` block adds `provider_keys` (provider API keys saved on
`/admin`, encrypted, server-only), seeds Groq's three free models unapproved with their purpose
tags, and deletes the four retired OpenCode free-model rows. On an existing project, dump
`model_catalogue` and `model_profiles` first, then run
[`scripts/migrations/v7-provider-keys.sql`](scripts/migrations/v7-provider-keys.sql); it is safe
to run again. Without it, env keys work as before and `/admin` says which file to apply.

Councils record their model calls in model health under a `council` purpose. The
model awareness file and `supabase-setup.sql` already list it; if you applied model awareness
before it was added, run
[`scripts/migrations/v7-online-council.sql`](scripts/migrations/v7-online-council.sql), which
only widens that purpose check and is safe to run again. Without it councils still run,
and their calls are just not stored in model health.

The `-- ===== V7 channel threads =====` block adds `assistant_channel_updates` (Telegram update
ids, so a retried update runs once), `assistant_channel_threads` (each chat's current
conversation, behind the `assistant_channel_thread` function), a `channel` column on
`conversations`, and `assistant_approval_notices` (the Telegram message each approval was sent
as). It also lets an approval come from a chat turn as well as a scheduled task, with the
`assistant_propose_chat_action` function, and replaces `assistant_decide_action` and the
approval immutability trigger to match. On an existing project, run
[`scripts/migrations/v7-channel-threads.sql`](scripts/migrations/v7-channel-threads.sql); it is
safe to run again, and it must run again after any re-run of `v6-scheduled-actions.sql`. Without
it, Telegram keeps one shared history, approvals send no buttons, and email and calendar
changes asked for in a Telegram chat are refused.

The `-- ===== Council owner notes =====` block creates `council_owner_notes`, left from the retired
coding-agent campaigns. The `-- ===== V7 local Council cleanup =====` block at the end drops it again,
with the other local-only council tables (see the council section).

The `-- ===== V7 model types =====` block adds a `kind` (chat, embedding, speech or
transcription) and typed columns to `model_catalogue`: dimension, retirement date and its source,
the route it shares vectors with (`space_of`) and `traits` (voices, formats, batch size and
similar). It seeds the two built-in embedding models and the default Gemini speech model on both
Gemini keys, and adds the `transcription` purpose to model health. On an existing project, dump
`model_catalogue` and `cron_state` first, then run
[`scripts/migrations/v7-model-types.sql`](scripts/migrations/v7-model-types.sql); it is safe to
run again. Without it, embeddings and speech run on the models in code, the daily check stays on
chat models, and `/admin` says which file to apply.

The `-- ===== V8 media =====` block widens the catalogue kinds to rerank, parse, image, decision,
live and translate, and the model health purposes to match. It seeds seven rows: NIM's rerank,
parse and image models (NIM never lists them, so they are never marked Missing), Gemini Decision 1
on both keys and Gemini 3.8 Live on the free key, all approved, plus Riva Translate unapproved. It
also adds `modality` and `asset_path` to `knowledge_chunks` for photo rows, and
`replace_knowledge_chunks` now writes them. On an existing project, apply
[`scripts/migrations/v7-model-types.sql`](scripts/migrations/v7-model-types.sql) first, then
[`scripts/migrations/v8-media.sql`](scripts/migrations/v8-media.sql); it is safe to run again.
Without it, the new kinds are skipped and each feature uses its fallback.

The `-- ===== V8 free providers =====` block seeds LlamaParse's one row (`cost_effective`, kind
`parse`, unapproved and untested). Cloudflare Workers AI needs no seed: its rows come from its model
search. On an existing project, apply
[`scripts/migrations/v8-media.sql`](scripts/migrations/v8-media.sql) first, then
[`scripts/migrations/v8-free-providers.sql`](scripts/migrations/v8-free-providers.sql); it stops
with a message if the media kinds are missing, and is safe to run again.

The `-- ===== Skipped tasks =====` block lets a to-do be `skipped` as well as `done`, so a task
you dropped is not read as finished. On an existing project, apply
[`scripts/migrations/todo-skipped.sql`](scripts/migrations/todo-skipped.sql); it only widens the
`todos` status check, is safe to run again and works when a tool runs it one statement at a time.
Until it is applied, Skip in the Today panel says the task could not be skipped.

### Web authentication

For a private production deployment, set `ACCESS_PASSWORD`, `AUTH_SESSION_SECRET`,
`AUTH_RP_ID` and `AUTH_ORIGIN` before deploying. Generate `AUTH_SESSION_SECRET` once and
keep it stable:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

A signed-out visit to a page goes to sign-in and comes back to the same page afterwards.

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

**Sign out everywhere.** The same screen has a **Signed-in browsers** box. With your current
password it signs out every other browser and device within about 30 seconds; the browser you
press it in gets a fresh session and stays signed in. It needs
[`scripts/migrations/v7-security-hardening.sql`](scripts/migrations/v7-security-hardening.sql)
(one `auth_session_epoch` row); until then the button explains it is off and sign-in works as
before. It does not touch agent keys (revoke those under **Agents**), `CHAT_API_KEY`,
`CRON_SECRET` or the webhook secrets, which have their own rotation. Do not rotate
`AUTH_SESSION_SECRET` to sign people out: the authenticator-app secret is encrypted with a key
derived from it, so recovery would stop working until you set the authenticator up again.

### 4. Google OAuth (optional, Calendar + Gmail)

Create an OAuth client in the Google Cloud Console with the redirect URI
`http://localhost:3000/api/auth/google/callback`, then visit that URL while signed in
to finish the flow and copy the refresh token into `GOOGLE_REFRESH_TOKEN`. You can run
`node test-google-auth.js` afterwards to check the credentials in `.env.local`.

### 5. Run

```bash
npm run dev
```

- Web UI: [http://localhost:3000](http://localhost:3000)
- Admin: [http://localhost:3000/admin](http://localhost:3000/admin)

## Using the app

- Pick the chat model from the dropdown in the chat's top bar. The sidebar opens each
  workspace: **Library** (its Cosmos link opens the 3D vault view), Research, Study, Capture,
  Tasks and Dashboard.
- **Generation settings**, beside the model picker, holds the Agent mode, Free only and
  Knowledge only switches and temperature / top-p / max-tokens. It also names the knowledge
  (embedding) model, with a link to change it on the dashboard.
  Agent mode forces the multi-step agent loop for every message (off = auto-detect); on
  wide screens the top bar has the same switch.
- Type `/` in the message bar to open the slash-command drop-up (arrow keys / Tab / Enter
  to pick). Commands expand into full prompts server-side; the raw command stays in history.
- Tap the mic for a hands-free voice chat: it auto-sends when you pause, speaks the reply,
  and listens again. Say "That's enough, thank you" or tap **End** to end the loop.
  **Send now** sends what it has heard without waiting for a pause, and **Skip** stops the
  reply being spoken and listens again. When the reply needs tools or agents, it says a
  short phrase such as "Just a minute" (picked from a small pool) while it works.
  With the speech-to-text service set up, the voice stage shows Transcribing while your
  words are read, and your message appears as text marked "Spoken".
- The **Today** button in the top bar opens the Today panel. Ticking a to-do there completes it for good; the ↷ button beside the tick skips it instead.
- Start a new chat and pick the theme from the sidebar. **History** folds the workspace links
  away so chat history fills the sidebar, and the choice is remembered.
- In the history sidebar, **New project** creates a collapsible group: use the folder icon
  on a chat row to move it into a project, and the project's ⋯ menu to rename it, edit the
  instructions injected into its chats, or delete it (chats fall back to Ungrouped).
- Prefix a message with `/think` for deeper reasoning or `/search` to force a web-grounded
  answer. These only apply to models that support them, and the UI hides toggles a model
  can't use.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | RAG chat with file, thinking, search and hyperparameters; a Discord turn with no conversation id joins its chat's conversation (optional `chatKey`) |
| POST | `/api/chat/stream` | Same as `/api/chat` but streams agent steps + tokens over SSE (web UI); 409 for a Telegram or Discord conversation |
| GET/PATCH | `/api/chat/preferences` | Read / set the Free only preference |
| GET | `/api/providers` | Available providers/models (filtered by configured keys) |
| GET/POST/PUT/DELETE | `/api/conversations` | Conversation list / create (optionally in a project) / move between projects / delete |
| GET/POST | `/api/conversations/branches` | List a conversation's related branches (`?conversationId=`) / branch from a saved message |
| GET | `/api/conversations/compare` | Two branches side by side (`?left=&right=`) |
| GET/POST/PUT/DELETE | `/api/projects` | Project list / create / rename + edit instructions / delete (chats drop to Ungrouped) |
| GET/PATCH/DELETE | `/api/todos` | Notes checklist: list / set status / delete |
| GET | `/api/today` | Today panel and chat starters: next-48 h events, due and pending todos |
| GET/POST | `/api/tts` | Voice-reply prefs / synthesize speech (`stream: true` streams raw PCM, `X-Sample-Rate` gives its rate). Speaks with the on-box voice when set up, else the backup voice chosen on `/admin` (Gemini by default); `X-Model-Provider` says which. Free only uses the on-box voice, a free backup voice or the free Gemini key, 409 without any |
| POST | `/api/voice/transcribe` | 16 kHz 16-bit PCM (60 s or less) to text through the speech-to-text service and, in the transcription order chosen on `/admin`, an API model; 503 `{ fallback: true }` tells the client to send the audio instead |
| GET | `/api/voice/status` | Whether the speech-to-text service is set up (config only, so a page load never starts it) |
| POST | `/api/voice/warm` | Start the speech-to-text and text-to-speech services and their models as a voice chat begins; returns `{ available, loaded }` for speech-to-text. The voice is started only once speech-to-text is no longer loading. The page polls it and opens the mic once speech-to-text has loaded |
| POST/DELETE | `/api/push/subscribe` | Register / remove a web-push subscription |
| GET | `/api/artifacts/[id]` | Download a generated file (report, code, zip) |
| POST | `/api/export` | Export a conversation to PDF or DOCX |
| GET/POST | `/api/research` | Research questions (`?questionId=` for one workspace) / save a question |
| GET/POST/PATCH | `/api/research/sources` | Read a source's saved text / add / edit a question's sources |
| POST/DELETE | `/api/research/entries` | Save / delete a research note |
| GET/POST | `/api/study` | Study report (`?view=due` returns only the reviewable count) / create, draft, edit, review, feedback and settings actions |
| GET/POST | `/api/capture` | Capture inbox and saved documents / capture, read the source text (`extract`, with `ocr` for Gemini), store scanned pages read one by one (`pages`), preview a destination, ingest |
| GET | `/api/capture/download` | A saved document's content for offline reading (`?documentId=`) |
| GET | `/api/capture/original` | The original PDF (download) or photo (opens in place) of a capture (`?id=`) |
| GET | `/api/capture/session` | Current profile ID, which ties offline copies to the signed-in profile; they are cleared after sign-out |
| POST | `/api/capture/parse-page` | One page or photo (PNG or JPEG, up to 2 MB, as the raw body) to Markdown through the page-reading model |
| POST | `/api/capture/transcribe-piece` | One piece of a recording (up to 3 minutes of 16 kHz 16-bit mono PCM, as the raw body) to text |
| POST | `/api/capture/recording` | A title and summary for a transcribed recording; nothing is stored |
| GET | `/api/capture/staged` | What the Android share target staged: the fields, or with `file=1` the shared file |
| POST | `/capture/share` | Android share target (link, text, photo or PDF): stages it and opens Capture with a 303. Nothing is saved until you save it |
| GET/POST/PATCH/DELETE | `/api/tasks` | Scheduled tasks with runs and approvals / create / edit, pause or resume / delete |
| POST | `/api/tasks/run` | Run a task now (202 when accepted, 409 while it is already running) |
| GET / POST | `/api/tasks/approvals` | Read one approval (`?id=`) / approve or reject an action a scheduled task or a chat proposed. Session only |
| POST / DELETE | `/api/auth` | Login / logout |
| GET / POST | `/api/auth/sessions` | Sign-out time and whether it is set up / sign out every other browser (needs the access password) |
| GET / POST | `/api/auth/passkey` | List passkeys or run WebAuthn sign-in, enrolment and removal actions |
| GET / POST | `/api/auth/totp` | Read TOTP status, set up an authenticator app, verify recovery codes |
| GET | `/api/council` | Open councils, those waiting on you, and recent closed ones for the council dashboard |
| GET | `/api/council/[code]` | One council's status and transcript for the council dashboard; `online` names each seat's model and the runner state |
| POST | `/api/council/online` | Start a council: `{ topic, brief, seats: [{ modelKey, name?, expertise? }], closerName? or closerIndex?, maxRounds?, allowPaid?, research?: { web?, notes?, query? } }`. Returns once the seats are recorded, with `research: { web, notes, vault, problems }` when research ran; the debate runs in the server process |
| GET | `/api/council/online/options` | Chat models a seat may use, Free only, round limits and an auto-fill suggestion (`?purpose=`) |
| GET/POST | `/api/council/[code]/owner` | The owner's private thread into a running council / send a turn (never exposed over MCP) |
| POST | `/api/council/[code]/decide` | Accept the result or send the council back to work while it awaits the owner |
| POST | `/api/council/[code]/pause` | Pause or resume a council (`{ resume: true }`) |
| GET | `/api/council/[code]/executions` | Paged execution history (`?cursor=`) |
| GET | `/api/auth/google/callback` | Google OAuth setup / token exchange (signed in only) |
| POST | `/api/telegram/webhook` | Telegram bot webhook (secret header, chat allowlist, owner sender), messages and approval taps |
| GET/POST/DELETE | `/api/mcp/[transport]` | Shared MCP server, Streamable HTTP at `/api/mcp/mcp` (named client key) |
| POST | `/api/agent/claim` | Exchange a setup claim for a per-agent key (unauthenticated, rate limited) |
| GET/POST/DELETE | `/api/agents` | Owner-only: list / add / remove agent clients |
| POST | `/api/agents/claim` | Owner-only: mint a setup claim and brief at a chosen access level |
| DELETE | `/api/agents/keys` | Owner-only: revoke one agent key (`?keyId=`) |
| GET | `/api/telegram/test` | Telegram connectivity / config check (signed in only) |
| POST | `/api/cron/daily-briefing` | Morning briefing (emails + calendar) |
| POST | `/api/cron/reminders` | Imminent event reminders + due-todo nagging |
| POST | `/api/cron/scheduled-tasks` | Run due user-scheduled tasks (claims up to 3 per invocation) |
| POST | `/api/cron/email-triggers` | Scan inbox for bills/deadlines → todos + calendar events |
| POST | `/api/cron/initiative` | Agent-initiated outreach: gated decide-then-maybe-message pass |
| POST | `/api/cron/run-review` | Nightly review of failed/expensive agent runs → draft skills |
| POST | `/api/cron/proactive` | Proactive check-ins |
| POST | `/api/cron/vault-lint` | Second-brain vault lint (`?mode=suggest` to report only) |
| POST | `/api/cron/conversation-cleanup` | Review conversations and record cleanup recommendations |
| POST | `/api/cron/council-sweep` | Expire overdue councils, write the verdict for ended ones nobody concluded, retry failed filing |
| POST | `/api/cron/model-discovery` | Daily model check: list providers' models, test new free ones, count missing ones (202, runs in the background; 409 while a check runs; 204 with `MODEL_DISCOVERY=off`) |
| GET | `/api/vault/health` | Vault repo connectivity / permissions check |
| GET | `/api/vault/graph` | Vault as graph data: nodes with lifecycle/cluster/centrality/health, edges, link suggestions. Served from a cached snapshot, revalidated in the background; `?refresh=1` forces a rebuild |
| GET | `/api/vault/search` | Semantic (hybrid keyword + vector) page search for the graph's search box |
| GET | `/api/vault/suggestions` | Link candidates for one page (`?path=`), ranked by cosine against stored vectors |
| GET/PUT/DELETE | `/api/vault/page` | Read / edit / cascade-delete a wiki page |
| POST/DELETE | `/api/vault/link` | Create / remove a bidirectional wikilink between two pages |
| GET/POST | `/api/knowledge/documents` | Library documents (filter by `kind`, `scope`, `status`, or one by `id`) / lifecycle actions: correct, archive, restore, forget, promote, merge |
| POST | `/api/knowledge/recall` | Explainable hybrid recall with a grounded, abstaining answer |
| GET | `/api/knowledge/events` | Lifecycle timeline (`?documentId=` for one document) |
| GET/POST | `/api/knowledge/suggestions` | Maintenance findings (`?status=`) / scan, dismiss, merge |
| GET/POST | `/api/knowledge/revisions` | A document's revision history and diffs / restore an earlier revision after previewing it |
| GET/POST | `/api/knowledge/photos` | Vault photo index: indexed, waiting and too large / index up to 20 more after the reply (409 while a run is going) |
| GET | `/api/knowledge/asset` | A saved photo for reply thumbnails (`?path=`, PNG or JPEG under `attachments/` only, checked by its bytes) |
| GET/POST | `/api/knowledge/evidence` | A document at an exact commit / anchor a quoted passage in it |
| POST | `/api/knowledge/sync` | Reconcile derived knowledge state with the vault repository |
| POST | `/api/knowledge/import` | Obsidian ZIP import: a dry-run plan unless `dryRun=false` |
| GET | `/api/knowledge/export` | Obsidian ZIP export with checksums |
| POST | `/api/knowledge/webhook` | Signed GitHub push webhook for incremental sync |
| GET | `/api/admin/status` | Bot stats |
| PUT | `/api/admin/personality` | Update system prompt |
| GET | `/api/admin/runs` | Agent-run traces (list, or `?id=` for the full event timeline) |
| GET/POST/PUT/DELETE | `/api/admin/memories` | List / add / edit / delete extracted memory facts |
| GET/PUT/DELETE | `/api/admin/skills` | List custom + built-in skills, approve/edit drafts, delete |
| GET/POST | `/api/admin/reembed` | Active knowledge model and rows not yet on it / POST answers 410: switching moved to `/api/admin/embedding/switch` |
| GET/POST | `/api/admin/embedding/switch` | Knowledge model, switch job progress and, with `providerId` and `modelId`, a preview with an estimate / start a switch (202; the job runs on the server) |
| GET/PUT | `/api/admin/speech` | Backup voice and transcription order / save either (only approved models whose last test passed) |
| GET/PUT | `/api/admin/media` | The chosen and automatic model for each V8 kind (rerank, parse, image, decision, live, translate) / choose one, or `providerId: null` for the automatic pick |
| GET | `/api/admin/model-health` | Each model's recent results, latency and failure kinds |
| GET/PATCH/DELETE | `/api/admin/models` | Model catalogue rows of every kind (`?kind=` narrows), the knowledge model, the voice choices, the last 10 checks and each provider's rest end (`restingUntil`) / approve or unapprove a model, or remove or restore it (`removed`) / delete a discovered model its provider no longer lists |
| POST | `/api/admin/models/refresh` | Start a model check now (202; 409 while one runs) |
| POST | `/api/admin/models/test` | Test one catalogue model, paid ones included (202; 409 while a check runs) |
| POST | `/api/admin/models/lookup` | Draft one model's profile from free sources (202; 409 while a check runs) |
| POST | `/api/admin/models/profile` | Approve a model with its profile and tags in one step, approve a built-in model's profile, or save tags |
| GET/PUT/DELETE | `/api/admin/provider-keys` | Key status per provider (never the key) / save or replace a key (Cloudflare also takes `accountId`) / clear it. Session only; changes need the access password |
| POST | `/api/admin/provider-keys/test` | Check the active key for one provider |
| GET/POST | `/api/admin/conversation-cleanup` | Cleanup recommendations / dismiss or review them |

Browser routes require the signed `zuychin-auth` session when authentication is enabled. The
public webhook, cron and headless-chat routes protect themselves with bearer credentials:
`CRON_SECRET` for cron endpoints and `CHAT_API_KEY` for `/api/chat`. See `src/proxy.ts` and
`src/lib/auth/guard.ts` for the enforcement boundary.

Every API route has a request size limit (`src/lib/http/limits.ts`): 64 KB for sign-in and
other small routes, 1 MB by default, 2 MB for the Telegram and GitHub webhooks and a Capture
page image, 4 MB for MCP, vault pages, documents and export, 5,760,000 bytes for a recording
piece, 9,500,000 for an Android share, and 10,000,000 bytes for chat and vault import. The proxy
refuses a declared size over the limit with a 413 before any sign-in check, and each route reads
through `src/lib/http/body.ts`, which counts bytes and stops at the limit. Every limit sits under
Next's 10 MB `proxyClientMaxBodySize`, because over that Next silently passes on only the first
10 MB.

## Providers & Models

The chat model is chosen per message from the header dropdown (saved in `localStorage`).
Generation settings hold the hyperparameters and name the knowledge model. Providers
need a configured key and must not carry an unavailable reason. The default web chat model
is Gemini 3.5 Flash-Lite; messaging uses the separate chain below. Provider settings, the pinned
models and audited quirks live in [`src/lib/ai/providers.ts`](src/lib/ai/providers.ts); every other
chat model comes from the model catalogue below.

A catalogue entry is not proof of a successful chat or tool call, and a timeout or rate limit
is not evidence that a model has retired.

| Provider | Kind | Example models | Notes |
|----------|------|----------------|-------|
| Google Gemini | native | `gemini-3.8-flash`, `gemini-3.5-flash-lite` | Grounding, thinking, vision and function calling; stable `gemini-embedding-2` at 768 dimensions |
| Google Gemini (free) | native | the same two ids | Same models on a free-tier project's key. Picking one routes the call through that key's own client, so it draws on the free quota instead of the paid project |
| DeepSeek | OpenAI-compatible | `deepseek-flash`, `deepseek-v4-pro` | Metered; excluded from the free worker pool. Flash is labelled V4.1 Flash. `json_object` only, no `json_schema` |
| OpenRouter | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-s-2.1:free`, `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it`, `nvidia/nemotron-3.5-lightning:free` | Gemma 4 26B is metered and excluded from free workers |
| NVIDIA NIM | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b`, `google/gemma-4-31b-it`, `z-ai/glm-5.3-flash`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `poolside/laguna-xs-2.1` | Also `nvidia/nemotron-3.5-embed-1b` at 2048 dimensions; its predecessor `nvidia/nemotron-3-embed-1b` reached end of life on 23/11/2026 and stays registered only so a store still on it resolves until the re-embed. Kimi K3, GLM-5.3, DeepSeek V4.1 Flash and DiffusionGemma reached end of life on NIM (HTTP 410 on 18/11/2026); saved choices resolve to replacements |
| Kilo | OpenAI-compatible | `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-lightning:free`, `inclusionai/ling-3.0-flash-vl:free`, `stepfun/step-3.7-flash:free`, `poolside/laguna-s-2.1:free` | Five usable free models; endpoints returning HTTP 404 are excluded. [Setup and live verification](scripts/KILO_SETUP.md) |
| Groq | OpenAI-compatible | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | Free tier (8K tokens per minute). Seeded as catalogue rows, not code models, so automatic routes wait for Approve. Requests drop `messages[].name` and send `max_completion_tokens` |
| Agnes AI | OpenAI-compatible | From discovery (`agnes-3.0-flash` expected) | $0 at an early-user "experience price" with no end date, about 20 requests per minute; no published data-use policy. No built-in models: discovery adds them once a key is saved, and automatic routes wait for Approve. `agnes-2.0-flash` and `agnes-2.5-flash` (offline 30/11/2026) are retired |
| Cloudflare Workers AI | OpenAI-compatible | From discovery (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` and similar) | Free plan: 10,000 neurons a day shared by every model, reset at 00:00 UTC; Cloudflare does not train on inputs. The base URL holds the account id. Workers Paid models are skipped. Embedding, speech, transcription, rerank, decision, image and translation models are listed but not tested yet |
| LlamaParse | REST (upload and poll) | `cost_effective` (seed row, kind `parse`) | 10,000 free credits a month, 3 a page. No model list: the tier is the model |
| OpenCode Console | OpenAI-compatible | none until a key is set | Paid only (credits); metered. Discovery tracks paid Chat Completions models; each needs Test and Approve. Free models answer 403 outside OpenCode, so the old free ids are retired and saved choices of them fall back to the default. [Setup](scripts/OPENCODE_CONSOLE_SETUP.md) |
| TokenRouter | OpenAI-compatible | `moonshotai/kimi-k3-free` | Retained but unavailable for the audited key; hidden and skipped by workers |

How it works:

- One OpenAI-compatible client ([`openai-compat.ts`](src/lib/ai/openai-compat.ts)) serves
  OpenRouter, Kilo, NVIDIA NIM, Groq, Agnes AI, Cloudflare Workers AI, DeepSeek and OpenCode Console chat-completion models with
  streamed responses. Gemini keeps its own native path.
- Tool dispatch follows each model's declared capability. Some endpoints remain unverified
  under load; successful HTTP responses alone do not prove a tool was executed. If a model
  rejects tools, the client can retry without them.
- Each model declares `supportsThinking` and `supportsSearch`. `/think` and `/search` are
  enforced on the server (so they hold on every channel) and the UI hides toggles a model
  can't use. Reasoning (`/think`) maps to Gemini `thinkingConfig`, OpenRouter `reasoning`,
  NIM and Agnes AI `chat_template_kwargs.enable_thinking`, DeepSeek `thinking` + `reasoning_effort`, and Groq
  `reasoning_effort` (GPT-OSS always reasons, so off means low effort with the reasoning hidden).
  DeepSeek is the one provider that reasons unless told not to, so its branch runs on every
  request rather than only when `/think` is on.
- Web search works two ways depending on the model. Gemini uses native Google Search/Maps
  grounding. The OpenAI-compatible models can't reach the internet, so they get a `search_web`
  tool (backed by Tavily, see `TAVILY_API_KEY`): they call it on their own when an answer needs
  current info, and `/search` forces it. The `search_web` tool is intentionally not given to
  Gemini.
- Hyperparameters (temperature, top_p, max tokens) are optional, sanitized on the server and
  mapped per provider. NIM requests receive model-specific defaults and a bounded token budget.
- Max tokens is bounded **per model** by that model's output ceiling rather than one
  global cap: 393,216 for direct DeepSeek, 65,536 for Gemini and 16,384 for OpenRouter
  Gemma 4 26B. Newly added endpoints without a verified ceiling use a conservative 8,192
  fallback; a copied limit from a retired endpoint is not treated as evidence.
  Requests are clamped to the resolved model's ceiling server-side, because exceeding it makes
  the provider reject the whole call instead of quietly truncating.
- Embeddings are model-aware: each embedding model writes and reads its own partition of the
  vector store, because vectors from different models (and dimensions) aren't comparable.
  A model used at a reduced size gets its own partition, `<model>@<dimension>`.
  The CLI and the switch job on `/admin#models` share migration logic covering all five
  vector-bearing tables and activate the target only after a fresh verification pass. The job
  sends up to 32 texts per call, two calls at a time, backs off on a 429 and pauses on a daily
  quota or 5 failed batches in a row; the daily model check or the next `/admin` visit resumes
  it. Removed embedding IDs fail explicitly instead of silently interpreting old vectors as a
  new model's partition.
- Backups: on a 410, 404, server error or timeout, the knowledge model falls back to an
  approved route that returns identical vectors (Same space, proven by a test), with one
  Discord notice a day at most. A 429 or NVIDIA's 422 content screen never falls back; a
  screened batch is retried text by text.
- Similarity cut-offs live per embedding model in
  [`src/lib/ai/embedding-cutoffs.ts`](src/lib/ai/embedding-cutoffs.ts), because each model
  spreads its scores differently. After a switch, measure the new model on the live store
  (read only) and add its values:
  `npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/measure-embedding-cutoffs.ts`.
  An unmeasured model uses Nemotron 3.5 Embed 1B's values.

### Model catalogue

`providers.ts` keeps provider settings, the pinned models (the default and paid chat models, the
messaging and worker chains, both embedding models, the free-key Gemini and DeepSeek models) and
audited quirks. Every other chat model comes from the stored catalogue
([`src/lib/ai/catalogue/`](src/lib/ai/catalogue)), including the models that used to be written in
code, which are approved seed rows. Code wins field by field; the catalogue adds the other models
and a status. If the catalogue cannot be read at start-up, the picker shows the pinned models only. The server loads the catalogue at start-up and reloads it in the
background once it is more than 5 minutes old, so model lookups stay synchronous.

- Listing: the daily check lists Gemini (both keys), OpenRouter and Kilo (free models only),
  NVIDIA NIM, DeepSeek, Groq, Agnes AI (no image or video models), Cloudflare Workers AI (its
  model search under the account; Workers Paid, guard and LoRA models skipped; at most 3 tests a
  check) and OpenCode Console (paid
  Chat Completions models only, tested only when you press Test). TokenRouter is not listed.
  LlamaParse has no list: its seed row is never marked Missing and is retested every 7 days.
  Saving a provider key on `/admin` starts a check straight away.
- V8 kinds: rerank, parse (page reading), image, decision, live and translate models each have
  a small test (rank 4 passages, read a test page, make an image, answer 3 questions, open a
  live session, translate a sentence) and a model choice on their tab (`/api/admin/media`,
  `cron_state.media_models`). Rerank, page reading and decisions are used now; image, live and
  translation models are only listed and tested, for features still to come. NIM's rerank, parse
  and image models are seeds, because NIM does not list them. `MEDIA_KINDS=off` turns all six off.
- Rest: when Cloudflare answers that the free daily allowance is used up (HTTP 429, code 3036),
  the provider rests until 00:00 UTC; LlamaParse out of credits (HTTP 402) rests until the 1st of
  next month (UTC, not yet seen live). One Discord notice in the system channel per rest names
  what falls back. During a rest the list is still read, tests wait without changing any row, and
  Test on `/admin` answers with the time the rest ends ([`src/lib/ai/provider-rest.ts`](src/lib/ai/provider-rest.ts)).
- `/admin#models`: each tab folds into Needs attention and In use and approved (open), then
  Other free models, Paid models and Removed (folded, with counts). A row is one line that opens
  into the full card, and rows that need attention get a quick Approve or Test. A search or a
  provider filter opens every section with a match. A model counts as New for 14 days after it is
  first listed. Otherwise only approved, built-in or in-use models that fail or go missing need
  attention, plus in-use models with a retirement date. Provider
  problems (list check failed, resting, not available) show in the Last check box. Model health
  folds the same way: Latest request failed, Used, and No requests recorded.
- Testing: each check tests up to `MODEL_DISCOVERY_MAX_PROBES` free models per provider: new
  ones first, then retries of unclear results, then picker models last tested over 7 days ago.
  A test sends short streamed requests: a chat reply, an automatic tool call, a forced tool call
  (the Search toggle relies on it) and, when the list shows image input or says nothing about
  inputs, a vision question. Three unclear results in a row (timeouts, 429) count as a failure;
  HTTP 410 marks the model failed and Missing at once. Test requests appear in model health with
  the `probe` purpose.
- Picker: a discovered model joins the picker once it passes (marked New) or once you approve
  it. A model missing from its provider's list in two checks running is marked Missing but stays
  selectable, so saved choices keep working.
- Removal: Remove on a row takes the model out of the picker, `/model`, worker picks, fallbacks
  and the agent's model tools, and the daily check stops testing and announcing it. It still
  counts the model as Missing when its provider drops it. Saved choices fall back to the default
  model. Restore brings it back. The default chat model cannot be removed. Once a discovered
  model is Missing, Delete removes its row and profile for good; built-in models are deleted in
  `providers.ts`.
- Automatic routes: worker recruitment, the Free only fallback and the messaging fallback use
  models in code and approved catalogue models only.
- Messages: at most one Discord message per check, in the `DISCORD_CH_SYSTEM` channel, and only
  when something changed: new models that passed, models newly Missing, approved models that
  failed a re-test, and a provider whose list failed twice in a row.
- A check stops starting tests after 20 minutes, inside the 30-minute window after which a
  stuck check's lock is cleared.
- `npx tsx scripts/model-discovery-dry-run.mts` prints what a check would add, mark missing and
  test, and writes nothing. `npx tsx scripts/model-probe.mts <provider> <model>` tests one model
  and refuses paid routes without `--allow-paid`. `npm run catalogue:test` runs the offline checks
  (CI runs them too).
- Profiles: each chat model carries purpose tags (research, coding, reasoning, writing, vision,
  long-context, multilingual, agentic) and a profile. A lookup drafts the profile from free
  sources on free models; nothing is used until you approve it on `/admin#models`, where Approve
  on a discovered model accepts the model, its profile and the ticked tags together. Speed comes
  from the last 14 days of recorded calls, or the latest test when there are fewer than 3.
  `npx tsx scripts/model-lookup.mts <provider> <model>` drafts one profile without saving, and
  `npx tsx scripts/model-roster.mts [purpose]` prints the roster. `npm run models:test` runs the
  offline checks (CI runs them too). The tables come from `scripts/migrations/v7-model-awareness.sql`.

### Provider keys

Each provider's API key can be set, replaced, tested and cleared on `/admin` under
**Providers and keys**. A saved key wins over the env var, and clearing it falls back to the env
var. Changes apply on the next request, with no restart.

- Keys are encrypted with AES-256-GCM before they reach the database (`provider_keys`). The
  encryption key is derived from a 32-byte master key that never goes to the database. Each row
  is bound to its provider and to a fingerprint of the master key, so dev and production can share
  one database without reading each other's rows.
- The browser never gets a key back: only where it came from, the last 4 characters and the date.
  The last 4 are not stored; they come from the decrypted key.
- Save first checks the key with one small authenticated request. A 401 or 403 refuses it; a
  timeout or server error saves it with a warning.
- Save, Replace and Clear ask for the access password again (same lockout as sign-in) and post a
  notice to the Discord system channel naming the provider, never the key. The routes accept only
  a signed-in browser session, not the `CHAT_API_KEY` bearer token.
- With auth on but no `ACCESS_PASSWORD` (passkey only), key changes are refused.
- Cloudflare's token cannot read its own account, so its row has an Account id field. The id is
  saved with the token in the same encrypted value; a new token alone keeps the saved id. Its key
  check verifies the token, then runs one model search under the account id.

What the encryption protects against:

| Threat | Result |
| --- | --- |
| Database dump or backup leaks | Safe: rows hold ciphertext only |
| Supabase service-role key leaks | Safe: the master key is not in Supabase |
| Supabase account or dashboard taken over | Safe |
| Stolen browser session | Can replace or clear a key only with the access password; can never read one |
| `CHAT_API_KEY` leaks | Key routes refuse the bearer token |
| The server itself is compromised | Not protected: the app must decrypt keys to call providers unattended. Keep keys on free tiers and rotate them from the dashboard |
| A copy of `.env.local` leaks | Exposed only if it holds the production master key, so use a different one in dev |

Production setup: the master key lives in a root-only file and reaches the app as a systemd
credential (`LoadCredential=provider-keys:/etc/zuychin/provider-keys.key`), so it is not in the
process environment. The app reads `$CREDENTIALS_DIRECTORY/provider-keys`, and falls back to
`PROVIDER_KEYS_SECRET` elsewhere. Without a master key, or before
[`scripts/migrations/v7-provider-keys.sql`](scripts/migrations/v7-provider-keys.sql) is applied,
the panel still lists every provider and its env key, and Save is disabled with the reason.

To change the master key: provide the old one as the `provider-keys-previous` credential (or
`PROVIDER_KEYS_SECRET_PREVIOUS`), write a new current key and restart. On start the app
re-encrypts every saved key with the new master key and deletes the old rows, and the panel says
so. Then remove the previous credential and restart again. Losing the master key means
re-entering each saved key.

### Migrating knowledge embeddings

The usual way to change the knowledge model is **Switch knowledge to this** on `/admin#models`,
which runs the same migration as a server job. The script below stays for manual use. Targets
are registered model IDs, or `<model>@<dimension>` for a reduced size; `--provider <id>` picks
the route when more than one provider serves the model. Run a read-only plan first, using the
environment that owns the store and the target provider's key:

```powershell
npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/reembed-knowledge.ts --model nvidia/nemotron-3.5-embed-1b --concurrency 6
```

For an authorised migration, add `--apply` to the same command:

```powershell
npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/reembed-knowledge.ts --model nvidia/nemotron-3.5-embed-1b --concurrency 6 --apply
```

The script scans `embeddings`, `memories`, `vault_pages`, `knowledge_chunks` and
`knowledge_assertions`, including rows with missing or invalid vectors. It prepares and
validates target vectors before writes, conditionally updates unchanged source rows, then
rescans every table. Conflicts, failed writes or remaining rows prevent activation and
produce a non-zero exit. Rerunning skips valid rows already on the target model. This is
resumable work, not an atomic database transaction; partially updated rows remain after a
write-phase failure. Concurrency defaults to 2 and accepts 1–8.

After successful verification, `cron_state.knowledge_embedding` activates the target.
Runtime selection resolves explicit model, saved runtime override, environment override,
then registry default. No SQL/schema change is required for this model refresh. A changed
registry or a successful endpoint probe does not establish that a hosted store was migrated.

## MCP Tools

The model can call these tools during a chat turn (see `lib/ai/mcp-service.ts`):

| Tool | Purpose |
|------|---------|
| `get_current_time` | Current date/time in a given timezone |
| `search_web` | Real-time internet search (OpenAI-compatible models only; Gemini grounds natively) |
| `search_knowledge` | Hybrid keyword + vector search over the pgvector knowledge base |
| `search_history` | Semantic search over your own past messages across channels, with links that open the conversation |
| `save_note` | Persist a note as an embedding for later recall |
| `capture_add` | Save a link or passage to the Capture inbox and return a link to its Review (unattended tasks need approval) |
| `get_recent_conversations` | Summary of recent messages across channels |
| `manage_calendar_event` | Create or delete a Google Calendar event |
| `list_calendar_events` | List upcoming events within N hours |
| `list_unread_emails` | List unread Gmail (supports search filters) |
| `list_recent_emails` | List recent Gmail, read or unread (defaults to last 7 days) |
| `read_email` | Read a full email body by message ID |
| `draft_gmail_reply` | Create a draft reply in Gmail |
| `send_email` | Compose and send a new email |
| `manage_todo_list` | Add / list / complete / skip / delete to-do items (feeds the web Notes checklist) |
| `manage_scheduled_task` | Create / list / update / delete one-off or recurring scheduled tasks |
| `manage_memory_facts` | List / forget / correct the extracted long-term Known Facts |
| `manage_notes` | List / update / delete saved knowledge-base notes (by category) |
| `vault_search` | Hybrid keyword + vector search over second-brain wiki pages, one hit per page (its best section) |
| `vault_read` | Read a wiki page from the vault |
| `vault_ingest` | Full ingest pipeline: raw capture → authored page → links → verified commit |
| `vault_write` | Direct wiki page write (index/log/embedding kept consistent) |
| `vault_delete` | Permanently delete a wiki page + every reference to it, in one commit |
| `vault_lint` | Vault health check / auto-fix curator |
| `model_status` | Read-only model health: the last model check, failing, missing, unreliable and slow models, drafts waiting for review, and the best free picks for a purpose |
| `council_propose` | Draft a council in the web chat and render a Start card; creates nothing until you click. Optional `research` (`web`, `notes`, `query`) |
| `council_convene` | Start a council straight away and return its code (Telegram, Discord). Optional `research` as above |
| `council_status` | How the open councils are going, or one council's state and recent transcript; names each online seat's model |
| `council_close` | Force a council closed and file the outcome, writing a verdict if none was given |

Agent runs additionally get `create_document` / `create_code_file` / `create_code_bundle`
(downloadable artifacts - generated documents are auto-embedded into the knowledge base),
`update_plan` (live step tracker), `use_skill` (loads a skill's full instructions -
built-in or approved custom), `save_skill` (files a new draft skill for review),
`run_subagents` (parallel workers on free fast models, picked by an optional purpose tag),
`list_models` (the roster with tags, speed and reliability), `ask_model` and `compare_models`
(short text-only questions to one or a few models, 6 calls per run) and `rate_workers`
(scores each worker's answer once per run, which feeds later picks).

## Shared MCP Server

The tools above are the assistant's *internal* registry (passed to the model as function
declarations). Separately, the app also runs a real [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp/mcp`** (stateless Streamable HTTP, legacy SSE at `/api/mcp/sse`) so
your **other AI agents and chatbots** can share the knowledge base:

Access levels: **read** = any key. **notes** = a notes-level or full key. **vault** = a full key.
Councils are not on this server: they start from the app, the chat or Telegram.

| MCP tool | Access | What it does |
|----------|--------|--------------|
| `search_knowledge` | read | Hybrid keyword + vector search over the shared knowledge base (optional note-category filter) |
| `list_notes` | read | Browse saved notes newest-first, optionally by category tag |
| `vault_search` | read | Search the second-brain vault pages, one hit per page (uses the vault's dominant embedding partition) |
| `vault_read` | read | Fetch a vault page's full Markdown by path |
| `get_recent_conversations` | read | Recent messages across channels, for shared context on what you've been working on |
| `save_note` | notes | Store a note that becomes searchable by every connected agent and the assistant |
| `update_note` | notes | Rewrite a saved note's text and/or category (re-embedded; for correcting stale info) |
| `delete_note` | notes | Remove a saved note (never touches conversation history) |
| `vault_ingest` | vault | File durable knowledge (study notes, project docs, plans) through the full vault pipeline |
| `vault_write` | vault | Direct vault page create/overwrite with complete Markdown |

### zuychin-council

A council is a bounded debate between chat models, run by the server. Councils of coding agents
on your own machine have moved to Converoom; old ones here stay readable as transcript and
verdict.

#### Running a council

A council is a debate whose seats are chat models from the selectable list. The server
runs it, so nothing has to run on your machine and it carries on when you close the page. Start
one from the **Start a council** panel on `/council`, or ask the assistant for a council:
in the web chat it drafts a card with a **Start** button, and in Telegram or Discord it starts
straight away. **Auto-fill** picks free models from different vendors for a purpose (reasoning
by default), and each seat's model can be changed before starting. Each seat's **Preset** picker
fills its angle from a short list (Champion, Stress tester, Sceptic, Security reviewer, Cost
reviewer and others); the angle stays editable.

- Round 1 openings are written blind and at the same time. Later rounds take turns, one post per
  seat, with the opener rotating. After each round a moderator note names what is owed and what
  the next round should settle. The closer then writes the verdict, which waits for your Accept
  or Continue like any council.
- A seat that fails gets one retry after 5 s, then passes the round with the error. Two failed
  rounds in a row and it leaves; under two seats left, the closer writes the verdict early. A
  seat whose model is removed from the list leaves at its next turn.
- Paid models need **Allow paid** ticked for that council, and Free only always wins, checked again
  every turn. Auto-fill only picks free models.
- Seats see only the brief, the transcript and any research sources: no tools or files. Calls
  are recorded in model health under the `council` purpose.
- **Research first** (off by default): **Search the web** runs one Tavily basic search (1 credit)
  and **Include my notes** searches saved notes, plus up to 3 vault pages unless Free only is on.
  Chat messages are never included. The query defaults to the topic; **Search for** sharpens it.
  The server searches once before round 1 and posts the results as one moderator message,
  labelled `sources` in the transcript. Every seat and the closer get it pinned in their prompt
  as numbered sources (`[W1]`, `[N1]`, `[V1]`) and cite them by marker; code appends the links
  for the cited markers under the verdict, so a model never writes a URL. There is no Gemini
  fallback: if Tavily fails or is out of credits, the council runs anyway and says so. Notes go
  to every seat's provider, so that tick is yours to choose.
- The server holds the council's host lease. After a restart or deploy, a scan in the server
  process (and the council sweep as a backstop) picks the council up again once the old lease
  lapses, within about two minutes. Set `COUNCIL_ONLINE_RESUME` to change that.

Council output is filed to the vault as `trust: untrusted`, `status: suggested` at
`wiki/synthesis/council-<code>.md`, so an unreviewed agent debate cannot outrank
human-reviewed material in the assistant's own recall. Promote it yourself with `vault_ingest`
if it earns it. Council messages are never embedded or indexed anywhere else.

The council tables live in the `-- ===== Council wave =====`,
`-- ===== Council work campaign wave =====`, `-- ===== Council ACP host wave =====`,
`-- ===== Council V3 wave =====` and `-- ===== Council V3.5 wave =====` blocks at the bottom of
`supabase-setup.sql`. The campaign and host blocks still run on a fresh install, because later
blocks build on them, and the `-- ===== V7 local Council cleanup =====` block at the very end then
drops what only the retired local host used. Run the full idempotent script in the Supabase SQL
Editor before first use. For existing installations, follow the upgrade notes below.

**Local council clean-up.** [`scripts/migrations/v7-council-local-cleanup.sql`](scripts/migrations/v7-council-local-cleanup.sql)
drops six tables (`council_campaigns`, `council_work_items`, `council_verification_runs`,
`council_integration_attempts`, `council_owner_notes`, `council_deliveries`) and 34 functions that
only the retired local host called: campaigns and work items, host verification and integration,
owner notes, durable delivery, guest seat keys, floor election and `conclude_council`. It also
redefines `renew_council_host_lease` without its campaign branch, which only renewed seat keys during
a code campaign. Online councils keep sessions, messages, participants, owner messages, host leases,
host-issued seat keys and execution records, and old councils keep their transcripts and verdicts.
The drop deletes the old campaign rows, so take a database dump first. It is safe to re-run and uses
no `CASCADE`, so an unexpected dependency fails the whole transaction. `npm run council:v3:test`
rebuilds the council schema in PGlite and checks the migration offline.

**Paused Council expiry.** A Council expires after seven consecutive paused days, retaining its
transcript and pause history. Resuming before that deadline restores the running clocks; a later
pause starts a new seven-day interval. Expired pauses cannot resume, even if the scheduled sweep
has not run. Expiry stops debate without creating a verdict or deleting messages.

Before deploying this policy to an existing installation, apply the complete
[`scripts/migrations/council-paused-expiry.sql`](scripts/migrations/council-paused-expiry.sql)
through the Supabase SQL Editor. It updates the pause/resume functions without changing the schema
or existing records. Fresh installations receive the same functions from `supabase-setup.sql`.
Run `npm run council:pause:test` for the offline expiry, resume and transcript-retention checks.

An existing installation also needs these complete migrations, in this order:
[`council-execution-attribution.sql`](scripts/migrations/council-execution-attribution.sql),
[`council-owner-merge-package.sql`](scripts/migrations/council-owner-merge-package.sql),
[`council-execution-policy.sql`](scripts/migrations/council-execution-policy.sql) and
[`council-runtime-inventory.sql`](scripts/migrations/council-runtime-inventory.sql). Online seats
depend on the first: each seat gets a credential bound to its run, and its messages keep that run's
identity. Historical messages stay explicitly unattributed. Fresh installations get all four from
`supabase-setup.sql`. `npm run council:attribution:test` covers seat identity, execution evidence
and the evidence components offline.

**Run the whole script or a complete standalone migration, never an extracted fragment.**
Several functions are defined more than once across the
waves, so re-running an earlier block alone silently reverts a later definition. That happened once:
acceptance quietly fell back to the pre-V3 behaviour with nothing logged anywhere. `npm run
council:schema:check` exists to catch that. It claims and renews a throwaway host lease, which fails
if an older block has put back a renewal body that reads the dropped campaign tables, and checks
that the local-only functions stay dropped. It writes to the database, so run it only against a
disposable Supabase (CI runs it).

For existing installations with the Council V3.5 named-client tables, apply the complete
[`scripts/migrations/council-agent-claims.sql`](scripts/migrations/council-agent-claims.sql)
before deploying this version. It adds the required `mint_agent_claim` RPC and hardens the
credential lifecycle; deploying the code first prevents new setup claims from being minted.
Confirm the migration succeeded and the RPC is available through the Supabase REST schema cache
before deployment. Fresh installations receive the same migration in `supabase-setup.sql`.
Before upgrading, issue and verify a named client key for every knowledge caller, including
other machines and ad hoc scripts. This version rejects the retired shared bearers even if
`MCP_API_KEY` or `MCP_API_KEY_READONLY` remains configured on the server.

Knowledge tools pin the default embedding partition and no user filter, so external agents
read and write the **same global store** the assistant uses. Vault writes pin the vault's
dominant embedding partition so pages never fragment across models. `vault_delete` is
deliberately not exposed - page removal stays with the assistant and the graph UI.

**Configure knowledge clients with a named client key.** The **Agents** panel on the dashboard adds an agent,
picks its access level, and hands back a setup brief. The brief carries a 15-minute *claim*, not the
key: the agent exchanges the claim at `POST /api/agent/claim` and writes its MCP config once with
the real key already in place. Every key is tracked, shows its last use, and is revocable on its own
without touching any other agent.

A claim works once. A retry within 60 seconds of the first exchange returns the same key (for a
response lost on the way back); after that the claim is refused, so a claim copied from a chat
transcript cannot recover the key. Existing installations apply
[`scripts/migrations/v7-claim-single-use.sql`](scripts/migrations/v7-claim-single-use.sql) once;
until then a claim can be retried for its whole 15 minutes.

Three access levels, chosen when the claim is minted and not raisable by the agent:

| Level | Grants |
|---|---|
| Read-only | search and read tools only |
| Notes read/write | adds `save_note`, `update_note`, `delete_note` |
| Full read/write | adds `vault_ingest`, `vault_write` |

No key can convene or join a council. Keys issued at the old council level still work as full
read/write; their council scope no longer opens anything.

Setup:

1. In `/agents`, add one named client per installation and choose its access level.
2. Give that client its setup brief. It redeems the 15-minute claim at `POST /api/agent/claim`
   and stores the returned `zck_` key privately in its MCP configuration.
3. Point the client at `https://<your-app>/api/mcp/mcp` with
   `Authorization: Bearer <named-client-key>`. Replace an existing credential for that endpoint,
   then restart or reconnect the client so it loads the new key.
4. Verify a read operation and the client's last-used entry in `/agents`. Missing, unknown,
   revoked or expired credentials receive HTTP 401. Named keys work without either retired
   shared environment variable; no shared-key fallback remains.

**Or connect a client from a terminal, without pasting anything into a chat.** For Claude Code,
Codex, Cursor and Antigravity on this machine, mint the claim as in step 1, then run this from a
normal terminal (not from inside an agent session) and paste the claim at the hidden prompt:

```powershell
npm run agent:connect -- claude
```

Use `codex`, `cursor` or `antigravity` in place of `claude`. The script
([`scripts/agent-connect.mts`](scripts/agent-connect.mts)) exchanges the claim, keeps the key in
memory, and writes it straight into the client's config: `~/.claude.json`, `~/.cursor/mcp.json` or
`~/.gemini/config/mcp_config.json`. An existing entry for the same endpoint keeps its name and only
its Authorization header changes; otherwise it adds `zuychin-knowledge`. Codex reads its key from
the user environment variable that its `~/.codex/config.toml` entry names (`ZUYCHIN_MCP_KEY` by
default, Windows only), so the TOML file never holds the key. The script then runs `initialize` and
`tools/list` with the new key and reports the tool count. It never prints the claim or the key, and
it checks the config before it spends the claim. The base URL comes from `NEXT_PUBLIC_BASE_URL`,
then `AUTH_ORIGIN`, in `.env.local`, or from `--url`; `--config` points at a config file in another
place. If the claim was minted for a different agent, it asks before saving. Restart the client
afterwards (for Codex, reopen the terminal as well, so it reads the new variable).

For local inspection, use the MCP Inspector (`npx @modelcontextprotocol/inspector`, transport
"Streamable HTTP") with a separate named client. Anything saved through `save_note` later
surfaces in the assistant's own context, so choose write access deliberately.

## Models on Discord / Telegram

The messaging channels pick the first available configured model in this order:

1. Nemotron 3 Ultra (NVIDIA NIM)
2. GLM-5.3 Flash (NVIDIA NIM)
3. Gemini 3.8 Flash

Switch the model from inside a chat with the `/model` command. The choice is saved per channel
and reused until you change it again. Every command also accepts a `!` prefix (e.g. `!model`)
since Discord reserves `/` for its own slash-command UI:

- `/model` (or `/model list`) shows the current model and every available provider + model,
  with "new" or "missing" for catalogue models in those states, plus speed and the first three
  purposes when known.
- `/model <purpose>` (for example `/model coding`) lists the five best usable models for that
  purpose with the command to switch to each. Free only narrows it to free models.
- `/model <provider> <model>` switches and remembers the choice, e.g.
  `/model nvidia-nim nemotron-3-ultra` or `/model gemini gemini-3.8-flash`.
- `/embed-model` names the knowledge model, which every channel shares. It is changed on
  `/admin#models`, because a switch re-embeds the whole store.

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
  so Discord doesn't capture `/`), downloads attachments (up to 7 MB; larger ones get a "too large" reply), uploads any generated
  files (reports/code) as attachments, and chunks replies to Discord's 2000-char limit.
- `!new` starts a new conversation and `!help` lists the commands. The web app keeps the
  channel's conversation, so the bot sends no conversation id.
- Exposes a health endpoint on `PORT` (default `3001`) and ships a `Procfile` (`web: node bot.js`)
  for hosts that read one.

## Speech-to-text service (optional)

`stt-service/` is a small Node server that turns web voice turns into text on your own host. It
has its own `package.json` and is not part of the Next build.

```bash
cd stt-service
npm ci
STT_TOKEN=<32 or more random characters> STT_MODEL_DIR=<model folder> npm start
```

- Model: download `sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2` from the
  [sherpa-onnx `asr-models` release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)
  and unpack it. `STT_MODEL_DIR` must hold `encoder_model.ort`, `decoder_model_merged.ort` and
  `tokens.txt`.
- It listens on `127.0.0.1` only, on `STT_PORT` (default `3010`). `POST /transcribe` takes the
  bearer token and 16 kHz 16-bit PCM; `GET /health` says whether the model has loaded. A
  transcription that arrives while the model loads waits for it. Logs hold sizes and timings,
  never the words.
- On demand under systemd: a socket unit can hold the port and start the service on the first
  request, which it detects from `LISTEN_FDS`. Started that way, the service exits after
  `STT_IDLE_EXIT_SEC` (default 600) without requests, which frees all its memory, and the next
  request starts it again. Loading took about 1 s on a desktop PC and 2.4 to 4.7 s under a
  one-eighth-core CPU cap. The web app sends a warm-up when the mic is tapped, so the load mostly
  happens while you speak. Started directly with `npm start`, it stays up.
- One transcription runs at a time with up to two waiting. Anything more gets 503, and the web
  app sends that turn's audio to Gemini instead.
- Turns longer than `STT_SEGMENT_SEC` (default 15, from 5 to 60) are cut at the quietest point
  and read in pieces. This kept memory at about 220 MB in local tests, at some cost to accuracy
  on long turns.
- `npm start` runs Node with `--expose-gc`, and the server collects garbage after each job,
  because the recogniser holds native memory that V8 does not count.
- Set the web app's `STT_SERVICE_URL` and `STT_SERVICE_TOKEN` to match.
  `npm test --prefix stt-service` runs the offline tests with a fake recogniser.

## Text-to-speech service (optional)

`tts-service/` is a small Python server that speaks replies on your own host with
[tiny-voca](https://huggingface.co/n4ze3m/tiny-voca) (English, two voices, Apache-2.0) and
[dizione](https://github.com/n4ze3m/dizione) for text to phonemes. It is not part of the Next build.
Its README has the API, limits and settings.

- It listens on `127.0.0.1` only (`TTS_PORT`, default `3011`) and takes a bearer token
  (`TTS_TOKEN`). `POST /speak` streams 24 kHz 16-bit PCM one sentence at a time, so the first
  sentence plays while the rest is made. Logs hold sizes and timings, never the text.
- It needs Python 3.12 with `numpy` and `onnxruntime`, and the model files (`onnx/model.onnx` and
  `phonemizer/`) from the tiny-voca repository in `TTS_MODEL_DIR`. Measured on a 1 GB, 2 vCPU box:
  about 0.45 s to first audio for an 80-character sentence, about 130 MB loaded and 170 MB at peak.
- Like the speech-to-text service, it can run on demand under systemd socket activation and exit
  after `TTS_IDLE_EXIT_SEC` (default 900) of quiet. The web app warms it when a voice chat starts.
- The web app tries it first and falls back to Gemini, so set `TTS_SERVICE_URL` and
  `TTS_SERVICE_TOKEN` to match. To always use one engine, set `voice.speechEngine` in the saved
  preferences to `local` or `gemini`.
- Pronunciation fixes go in a file named by `TTS_OVERRIDES` (see `tts-service/overrides.example.txt`).
  Run the offline tests with `python -m unittest discover -s tts-service/tests -t tts-service`.

## Telegram Bot (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and set `TELEGRAM_BOT_TOKEN`.
2. Choose a random `TELEGRAM_WEBHOOK_SECRET` and set `TELEGRAM_CHAT_ID` to your chat.
3. Point Telegram at your deployed webhook (it must be public HTTPS):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-app>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Signed in, `GET /api/telegram/test` checks the configuration.

The webhook acknowledges each update at once and answers it in the background, and it runs each
update id once. It acts only for an allowed chat and an owner sender, and it accepts the
approval buttons on the same terms. On start the server sets the bot's command menu: `/new`,
`/search`, `/think`, `/agent`, `/model` and `/help`. Each chat keeps its own conversation; see
the V7 channel threads migration under [Database](#3-database).

## Cron Jobs (optional)

Point an external scheduler (for example cron-job.org) at these endpoints with the header
`Authorization: Bearer <CRON_SECRET>`. Delivery is centralized in the notification router
(`src/lib/messaging/router.ts`): each notification type routes to its dedicated Discord
channel, with push mirrored only for time-sensitive types and Telegram reserved for
conversational chat, initiative nudges and approval requests.

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
| `/api/cron/council-sweep` | Every 15 min | `{}` |
| `/api/cron/model-discovery` | Daily (quiet hour) | `{}` |

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
Model discovery answers 202 straight away and runs the check in the background, since tests can
take minutes (see [Model catalogue](#model-catalogue)).

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
   `GITHUB_VAULT_REPO`, `GITHUB_VAULT_TOKEN`, `GITHUB_VAULT_BRANCH` in `.env.local` and the
   production environment.
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

- **Pages** reads the GitHub Markdown source and shows indexed chunks, links, trust,
  sensitivity, scope and lifecycle status. Corrections create Git commits; archive,
  restore, retire and promote update frontmatter without deleting history.
- **Ask** exposes semantic, lexical, graph, authority, freshness and importance
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
deliberately dark-only whatever the app theme is set to. In the overview, a page is a star,
its size reflects its degree, its brightness reflects its PageRank centrality, and its shape
says what kind of page it is - a crisp main-sequence star is
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
  chain of visible links lights up as a corridor with every hop listed. If no route exists in
  the current view, broaden the filters or return to the overview to check the rest of the vault.
- **Constellations** are detected communities (label propagation), each with its own hue, a
  soft nebula, and a name taken from its most central page. A cohesion force pulls each one
  together so they physically separate.
- **Health** surfaces what the vault lint cron finds - orphans, links pointing at nothing,
  stale pages, malformed frontmatter, unreviewed pages - as a filter over the graph. Filtering
  to *unreviewed* turns the view into a review queue, which is where council output lands.
- **Time travel** replays the vault's growth from a scrubber; stars ignite in creation order.
  Page dates are real, link dates are inferred from their endpoints, and the UI says so.
- **Section systems**: isolating a page ("System", or double-click a star) turns its own
  headings into planets orbiting it, with deeper headings as moons. Clicking a body or its
  keyboard-accessible label opens the exact heading without selecting a star behind it. The
  sticky **In this document** outline provides access to every heading, including those whose
  canvas labels are hidden to avoid crowding.
- **Materials and spacing**: lit sphere surfaces, clouds, craters, gas bands, tilted rings and
  a textured central star blend cinematic detail with atlas labels. Orbits account for the
  full planet, ring and moon envelope. Neighbouring stars stay outside that space and retain
  a minimum visible size; the scene favours readability rather than astronomical scale.
- **System navigation**: pause the orbits, zoom with the visible controls, or use **Fit** or
  `f` to frame the current system. Hover and keyboard focus pause bodies for selection. The
  camera adapts to the reader and mobile dock, while reduced-motion preferences stop orbital
  motion and animated camera transitions.
- **Gravity wells** ranks the most central and most weakly held pages.
- Click a page to read, edit or delete it - deletion strips every reference in other pages,
  the `index.md` entry and the pgvector row in one atomic commit. Click a connection to remove
  it in both directions.
- **Suggested arcs** are curved cyan links between similar-but-unlinked pages. The page panel
  also lists candidates for that one page with a checkbox column, so several can be accepted at
  once (each as its own commit).
- Every view is addressable: lens, categories, query, selection, route ends, local mode and the
  timeline position live in the URL. All categories disabled is preserved too, with a reset
  action for the empty view.
- Labels are an HTML overlay with distance culling rather than per-node textures, and a bloom
  pass turns itself off above 600 nodes or on a software renderer. `Full effects` in the
  Explore panel is the manual override.

You can still point Obsidian at a clone of the repo - the on-disk format is plain
Markdown + wikilinks.

Run `npm run cosmos:test` for heading identity, filters, camera gestures, orbital spacing and
force-engine clearance regressions. The [cosmos design record](scripts/COSMOS_DESIGN.md)
sets out its visual and interaction rules.

## Deployment

- Web app: any always-on Node host. `next.config.ts` builds a standalone server
  (`output: "standalone"`): run `npm ci` and `npm run build`, copy `.next/static` to
  `.next/standalone/.next/static` and `public` to `.next/standalone/public`, then start
  `node .next/standalone/server.js` with the `.env.local` variables in its environment.
  `NEXT_BUILD_CPUS` (default 2) caps the build's page-data workers, which otherwise run out of
  memory on a 16 GB machine.
- Behind a tunnel or reverse proxy the server sees its own bound address as the request origin,
  so set `AUTH_ORIGIN` (and `NEXT_PUBLIC_BASE_URL`) to the public origin; origin checks and
  absolute links use it. Set `AUTH_RP_ID` and `AUTH_ORIGIN` to that exact domain before enrolling
  a passkey. Do not rotate `AUTH_SESSION_SECRET` without also resetting TOTP recovery data.
- Update the Google OAuth redirect URI and the Telegram webhook URL to your production domain.
- If the host has no IPv6 route, start Node with
  `NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection`, or distant API
  hosts can fail Node's 250 ms connection race.
- Apply `supabase-setup.sql` after deployment upgrades. It is idempotent and includes the
  passkey, TOTP, council and model catalogue schema.
- Give the Discord bot `CHAT_API_KEY` and the web app the identical value; cron callers need
  `Authorization: Bearer <CRON_SECRET>`.
- Discord bot: any always-on host, the web app's machine included, running `node bot.js` (as in
  `discord-bot/Procfile`) with `ZUYCHIN_API_URL` pointing at the deployed web app.
- Speech-to-text service: run it on the web app's machine, since it only listens on
  `127.0.0.1`. Allow it about 300 MB of memory while it runs. On a small host, start it from a
  systemd socket unit so it only runs during voice use, and give it a lower CPU weight than the
  web app so transcription never slows chat.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                        # Chat UI (state, handlers, layout)
│   ├── manifest.ts                     # PWA manifest
│   ├── home/
│   │   ├── controls.tsx                # Model dropdown, param sliders, model-info modal
│   │   ├── conversation-list.tsx       # Sidebar list with project groups + move/rename menus
│   │   ├── council-card.tsx            # Proposed council card in chat, with the Start button
│   │   ├── day-starters.ts             # Chat starters drawn from the day
│   │   ├── reply-sources.tsx           # Chart and list of the sources behind a reply
│   │   ├── voice-pcm.ts                # Recording → 16 kHz PCM, then the transcribe request
│   │   ├── voice-stage.tsx             # Voice chat stage: phase label, Send now / Skip / End
│   │   ├── voice-constellation.ts      # The stage's canvas star chart, one look per voice phase
│   │   ├── audio-level.ts              # Mic and speaker loudness, 0 to 1
│   │   └── chat.module.css             # Chat page styles
│   ├── knowledge/                      # Library: page list, reader, link chart, possible connections
│   ├── research/ study/ capture/ tasks/ # The other workspaces
│   ├── graph/page.tsx                  # 3D knowledge-graph view of the vault
│   ├── council/
│   │   ├── page.tsx                    # Live council view: transcript, decision, pause and owner thread
│   │   └── online-council-panel.tsx    # Start a council and pick each seat's model
│   ├── login/page.tsx                  # Login page
│   ├── admin/                          # Dashboard + model health, model catalogue (every model type, in folding sections), run-trace, memory, skills and agent-credential panels
│   └── api/
│       ├── auth/                       # Login/logout + Google OAuth callback
│       ├── agent/claim/route.ts        # Unauthenticated claim → per-agent key exchange (rate limited)
│       ├── agents/                     # Owner-only: agent clients, claim minting, key revocation
│       ├── chat/route.ts               # RAG chat endpoint (+ chat/stream for SSE)
│       ├── providers/route.ts          # Available providers/models
│       ├── conversations/route.ts      # Conversation CRUD + move between projects
│       ├── projects/route.ts           # Project CRUD
│       ├── todos/route.ts              # Notes checklist backend
│       ├── today/route.ts              # Today digest (events + todos)
│       ├── tts/route.ts                # Voice-reply synthesis (blocking or streamed PCM)
│       ├── voice/                      # Transcribe a voice turn, warm-up and speech-to-text status
│       ├── push/subscribe/route.ts     # Web-push subscription registry
│       ├── export/route.ts             # PDF/DOCX export
│       ├── telegram/                   # Webhook + config check
│       ├── cron/                       # Briefing / reminders / scheduled tasks / email triggers / initiative / run review / proactive / vault lint / model discovery
│       ├── vault/                      # health, graph data, page CRUD, link create/delete
│       ├── artifacts/[id]/route.ts     # Download generated files
│       └── admin/                      # Status, personality, run traces, memories, skills, model health, model catalogue, knowledge model switch, voice and media model choices
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
│   │   ├── providers.ts                # Provider + chat/embedding model registry, merged with the catalogue
│   │   ├── catalogue/                  # Model discovery: provider lists, tests, stored catalogue, daily check
│   │   ├── models/                     # Model awareness: tags, speed, roster, lookups, profiles, model_status, /model text
│   │   ├── embeddings.ts               # Embedding dispatcher (Gemini / OpenAI-compatible), same-space backups
│   │   ├── embedding-switch*.ts        # Server job that re-embeds the store and activates a new knowledge model
│   │   ├── embedding-cutoffs.ts        # Similarity cut-offs per embedding model
│   │   ├── openai-compat.ts            # OpenAI-compatible client (OpenRouter, Kilo, NIM, Groq, Agnes, Cloudflare, DeepSeek, OpenCode) + tool loop
│   │   ├── groq.ts                     # Groq request quirks (field names, reasoning switches)
│   │   ├── provider-keys/              # Encrypted provider keys: master key, AES-GCM, store, snapshot, key checks, admin actions
│   │   ├── provider-rest.ts            # A provider whose free allowance is used up rests until its reset, with one notice
│   │   ├── media/                      # V8 kinds: request adapters, live sessions, per-kind choice and resolver
│   │   ├── rerank.ts                   # Rerank with a time limit; keyword-rank.ts is the fallback
│   │   ├── decisions.ts                # Yes/no, choice and score questions to a decision model; memory/gate.ts uses it
│   │   ├── reply-sources.ts            # Records the sources each reply used
│   │   ├── rag-service.ts              # RAG pipeline; branches on provider + grounding fallback
│   │   ├── web-search.ts               # Real-time web search (Tavily) for non-Gemini models
│   │   ├── mcp-service.ts              # MCP tool definitions + executors
│   │   ├── tts.ts                      # Speech plan: on-box voice, then the backup voice or Gemini (streamed PCM → WAV)
│   │   ├── voice-choices.ts            # Owner's backup voice and transcription order
│   │   ├── initiative-store.ts         # Initiative decision log + send gates + feedback
│   │   ├── embedding-override.ts       # Runtime knowledge-store partition override
│   │   ├── agent/                      # Intent router, orchestrator, sub-agent workers
│   │   └── skills/                     # Skill registry: built-in playbooks + agent-authored custom skills
│   ├── agents/                         # Per-agent credentials: clients, claims, scope predicates, setup brief
│   ├── council/                        # Councils: protocol constants, store, runner, research step, moderator, closing, execution records
│   ├── vault/                          # Second brain: GitHub client, ingest, lint, graph ops, page index
│   ├── artifacts/                      # Generated-file storage (documents, code, zips)
│   ├── integrations/                   # Google Calendar + Gmail
│   ├── voice/                          # Speech-to-text client, API speech and transcription adapters, the "Spoken" input mode, Telegram voice-note decoding, long recordings, Discord voice messages
│   ├── tasks/                          # Scheduled tasks, runner, approvals, Telegram approval notices, ask-before-send for chats
│   └── messaging/                      # Discord + Telegram + web-push services, channel conversations, notification router
├── components/
│   ├── app-sidebar.tsx                 # Shared sidebar: workspaces, chat history, theme
│   ├── zuychin-mark.tsx                # Animated Zuychin mark: blink, pointer follow, live states
│   ├── workspace-shell.tsx             # Top bar with title, tabs and actions for each workspace
│   ├── today-panel.tsx                 # Today panel: the day, due items, to-dos, scheduled tasks
│   └── dropdown.tsx                    # Shared listbox used by every select in the app
├── proxy.ts                            # Cookie auth proxy (Next 16 middleware convention)
├── instrumentation.ts                  # Loads the model catalogue before the server takes requests
public/sw.js                            # Service worker: push display + click-through
discord-bot/
├── bot.js                              # Discord Gateway bot + health server
└── Procfile                            # Process definition (web: node bot.js)
stt-service/
├── server.js                           # Local speech-to-text server: token, limits, queue, /health, idle exit
├── recognizer.js                       # Moonshine tiny through sherpa-onnx-node
├── segment.js                          # Cuts long turns at the quietest point
└── test/                               # Offline tests with a fake recogniser
scripts/
├── check-council-schema.mts            # Behavioural guard: fails if an old block reverted lease renewal or the clean-up
├── test-council-protocol.mts           # Council Postgres protocol tests
├── test-council-v3.mts                 # Online seat capabilities and schema functions (local)
├── test-council-v3-db.mts              # V3 lease, seat key and execution tests, and the clean-up check
├── test-council-local-cleanup.mts      # The local council clean-up migration in PGlite (offline)
├── test-agent-credentials.mts          # Scope split + per-agent key mint/exchange/revoke tests
├── test-mutation-journal.mts           # Mutation-journal tests
├── evaluate-knowledge.ts               # Knowledge-store retrieval eval
├── reembed-knowledge.ts                # Manual store re-embed
├── model-discovery-dry-run.mts         # What a model check would add, mark missing and test (writes nothing)
├── model-probe.mts                     # Test one model by hand (paid routes need --allow-paid)
├── model-lookup.mts                    # Draft one model's profile from free sources (writes nothing without --save)
├── model-roster.mts                    # Print the model roster for a purpose (read-only)
├── test-catalogue-*.mts                # Model catalogue checks (npm run catalogue:test)
└── test-model-*.mts                    # Model awareness checks, with test-agent-model-tools (npm run models:test)
supabase-setup.sql                      # One-shot database setup script
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and what a change has to keep true,
and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE) © Duy Nguyen
