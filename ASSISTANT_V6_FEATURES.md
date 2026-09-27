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
- An app-wide Free only setting covering chat, workers and fallbacks.
- Explicit handling when no eligible model is available.

This addresses the recent model availability problems. At the time of this proposal, the worker pipeline still permits a paid Gemini fallback, so the free-only setting must cover execution as well as the model picker.

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

Current inefficiencies to address:

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

Scheduled tasks currently run with the full tool set while reading untrusted email and web content, and nobody reviews their actions. The Telegram inline buttons used for initiative feedback provide a starting point.

### 10. Scheduled tasks page

Manage scheduled tasks without going through chat.

Suggested scope:

- A list of tasks with their schedule, channel, next run, last run and last result.
- Pause, resume, run now, edit and delete actions.
- Each task's model route and any recorded errors.

Scheduled tasks can currently be created and managed only through chat. A page becomes more useful as recurring tasks are added, and it gives the approvals in feature 9 and the routing in feature 8 a visible home.

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
- Resolve the Free only interaction with paid scheduled tasks and the allowed data/provider matrix
  before enforcing those policies. Paid chat routing does not cover embeddings or imply zero retention.
- Keep Jev inactive until the owner settles its plan, credits and retention requirements. Do not send
  personal messages to it as part of a test or shadow run before those decisions.

Begin with knowledge-only chat and assistant usage measurement while the policy-dependent work is
pending. Preserve the broader recommended sequence below as a priority guide, subject to these gates.

## Recommended delivery sequence

1. **Model health and Free only mode:** a smaller first improvement addressing the recent availability and model-selection problems.
2. **Chat streaming and context efficiency:** establish usage measurements, then improve summary reuse, prompt structure and Gemini generation before adding heavier research workflows.
3. **Research workbench:** the strongest larger addition for research and study. Knowledge revision history is a useful supporting feature to consider alongside it.
4. **Active study mode:** turn collected and reviewed knowledge into sustained practice.

Capture inbox, offline reading and conversation branching remain candidates for subsequent prioritisation. This sequence is a recommendation, not an approved implementation schedule.

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
