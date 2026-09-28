# V6 implementation handoff

Updated: 28/09/2026. Council is deferred by the owner. Continue only compatible assistant work. The latest local evidence and confirmed hosted blocker are recorded in the final follow-up section.

## Checkout and authority

Use `C:/Users/kduy1/.codex/worktrees/assistant-v6-foundations/zuychin-assistant`, branch `codex/assistant-v6-foundations`, based on `98cec3982bbb9cbe10319ebf559cd0aecfd2854a`. The primary checkout contains separate Council/Tauri work. V6 changes are not committed or pushed.

The owner authorised implementing the whole compatible V6 plan, stopping only for material decisions. Interactive Free only may use the existing configured Gemini Free, NVIDIA NIM, OpenRouter, Kilo and OpenCode Zen providers for personal and saved-knowledge text. Scheduled generation remains paid. This does not authorise a hosted migration, additional provider, embedding-partition migration or Jev activation.

## UI refinement and independent assessment, 28/09/2026

The latest owner request was an app-wide UI/UX correction pass, with separate implementation and assessment agents and explicit desktop/mobile coverage. Research, Study, Capture, Tasks and conversation comparison share the Library-style workspace shell. The existing visual identity remains in place.

Agent mode, Free only and Knowledge only now live together in Generation settings. Persistent mode explanations and the Tasks policy annotation were removed. Actionable errors remain visible. Knowledge only hides generation parameters that do not affect retrieval. The popover scrolls within short screens, supports Escape/outside dismissal and restores focus.

Two independent assessors reviewed areas they did not implement. Their concrete findings led to these corrections:

- Study pins answers to the original card/version, blocks stale grading, and preserves edited daily limits/timezones during refresh.
- Capture, Research, Study, Tasks, Library merge and Dashboard editors guard unsaved replacements and departures. Pending saves lock competing edits; failures retain text. Native links into draft-bearing workspaces make browser Back a document departure, using beforeunload without router/history interception. Known PDF downloads do not suppress later warnings. Library document history retains merge drafts.
- Dashboard uses stable CSS columns rather than reparenting panels during measurement. Memory, skill, agent and run errors have actionable feedback. Login, disclosures and dropdowns have keyboard labels/focus handling.
- Library distinguishes loading, failure and empty results, shows import previews in Maintenance, and locks merge preview/apply races. Cosmos controls can open while a document is selected; selecting a section reopens its reader. Council read-only errors are visible and slow transcript polling no longer starves responses. Its monitor uses a native modal dialog. Council backend development remains deferred.
- Mobile controls, long text wrapping, native form colours, focus outlines and reduced-motion behaviour were refined. Active workspace navigation recentres after viewport resizing. Task presets display plain-language recurrence, with exact custom cron preserved.

The ignored port 4176 fixture mounts actual application components with synthetic transport, including Graph, Council and Login. This is not an authenticated production or hosted-service acceptance test. Browser checks covered 1280px desktop, 320/390px mobile and 844x390 landscape, light/dark settings, focus/keyboard controls, dropdown bounds, delayed/failed saves, Study refresh identity/settings, native Back retaining a draft, slow Council loading/monitor dismissal, and Cosmos controls-to-section navigation. The beforeunload attempt retained the current URL and answer; the automation did not expose the browser prompt itself. No real account credentials, external deliveries or hosted writes were exercised.

Screenshots are in `C:/Users/kduy1/.codex/visualizations/2026/09/19/01a0ba2b-4c3a-7d21-b0e2-adcbc7420535/v6-ui/`. The latest build passed with placeholder configuration (`v6-ui-audit-build.log`). All 49 V6 suites passed (`v6-ui-audit-regressions.log`), with additional focused checks after final UI refinements. Full typecheck, lint and diff checks passed. Physical iOS/Android devices, cross-browser acceptance, hosted services and remote CI remain unverified. Do not describe these checks as proof that every design is flawless.

## Database activation

No hosted SQL has been applied. The canonical files below are also appended to `supabase-setup.sql`. For an existing installation, review and apply these V6 files to the intended database, rather than rerunning unrelated Council setup. Take the normal database backup first and use a disposable project for the activation smoke test.

1. `scripts/migrations/v6-conversation-context.sql`
2. `scripts/migrations/v6-reply-trace.sql`
3. `scripts/migrations/v6-model-health.sql`
4. `scripts/migrations/v6-conversation-branches.sql`
5. `scripts/migrations/v6-research-workbench.sql`
6. `scripts/migrations/v6-study.sql`
7. `scripts/migrations/v6-capture-inbox.sql`
8. `scripts/migrations/v6-scheduled-actions.sql`

The new tables and RPCs are service-role only. HTTP handlers bind operations to the authenticated owner; do not add client-side database grants. Missing storage returns explicit setup errors. Chat can fall back to bounded full history when summary storage is missing; it does not bypass conversation ownership.

`scripts/migrations/v6-legacy-conversation-ownership-review.sql` is a separate pending proposal. It is excluded from setup and ends in `ROLLBACK`. It selects only nonempty NULL-owner web chats whose every message belongs to the single profile. Automatic approval review rejected a broader NULL-owner compatibility bypass; strict ownership remains. Do not convert this proposal into an applied repair without the owner's decision.

## Behaviour and boundaries

- Research saves exact UTF-16 passage offsets and hashes against an immutable vault revision. Interpretations are labelled separately. Concurrent edits keep the draft for comparison. Capacity is 500 questions per profile, 500 source snapshots and 2,000 notes per question; new writes are refused at capacity while existing records remain available.
- Study uses `ts-fsrs` 5.4.2 and explicit self-ratings. It does not claim AI grading. Reviews have immutable evidence and replay identities, server-side daily limits and version checks. The current capacity is 500 cards per profile; existing cards remain reviewable/editable at capacity.
- Capture does not fetch a submitted URL automatically or OCR a PDF. The original PDF and reviewed notes are preserved. A capture reserves its destination and content hash before a Git commit; ambiguous retries cannot choose a different path. Indexing failure after a commit is reported as partial completion.
- Offline storage is opt-in for selected documents on a trusted device. It uses profile/epoch-scoped IndexedDB; the service worker caches only the static offline reader, never authenticated HTML or API responses. Notes append to the inbox rather than overwriting a source. Logout and account changes invalidate open private views and retained study drafts.
- Restoring knowledge creates a new commit in the configured vault and requires the previewed head. Git history is not rewritten. Existing sensitivity and lifecycle metadata are preserved.
- Branches copy only the selected prefix and safe presentation metadata. They do not inherit executable Council state or later parent embeddings. Resumed agent runs must have the same owner and conversation.
- Summary reuse is fenced by conversation ownership, message revision and summary generation. Model usage is nullable when missing; a zero or absent cache count is not a measured cache benefit.
- Provider trails cover instrumented assistant model/search calls, with background status and storage failure visible. Standalone speech calls are recorded in model health, separately from a reply trail. Retention is not verified. Paid scheduled generation does not imply paid retrieval embeddings; the existing embedding partition remains in use.
- Scheduled runs claim once, advance schedules atomically, expire safely and fence delivery/final state against a newer run. Mutating tools become immutable approval proposals; Council tools remain denied. Approval is an authenticated owner action. An unknown external result must not be automatically retried. This cannot promise exactly-once behaviour at a third-party service after a network failure.
- Jev has only a disabled client/parser and synthetic tests. There is no activation switch, live HTTP transport or router integration. Owner plan, credits and enforceable-retention decisions must precede personal-message shadow testing.

## Verification commands

From the V6 worktree:

```powershell
npm run v6:test
npm run typecheck
node node_modules/eslint/bin/eslint.js src scripts eslint.config.mjs next.config.ts postcss.config.mjs --no-warn-ignored
npm run build
git diff --check
```

`v6:test` runs mocked production-path suites and in-memory PostgreSQL migrations, without live provider/database requests. PGlite executes actual PostgreSQL DDL/RPCs, checks reapplication, ownership, CAS, replay, expiry and role permissions. It is a single local connection, not hosted Supabase or distributed concurrency evidence.

The UI fixture in `.impeccable/review/v6-chat` bundles actual components with synthetic transport. It is ignored development evidence, not application code. Port 4176 is the synthetic preview. No real model, knowledge commit or message delivery occurs there.

## Recorded verification, 28/09/2026

- The latest `v6:test` command passed all 49 suites, including 17 migration groups and seven research-capacity groups running actual in-memory PostgreSQL.
- Full TypeScript checking, source/script lint, production build and `git diff --check` passed. The production build used placeholder configuration, not live service credentials.
- Actual UI components were inspected at 390 px and 1280 px with synthetic transport. Verified research passage selection/comparison; study review replay across reload, logout cleanup and edit-conflict recovery; revision previews and dirty-draft protection; branch navigation/comparison; task run replay/approval receipts/setup errors; and capture ingestion/download/note sync.
- The static offline reader was reloaded successfully with its local server stopped. A saved document remained readable and a new note was queued without a connection.
- Cross-feature review fixed stale scheduled delivery, ambiguous Telegram retry, capture destination reservation, account-change races, document-scope checks, same-origin mutation checks, branch resume scope and capacity limits.

Ignored logs and reports are in `.superpowers/sdd/2026-09-28-v6-chat-foundations/`, including `v6-all-45.log` and `v6-build-final.log`. Browser evidence is in `.impeccable/review/v6-chat/`. These results are local evidence only.

## Outstanding external checks

After the owner applies migrations in a disposable test project, verify owner login; knowledge-source access; research/study create and conflict recovery; branch creation/reload; scheduled claim/approval expiry; and capture receipt/indexing failure recovery. Use disposable recipients/content before testing delivery. Confirm storage/cookie isolation between accounts and device browsers.

Real provider availability, prompt-cache reuse, Git restoration, embeddings, Telegram/Discord delivery, hosted Supabase, production deployment and remote CI remain unverified. Council V4's disposable-project/CI gate remains deferred and separate.

## Design consistency follow-up, 28/09/2026

Work continued in the existing codex/assistant-v6-foundations worktree, which contains the uncommitted V6 implementation. The earlier main-checkout UI edits were backed up and removed without discarding its unrelated Council work. No commit, push, deployment or hosted migration was performed.

### Changes

- All native select and datalist controls in application TSX now use the shared selectors. Research, Study, Capture, Tasks, Model health and Council retain their existing value, pending-state and draft contracts.
- Dropdowns support keyboard navigation, typeahead, active-descendant ownership, disabled fieldsets and viewport-safe portals, including inside dialogs. Placement measures layout dimensions so entrance scaling cannot push menus off-screen. Selecting the current value does not clear related fields.
- Chat uses anchored model/settings menus, accessible conversation action buttons, width-aware header wrapping, a labelled IME-safe composer and clear Notes loading/failure recovery. Closed drawers are inert; only the active mobile drawer is exposed. Desktop drawer width animations were removed to avoid repeated layout work.
- Library uses its actual available height rather than assuming a fixed header. Filter targets, status labels, singular counts and date display are consistent. Frontend dates now explicitly use Australian formatting while preserving their existing timezone choices.
- Research protects unsaved source labels across question/source/note changes. Security status failures remain visibly unknown, and the sign-in methods show their own pending state with a single field focus ring.
- Council retains existing-key replacement with confirmation, blocks issuance until a valid key list is loaded, preserves retry feedback, and resets panel state when changing councils. This does not advance the deferred Council backend/hosted acceptance work.
- Graph keyboard shortcuts respect focused controls. Timeline, zoom, toast and drawer positioning avoid animation-centering conflicts and control overlap. Portrait and short-landscape targets are 44 px. Labels use measured text bounds, viewport margins, control exclusion areas and hover/selection priority.
- Global semantic status colours, focus visibility and reduced-motion behaviour are consistent with the existing visual system.

### Fresh evidence

- All 53 V6 regression suites passed. New suites cover anchored-menu geometry, Research source-label guards, seat-key loading gates and Graph label geometry. Requests and migration checks use local fixtures/in-memory PostgreSQL.
- Full source/script lint, nonincremental TypeScript checks, the final production build and git diff --check passed. The build used placeholder configuration.
- Browser review used actual components with synthetic transport on port 4176. Fresh checks covered chat menus and mobile drawers; Library filters and viewport height; Research/Study selectors; Capture same-value URL retention; Tasks keyboard selection; Model health filtering; security-status failure; sign-in recovery; Council loading/error/replacement confirmation; and Graph playback, labels, timeline, zoom and dock layout.
- The actual V6 Next.js dev server is running at http://127.0.0.1:3000/ using the existing local development configuration. Read-only browser smoke checks confirmed the V6 Free only and Knowledge only settings and Library workspace navigation. Initial preference, provider, conversation and document reads returned HTTP 200; no chat, delivery or mutation was submitted. The independent fixture preview remains on port 4176.
- Relevant layouts were inspected at 1280 x 900, 320 x 568 and 844 x 390, with light/dark states. The final saved screenshots are v6-library-desktop.png, v6-admin-mobile.png, v6-graph-mobile.png and v6-graph-landscape.png under C:/Users/kduy1/.codex/visualizations/2026/09/28/01a0e72d-9ded-7d01-b2e2-e69f38f761a0/.
- The manual Impeccable detector identified avoidable desktop width transitions, which were removed. Retained warnings concerned intentional typing-status dots and semantic quote/tree/active-heading borders. It is an advisory source scan, not proof of visual perfection.
- Three agents implemented and reviewed separate areas. Independent final screenshot review found no remaining concrete defect in those views and rated their visual quality 8.5/10. A follow-up confirmed that the remaining score was subjective aesthetic judgement, not identified unfinished work. Admin supporting text and Graph label contrast were checked without finding a justified additional change. This is not a perfect-design certification.

The in-app browser stalled on a native Research discard dialog, so cancellation retention there was verified through actual-handler regression tests rather than claimed as a completed browser interaction. A later browser timeout was recovered, and the final Graph layout was inspected afterwards. Physical devices, assistive technology, other browser engines, full authenticated hosted flows, provider delivery and remote CI remain unverified. Earlier external acceptance gates still apply.

## Extended interaction review and typing-style correction, 28/09/2026

The latest local validation supersedes the earlier suite counts: all 58 V6 suites passed, including 17 migration groups in local PGlite. Full source/script lint, nonincremental TypeScript, production build with placeholder configuration and git diff --check passed. No live services were exercised by the regression runner. No commit, push, deployment or hosted migration was performed.

### Additional corrections

- Research preserves quote-only and emptied existing-note drafts and avoids replacing them when reopening the same editor. Study protects reflection-only answers and retains the baseline when regenerating an edited card from a source or template.
- Capture uses a named confirmation for clearing all private offline data, including the consequence for queued notes, Capture drafts and pending Study reviews. Manual clearance validates and persists the captured epoch before purging drafts. Failed or stale manual clears preserve drafts; authentication failures retain immediate privacy invalidation. Failures appear inside the modal and repeated immediate failures remain retryable.
- Shared confirmations have 44 px controls, wrapping actions, visible errors and semantic destructive colours. Destructive-label contrast measured 5.73:1 in light mode and 6.63:1 in dark mode.
- Notifications distinguish browser subscription from confirmed server registration. Remount checks are read-only, require the owner session and same origin, return private/no-store responses, and preserve unknown status on failure. Failed registrations roll back the local subscription when possible; unresolved registration remains visible.
- Dashboard cleanup reconciles stale selections, run refreshes invalidate stale detail responses, and memory/skill edits survive cancelled or failed deletion. Agent revocation requires a named confirmation for either one credential or the agent and all credentials; pending requests lock, failures remain in the dialog and retries preserve setup drafts.
- Library maintenance rejects stale responses. Recall has a 44 px input target. Merge review shows loading, focuses its heading and keeps its Close action within the viewport. Related branches offer retry after a failed load and preserve modified-click navigation.
- Project Instructions retain same-project edits, protect dirty replacement/closure/navigation, and lock during saving. Failed saves keep the editor and text. Stop's accessible name explains queue clearing when messages are queued; cancellation semantics are unchanged.
- Graph shares one synchronous lock across save, delete, unlink, single-link and batch-link operations. Pending actions protect the editing context and conflicting controls. Failed batch targets remain selected for direct retry; only successful targets are removed.
- The owner rejected the white border shown while typing. The global focus rule now suppresses outlines on text-entry inputs and textareas, and the sign-in field wrapper no longer adds a white ring. Existing borders remain. Keyboard focus indicators on buttons, links, dropdowns and non-text inputs remain. This preference takes precedence over the earlier broad focus-ring treatment.

### Evidence by requirement

| Requirement | Current evidence | Remaining limit |
| --- | --- | --- |
| Consistent custom selectors | Source scan found no native select or datalist controls in application TSX. Shared geometry, keyboard, same-value and disabled-state checks passed. | Physical-device and other-engine acceptance remains unverified. |
| Visual and responsive usability | Actual-component fixtures inspected at desktop, narrow mobile and short landscape sizes, including both themes. Mobile modal actions measured 44 px and fit the viewport. | This is a bounded visual review, not a perfect-design certification. |
| Draft and pending protection | Research 17, Study draft 7, workspace recovery 19, Capture confirmation 10, offline privacy 9 and Graph mutation 15 focused cases passed within the full runner. | Native discard dialogue outcomes use actual-handler tests where browser automation could not operate the native prompt reliably. |
| Honest status and recoverable failure | Admin panel state 14 cases passed. Browser checks confirmed visible modal errors, repeated retries, Cancel retention, run refresh details and named agent revocation. | Real push delivery, credential mutation and hardware authentication remain unverified. |
| Typing style correction | Before: focused composer had a white solid outline. After: focused composer, Capture title, Dashboard agent name and sign-in input/wrapper had no outline. A keyboard-focused button retained its solid focus indicator. | No new UI behaviour or storage contract was changed by this CSS correction. |
| Connected V6 functionality | Read-only checks on the actual V6 server at port 3000 confirmed the branch's UI and explicit missing-storage errors. | Research, Study, Capture and scheduled actions cannot complete hosted acceptance until migrations are applied. |

Browser checks used actual components with synthetic transport on port 4176. They confirmed project instructions survive reopening and a delayed failed save, Capture cancellation preserves typed text after repeated failed clear attempts, and both credential/whole-agent revocation retain a named recovery path. Graph conflicting controls and the editor's read-only state were checked during a delayed synthetic save; the draft remained and controls unlocked after failure. No synthetic mutation was forwarded to a real provider, vault or credential endpoint.

The final logs are v6-expanded-regression.log and v6-expanded-build.log under C:/Users/kduy1/.codex/visualizations/2026/09/28/01a0e72d-9ded-7d01-b2e2-e69f38f761a0/. Additional screenshots there are v6-capture-clear-mobile.png, v6-capture-clear-failure-mobile.png, v6-merge-review-mobile.png, v6-agent-revoke-failure-mobile.png, v6-project-instructions-recovery.png, v6-graph-save-recovery.png, v6-textbox-focus-fixed.png and v6-live-storage-blocker.png. The Graph recovery screenshot records the retained draft, not a captured transient error toast.

### Hosted storage status, SQL checks deferred by owner

The actual authenticated localhost server, using the existing development configuration, reported:

- Study: HTTP 503, Study storage is not installed; apply the V6 study migration.
- Research: storage unavailable until its database migration is applied.
- Capture: inbox unavailable; check the capture migration and retry.
- Tasks: approval and run records unavailable; running tasks and approving actions remain blocked pending the scheduled-actions migration.

The owner explicitly requested skipping SQL tests and continuing the remaining UI work on 28/09/2026. SQL validation and hosted migration activation are excluded from the current design pass and are not a blocker for local design verification. The Database activation section lists the eight prepared V6 migrations for future owner-managed activation; no hosted SQL write is authorised. The errors above remain evidence limits for hosted workflows, not newly failed UI checks. Do not apply the separate legacy-ownership proposal. No independent review or local test establishes universal perfection.

## Remaining non-SQL UI acceptance, 28/09/2026

The owner explicitly excluded SQL testing from this continuation. No SQL tests, hosted migrations, external deliveries or real credential mutations were performed. Work remains on codex/assistant-v6-foundations and uncommitted.

### Final corrections

- Home model menus restore their trigger before native Tab or Shift+Tab traversal. Mobile drawer focus boundaries continue to work when a conversation menu closes.
- Shared confirmation and model-details dialogs explicitly wrap keyboard focus in both directions. A buttonless pending view retains focus in its dialog; Escape and source-focus restoration remain intact.
- Home and Council programmatic scrolling use an immediate transition when reduced motion is requested.
- Today titles and dates, note descriptions and Graph page titles wrap long unbroken text within narrow containers.
- Historical Markdown previews render wiki references as text when navigation is unavailable. Existing Library navigation callbacks remain interactive.

### Verification and limits

- Full source/script ESLint, nonincremental TypeScript and the production build with placeholder configuration passed. git diff --check passed. Nine focused non-SQL suites passed: shared-control-accessibility (17 cases), markdown-reader (7), capture-clear-confirmation (10), chat-ux, workspace-recovery, document-continuity, model-picker, anchored-menu and tasks-ui. The full SQL-containing runner was not rerun.
- Actual-component browser checks confirmed forward and reverse model-menu Tab order, confirmation-dialog focus wrapping and Escape restoration, model-details focus containment, workspace skip navigation, revision-conflict recovery and expired-approval refresh. The historical wiki reference is now noninteractive in its preview.
- At 320 px, long Today and Graph titles remained within the viewport (document scrollWidth 320 px). Graph heading scrollWidth matched its 206 px available width and Close remained clear. Independent screenshot review found no actionable horizontal overflow or control collision in these stress views. The focused composer still had no outline or box shadow.
- Independent source review found no remaining actionable defect in this batch. This bounded result does not certify universal perfection. Only the in-app browser was connected; physical devices, other engines, assistive technology, hardware authentication and actual external-service delivery remain unverified. Hosted storage acceptance stays deferred under the owner's SQL waiver rather than blocking this local pass.
- Evidence is saved in v6-ui-final-checks.log, v6-ui-final-build.log, v6-long-content-mobile.png, v6-graph-long-title-mobile.png and v6-final-controls-desktop.png under C:/Users/kduy1/.codex/visualizations/2026/09/28/01a0e72d-9ded-7d01-b2e2-e69f38f761a0/. The existing preview at port 4176 was refreshed only after confirming it had no typed text or open dialog; temporary review tabs were closed and the viewport override was reset.

## Final design acceptance, 28/09/2026

The final independent design assessment is 10/10 for the existing app's visual and interaction refinement across the reviewed route catalogue. The reviewer confirmed the final populated Chat screenshot and identified no remaining evidence-backed design deduction. This is a subjective design rating, not a certification of every device, assistive technology or live integration.

### Completion audit against the requested work

| Requirement | Authoritative evidence | Result |
| --- | --- | --- |
| Work from the V6 implementation | Git root C:/Users/kduy1/.codex/worktrees/assistant-v6-foundations/zuychin-assistant; branch codex/assistant-v6-foundations, base 98cec3982bbb9cbe10319ebf559cd0aecfd2854a. | Verified; existing work preserved. |
| Review the entire app design | Route inventory includes Chat, Library, Graph, Research, Study, Capture, Tasks, Dashboard, Council, comparison, Login and Security. Standalone offline reading and unknown-route recovery were included. Evidence per surface is below. | All current UI surfaces accounted for. |
| Replace inconsistent dropdowns | Fresh source scan found no native select or datalist elements in application TSX or public HTML. Shared selectors have keyboard, placement, selection and disabled-state coverage. | Complete. |
| Use design skills and subagents | Impeccable criteria informed the review. Three agents separately implemented and reviewed controls, Home/Graph and administrative/recovery work. | Complete. |
| Resolve visual, usability and functional UI defects | All identified findings were corrected and checked through actual components, browser interactions and focused production-handler tests. Independent final assessment found no remaining justified design deductions. | Accepted at 10/10. |
| Remove white outlines while typing | Main and standalone offline text fields retain their normal border without a new typing outline. Button and other keyboard focus indicators remain. | Rendered verification passed. |
| Skip SQL testing and continue | No SQL validation or hosted migration was run in either continuation. Existing migration evidence is historical only. | Owner's exclusion respected. |

### Final recovery and clarity corrections

- Failed model discovery now presents Retry models and preserves known selections. It no longer claims no free provider is configured when discovery failed. The first-503 synthetic scenario recovered to a usable model picker with no remaining alert.
- Capture separates unknown/loading, failed and confirmed-empty inbox states. Failed reload retains an alert instead of No captures yet, and unrelated offline actions cannot erase inbox failure.
- Offline reading follows the saved app theme with a system fallback, preserves forced-colour/button focus, supports retry after local-library read failure without losing a draft, and uses correct document/note plurals. The shell cache version was advanced so installed offline copies receive the changed assets.
- Dashboard fragment links wait for content, focus the intended section and scroll to it. Refresh does not move the reading position. The Security target moved from more than 4300 px below the viewport to its top.
- Project Instructions has visible Save instructions and Cancel actions with 44 px heights. Reply and queued-message actions have 44 px targets and adequate unattenuated icon colour. Graph shows DD/MM/YYYY dates. Council provides a direct View transcript link that focuses its visible heading.
- A themed Page not found screen offers Return to chat and Open Library. The actual Next.js app rendered the recovery page and its Chat link successfully reached the composer.

### Route coverage

| Surface | Rendered and functional evidence |
| --- | --- |
| Chat | Empty and populated desktop/mobile views, citations, queued/retry guards, model failure/retry, custom menu traversal, drawers, labelled project instructions, reply targets and typing style. |
| Library and Graph | Reader/navigation, filters, merge recovery, revisions, source references, retained edits, mutation locks, partial-link retry, long titles, graph controls and date formatting. |
| Research and Study | Populated desktop/mobile source/review views; custom selectors; source, note, reflection and settings draft guards; pending locks and failure recovery. |
| Capture and offline reader | Failed and loaded inbox states, clear confirmation, saved synthetic document, light/dark offline themes, focus styling, read-failure retry and privacy fencing. |
| Tasks | Populated list and editor layouts, keyboard selectors, stale approval recovery, expired-state controls and scheduling UI tests. |
| Dashboard and Security | Populated panels and recovery states, named confirmation flows, status accuracy, async Security fragment focus and refresh-position preservation. Security's redirect target was verified in source. |
| Council | Populated transcript and control layouts, guest-seat selectors, status/recovery states, reduced-motion logic, direct transcript focus and preserved existing workflow. Deferred backend work remains separate. |
| Branch comparison | Created a synthetic conversation and branch, inspected shared-message disclosure, checked 44 px continuation links and returned to the correct chat. Invalid and unavailable comparison states remained within 320 px and exposed recovery. |
| Login and unknown routes | Prior sign-in recovery and typing-style checks remain applicable; actual-app unknown-route rendering and successful recovery navigation were newly verified. |

### Final checks and evidence limits

Full source/script/public-JS ESLint, nonincremental TypeScript, final production build with placeholder configuration and git diff --check passed. Nine focused non-SQL suites passed: workspace-recovery (34 cases), graph-mutation-state (16), offline-reader-ui, offline-privacy, offline-shell, capture-clear-confirmation, chat-ux, chat-free-selection and shared-control-accessibility. After the final offline wording change, the reader suite was rerun successfully, including four existing handler groups and three added cases. The production build includes that final change.

Logs: v6-route-review-checks.log and v6-route-review-build.log. Ordinary viewport evidence includes v6-chat-controls-mobile-final.png, v6-instructions-controls-mobile.png, v6-council-transcript-mobile.png, v6-graph-date-mobile.png, v6-model-load-recovery-mobile.png, v6-security-link-mobile.png, v6-offline-reader-mobile.png, v6-offline-library-mobile-final.png and v6-not-found-mobile.png in the existing visualisation directory. Some v6-review full-page captures contained stitching artefacts; those were not treated as product defects and ordinary viewport captures resolved the ambiguity.

Functional UI acceptance uses actual components with synthetic transport and focused handler tests, plus read-only checks on the actual Next.js app. SQL-dependent hosted acceptance, real provider/delivery behaviour, passkey/push hardware, other browser engines, physical devices and exhaustive screen-reader compliance remain unverified. The design rating must not be used as evidence that those external checks passed. No commit, push, deployment or hosted mutation was performed. Both localhost previews remain available; temporary review tabs were closed and the viewport override was reset.
