# Zuychin Assistant V6 Feature Proposals

Recorded: 23/09/2026. Updated: 28/09/2026 (implementation authorised with Council V4 boundaries).

Status: Implementation authorised on 28/09/2026 for features that do not conflict with Council V4.
Pause affected work when a blocker requires the owner's judgement or decision.

Scope: Features outside the Council workstream.

## Proposed features

### 1. Research workbench

Create a research question, collect selected sources, annotate passages and compare methods, findings and limitations. Link each evidence-backed claim to its supporting passage so investigations are easy to resume and verify.

Suggested scope:

- A workspace for a research question and its selected sources.
- Passage annotations and source-linked notes.
- A comparison view for methods, findings and limitations.
- Clear separation between source evidence and the assistant's interpretation.

This would support literature reviews, applied AI study and technical investigations while building on existing projects, knowledge ingestion and citations.

### 2. Active study mode

Turn selected knowledge pages into questions, worked exercises and "explain it in your own words" sessions. Track mistakes and schedule revision using editable, source-linked answers.

Suggested scope:

- Study sessions grounded in pages chosen by the user.
- Questions, exercises and explanation practice with feedback.
- Mistake tracking and a manageable daily review limit.
- Editable answers with links to the source material.
- Evaluation of an established spaced-repetition scheduler such as FSRS.

This would turn the growing knowledge base into regular practice for AI study and certification preparation.

### 3. Model health and Free only mode

Show whether configured models are working and enforce an explicit free-only preference across model selection and fallback paths.

Suggested scope:

- Last successful request, response time and capability check results.
- Separate statuses for authentication failures, rate limits, temporary failures and confirmed retirement.
- A persisted Free only setting covering interactive chat, workers and fallbacks. Scheduled generation remains paid, as decided on 28/09/2026.
- Explicit handling when no eligible model is available.

This addresses the recent model availability problems. Free only must cover execution as well as the model picker. Both enforcement and passive model-health reporting are implemented in the V6 worktree. Live provider availability is not inferred from fixture results.

### 4. Capture inbox and offline reading

Save a link, PDF or selected passage into an inbox, review its destination before ingestion, and keep selected documents available for offline reading.

Suggested scope:

- An inbox for captured material awaiting review.
- Destination review before adding material to the knowledge base.
- Explicit downloads of selected documents for offline reading.
- Download status, last-synchronised information and queued notes for synchronisation.

This would make collecting and reading useful material more convenient on a phone. It should extend the existing import and PWA foundations.

### 5. Knowledge revision history

Compare document versions, inspect changed passages and restore earlier content after previewing the result.

Suggested scope:

- Document-level revision browsing.
- A comparison view highlighting changed passages.
- A preview before restoring content.
- Restoration recorded as a new revision, preserving the intervening history.

Git history and lifecycle events already provide a foundation. The current lifecycle Restore action reactivates archived content; this proposal adds historical content comparison and recovery.

### 6. Conversation branching

Fork a conversation from any message, try another approach or model, and compare the resulting branches without losing the original discussion.

Suggested scope:

- A branch action at a selected conversation message.
- Preservation of the original conversation and its later messages.
- Alternative prompts or model choices within a branch.
- Clear navigation and comparison between related branches.

This would support debugging, comparing explanations and exploring research alternatives, building on existing reply, retry and resume actions.

### 7. Chat streaming and context efficiency

Reduce repeated processing and improve response latency while preserving conversation continuity, tool use and source grounding.

The source audit on 23/09/2026 found that each message opens a fresh streaming request and reconstructs conversation context from saved history. Streaming and separate requests already coexist; a persistent connection is not required for provider prompt caching. The app does not explicitly manage or measure that cache, so actual cache hits remain unverified.

Suggested scope:

- **Saved incremental summaries:** persist a conversation summary and the message boundary it covers. Update it as new history accumulates instead of summarising the older portion again on every turn. Account for edits, deletions and conversation branches without losing unsummarised messages.
- **Stable prompt prefixes:** place reusable instructions and stable context before changing timestamps, retrieved evidence and the current message. Respect provider-specific cache behaviour and keep project and conversation context isolated.
- **Cache-usage reporting:** capture streamed usage metadata where supported, including input, output and cached input tokens. Measure provider call counts, time to first answer text and total response time. Show unavailable measurements as unknown rather than zero.
- **A more efficient Gemini generation flow:** avoid routinely generating an initial answer and then replacing it with a second grounded answer when no tool is used. Preserve the required tool and search capabilities, citations, cancellation and continuation behaviour. Stream final answers after tool execution where supported.

Baseline findings from 23/09/2026, addressed by the local implementation below:

- The context builder fetches up to 20 messages. Above 8 messages, it generates a fresh summary of the older portion and retains the latest 5 verbatim.
- The ordinary Gemini chat path first makes a non-streaming tool-capable call. If no tool is used, it attempts a second streamed search/maps generation; tool-based answers currently arrive as one completed chunk.
- The compatible-provider stream parser discards usage metadata, preventing reliable reporting of token consumption and cache reuse.

Verification should compare the existing and revised flows on short chats, long conversations, tool calls, grounded searches and interrupted replies. Check continuity across reloads and branches, measure latency and request counts, and validate cached-token reporting against provider responses. Distinguish local test results from live cache hits; do not promise cache savings before measuring them.

### 8. Data-handling rules and provider trail

Decide where each kind of data may go, and show where each reply's data actually went.

Suggested scope:

- Named data classes for model calls, such as personal, unattended, knowledge and public search.
- Allowed routes for each class: paid with zero retention arranged, paid, or free.
- The Free only setting and the rule keeping scheduled tasks on the paid key, expressed as rules within this policy.
- A record on each reply of the services that received its content, including the chat model, embeddings, search and grounding.
- A clear failure when no allowed route is available, rather than a silent fallback.

Free only and data retention pull in different directions: free routes may train on prompts, while scheduled tasks now stay on the paid key. A single switch cannot express both. Recording the model on each reply also supplies the per-message model information that conversation branching and model health need.

### 9. Approval for unattended actions

Hold outward-facing actions from scheduled tasks until the user approves them.

Suggested scope:

- A queue of pending actions, such as sending email, changing calendar events and deleting knowledge pages.
- One-tap approval or rejection from chat, web push or Telegram, showing the task, the proposed action and the content that prompted it.
- Expiry for unanswered requests, with the task result recording what was skipped.
- Read-only tools continuing without approval.

At the proposal baseline, scheduled tasks ran with the full tool set while reading untrusted email and web content, without action review. The Telegram inline buttons used for initiative feedback provide a starting point.

### 10. Scheduled tasks page

Manage scheduled tasks without going through chat.

Suggested scope:

- A list of tasks with their schedule, channel, next run, last run and last result.
- Pause, resume, run now, edit and delete actions.
- Each task's model route and any recorded errors.

At the proposal baseline, scheduled tasks were created and managed only through chat. A page becomes more useful as recurring tasks are added, and it gives the approvals in feature 9 and the routing in feature 8 a visible home.

### 11. Knowledge-only answers

Answer questions only from the knowledge base, with sources, and say so when the evidence is too thin.

Suggested scope:

- A chat toggle or command that restricts answers to retrieved knowledge.
- Citations to the supporting pages and headings.
- Abstention below a support threshold, showing the closest evidence found.
- Reuse of the existing Knowledge recall and grounded-answer logic.

This suits study and certification preparation, where an unsupported answer is costly. The Knowledge page already provides grounded recall with abstention, so this is a small addition.

### 12. Typed decisions with Jev

Use Jev, TypeSafe AI's decision model, for yes/no, choice and score decisions that currently use a full Gemini call.

Jev answers typed questions about supplied text or JSON: the probability of yes, a choice among defined options with a probability for each, or a score on an ordered scale. It does not write prose. Vercel AI Gateway offers it as `typesafe-ai/jev` through a plain HTTP API, at $0.042 per million input tokens with free output.

Suggested scope:

- A small shared decision client with a confidence threshold, falling back to the current Gemini call when Jev is unsure or unavailable.
- The chat-or-agent decision first, run in shadow mode beside the current Gemini classifier, and switched over only if the two agree closely on real messages.
- Later candidates: skipping fact extraction on turns with nothing to remember, deciding whether a reply needs live web search before grounding it, marking explanation answers in active study mode, suggesting capture inbox destinations and deciding when knowledge-only answers should abstain.
- No authority over outward actions: it may rank or annotate the approval requests in feature 9, but never approve them.
- A decision log with each answer, its probability and any fallback, so accuracy can be checked against outcomes.

Before personal messages are sent to it:

- Decide whether to move to Vercel Pro. Vercel's gateway keeps no prompts, and both Jev providers are on its zero-retention list, but only Pro and Enterprise plans can enforce zero data retention on each request.
- Buy AI Gateway credits. Vercel's free Jev promotion ended on 25/09/2026, and buying credits ends the gateway's monthly free credit.

Only vendor accuracy figures exist so far, such as 67.8% agreement on TypeSafe's own benchmark, and language support is undocumented, so the shadow comparison decides whether it is adopted. At about 1,000 tokens per decision, 100 decisions a day would cost roughly 13 cents a month.

The expected benefits are a faster first reply, fewer Gemini calls per turn and, if grounding becomes conditional, less exposure to Google's 30-day grounding retention.

## Council V4 compatibility and implementation boundaries

- Keep Council contracts, principal scopes, host lifecycle, lease fencing, immutable evidence and
  the V4 phase gates unchanged. The existing uncommitted Council/Tauri work remains separate.
- Research, study, capture/offline reading, revision history, branching, knowledge-only chat,
  scheduled-task management and assistant usage measurements are independent feature areas.
- Apply future routing and approval policies only within assistant calls. Council's moderator and
  owner channel share the existing Gemini client, so do not globally reroute that client.
- Scheduled-action approval must not grant or replace authority for `council_*` operations.
- Enforce the owner decisions recorded below for interactive Free only. Keep unattended and other data-policy work within its separately approved routes. Paid chat routing does not cover embeddings or imply zero retention.
- Keep Jev inactive until the owner settles its plan, credits and retention requirements. Do not send
  personal messages to it as part of a test or shadow run before those decisions.

Knowledge-only chat, assistant usage measurement and interactive Free only enforcement form the first implementation batch. Preserve the broader recommended sequence below as a priority guide, subject to these gates.

## Implementation status, 28/09/2026

UI refinement is implemented locally: shared Library-style workspaces, desktop/mobile layouts, three mode switches in Generation settings, guarded drafts and saves, stable Dashboard panels, accessible controls and corrected Cosmos/Council reader behaviour. Two independent assessment passes drove the corrections. See `V6_IMPLEMENTATION_HANDOFF.md` for the UI scope and verification evidence. The work remains uncommitted; Council is still deferred.

Implementation is in the isolated `codex/assistant-v6-foundations` worktree. Council remains deferred. These changes are uncommitted and have not been deployed or applied to the hosted database.

| Feature | Local implementation | Activation or remaining gate |
| --- | --- | --- |
| 1. Research workbench | Questions, scoped source revisions, exact passage evidence, annotations, claims, interpretation, comparison and conflict recovery | Apply research migration; verify with the authenticated hosted Library |
| 2. Active study | Editable source-linked recall, exercise and explanation cards; learner self-assessment; FSRS; mistakes; daily limits; replay-safe reviews | Apply study migration. No automated correctness grading or Jev calls |
| 3. Model health and Free only | Passive request observations, history and failure classes; persisted interactive policy covering helpers and fallbacks | Apply model-health migration. Live availability remains unverified |
| 4. Capture and offline | Link, passage and original-PDF inbox; destination preview and durable reservation; explicit device downloads and append-only queued notes | Apply capture migration. PDF text extraction/OCR is not included; reviewed notes are indexed |
| 5. Knowledge revisions | Immutable revision comparison and evidence; previewed restoration as a new Git commit; stale-head and dirty-draft handling | Uses the configured vault. Real restore/indexing was not exercised |
| 6. Conversation branches | Atomic selected-message prefix, related navigation and comparison, preserved original, safe retry and strict resume scope | Apply branches migration |
| 7. Context and streaming | Revision-fenced incremental summaries, stable prompt ordering, direct Gemini streaming, usage/cache measurements and persisted reply trail | Apply context and reply-trace migrations. Actual provider cache hits remain unverified; legacy ownership repair needs a decision |
| 8. Data handling | Existing-provider class rules, Free only and paid generation rules, per-call recipient trail with unverified retention clearly labelled | Enforceable zero-retention arrangements are not configured or claimed. Scheduled embeddings keep the configured shared partition |
| 9. Unattended approvals | Immutable proposed action/source context, owner-session approve/reject, expiry, one-use execution and explicit unknown outcomes | Apply scheduled-actions migration. Council actions remain denied; real external delivery was not tested |
| 10. Scheduled tasks | CRUD, pause/resume/run now, schedule/timezone validation, paid route, run history and approvals | Same migration. Expired runs cannot start delivery or overwrite newer results |
| 11. Knowledge-only chat | Saved excerpts or explicit abstention; source links; strict project/index scope; queue/retry/cancellation support | Existing knowledge index required |
| 12. Jev | Disabled client and strict typed parsing with mocked uncertainty/timeout cases | Remains inactive pending owner decisions about credits, plan and retention; no shadow or live calls |

Final local verification: 49 regression suites, in-memory PostgreSQL, full typecheck, source lint, production build and desktop/mobile synthetic browser checks passed. Hosted services and remote CI remain unverified.

See [V6_IMPLEMENTATION_HANDOFF.md](V6_IMPLEMENTATION_HANDOFF.md) for database activation, verification and limits. New interactive pages are `/research`, `/study`, `/capture`, `/tasks` and `/conversations/compare`; Library and Dashboard navigation link to them.

The original reviewed code and scope remain in baseline commit `98cec3982bbb9cbe10319ebf559cd0aecfd2854a`. Preserve the separate uncommitted Council/Tauri changes in the primary checkout. Do not commit, push, apply hosted SQL or activate Jev without the corresponding owner instruction.

Owner decisions for Free only:

- Apply it to interactive chat, including helper calls and fallbacks. Scheduled generation retains its existing paid-only rule.
- The configured Gemini Free, NVIDIA NIM, OpenRouter, Kilo and OpenCode Zen providers may receive personal and saved-knowledge text for interactive requests. Eligibility and availability still apply.
- This does not authorise a new provider, a per-request embedding migration, activation of Jev, or changes to Council V4.

## Recommended delivery sequence

1. **Model health and Free only mode:** a smaller first improvement addressing the recent availability and model-selection problems.
2. **Chat streaming and context efficiency:** establish usage measurements, then improve summary reuse, prompt structure and Gemini generation before adding heavier research workflows.
3. **Research workbench:** the strongest larger addition for research and study. Knowledge revision history is a useful supporting feature to consider alongside it.
4. **Active study mode:** turn collected and reviewed knowledge into sustained practice.

This was the initial priority recommendation. The owner subsequently authorised the whole compatible plan; capture, offline reading and branching are now included in the implementation table above.

Features 8 to 12 were added on 27/09/2026. Features 8 and 9 build on the same model-routing code as Free only mode, so they fit alongside step 1. Feature 10 is small and pairs with feature 9. Feature 11 pairs with the research workbench. Feature 12 begins with step 2, once the Vercel plan and credit questions are settled.

## Existing foundations to extend

The app already has reminders, daily planning, grounded recall, projects, knowledge maintenance, and import/export workflows. The proposed features should extend these capabilities rather than introduce parallel versions of them. Council development remains a separate workstream.

## References

- [Zotero PDF reader and annotation workflows](https://www.zotero.org/support/pdf_reader): a reference for linking research notes back to their source passages.
- [Anki FSRS documentation](https://docs.ankiweb.net/deck-options.html#fsrs): a reference when evaluating spaced-repetition scheduling for active study.
- [Gemini context caching documentation](https://ai.google.dev/gemini-api/docs/caching): a reference for provider cache behaviour and measuring reuse independently of response streaming.
- [Gemini API zero data retention](https://ai.google.dev/gemini-api/docs/zdr): a reference for feature 8, covering what the paid key retains and which features, such as grounding, keep data regardless.
- [Classify, route and score with Jev](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk): Vercel's guide to Jev's question types, answer shapes and example uses, for feature 12.
- [TypeSafe API with AI Gateway](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe): the HTTP endpoint, authentication and evaluation fallbacks for Jev.
- [AI Gateway zero data retention](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr): per-request enforcement, plan requirements and the providers covered.
