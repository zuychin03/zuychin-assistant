export interface Skill {
    id: string;
    name: string;
    whenToUse: string;
    instructions: string;
}

export const SKILLS: Skill[] = [
    {
        id: "generate-report",
        name: "Generate Report",
        whenToUse: "The user wants a written report, analysis, comparison, or write-up delivered as a document (PDF/DOCX/MD).",
        instructions: `Produce a single, well-structured report document.
1. Pin down the deliverable: topic, angle, and format. Default to PDF unless the user asked for DOCX or Markdown.
2. Gather facts before writing. Use search_web for anything current or factual; if there are 2+ independent research threads, dispatch them with run_subagents and wait for their findings.
3. Structure it: a clear title, a short executive summary / TL;DR up top, body sections with headings, comparison tables where they help, then a decisive recommendation or conclusion, and a Sources list.
4. Write the body in Markdown — use ##/### headings, bullet and numbered lists, tables, and **bold** for key terms — so it renders cleanly in the document.
5. Call create_document exactly ONCE with a clear title and the requested format. Never emit more than one file for a single report.
6. In chat, give a 2–3 sentence takeaway and note that the report is attached. Do not paste the full report into the chat.`,
    },
    {
        id: "write-code",
        name: "Write Code",
        whenToUse: "The user asks you to write a script, function, component, config, or small program to keep.",
        instructions: `Deliver complete, runnable code as downloadable file(s).
1. Determine the language/framework from the request and the user's stack (TypeScript, React/Next.js, SvelteKit, React Native/Expo, Node, SQL). If it's ambiguous, pick the most likely option and state your assumption in one line.
2. Write COMPLETE code — real imports, types, and error handling, no placeholders, no "// ... rest of code" elisions. It should run as-is.
3. Comment non-obvious logic briefly and follow idiomatic style for the language.
4. One file → create_code_file (correct extension + language). Multiple files or a small project → create_code_bundle (a .zip); include a short README and any needed config (package.json, tsconfig, etc.) so it can actually be run.
5. Return the code ONLY as the artifact — do not paste the full source into chat. In chat, summarize what it does and give the install/run commands.`,
    },
    {
        id: "code-review",
        name: "Code Review",
        whenToUse: "The user shares code (pasted or uploaded) and wants a review, critique, or bug hunt.",
        instructions: `Review the code rigorously and report actionable findings.
1. Read the whole thing first and infer its intent before judging it.
2. Evaluate in this order: correctness/bugs, edge cases, security (injection, secret handling, auth, unsafe input), performance, error handling, then readability/style.
3. Order findings by severity — Critical → Major → Minor → Nit. For each: point to the location (file/line or snippet), explain WHY it's a problem, and give a concrete fix with corrected code.
4. Call out what's genuinely done well, too — don't only list problems.
5. For a short review, reply inline in chat. For a large or multi-file review, produce a create_document report. If you rewrote a file wholesale, return it via create_code_file.`,
    },
    {
        id: "debug-issue",
        name: "Debug Issue",
        whenToUse: "The user reports an error, crash, failing test, or unexpected behavior and wants the cause found and fixed.",
        instructions: `Find the root cause, not just the symptom.
1. Restate the symptom precisely: expected vs actual behavior, and when it happens.
2. Read any error message or stack trace closely — identify the exact failing line and the call path that reaches it.
3. Form the most likely hypotheses, ranked. Use search_web for unfamiliar errors, library versions, or recent breaking changes.
4. Pin down the underlying cause and explain WHY it happens — a fix you can't explain is a guess.
5. Give the minimal correct fix with the corrected code. Then flag any other spots with the same root cause, and state how to verify the fix (a command, a test, or the expected new behavior).
6. If the fix spans a meaningful amount of code, return it via create_code_file rather than a large inline paste.`,
    },
    {
        id: "research-summarize",
        name: "Research & Summarize",
        whenToUse: "The user wants a topic researched on the web and summarized concisely with sources (not necessarily a formal document).",
        instructions: `Turn web research into a tight, sourced answer.
1. Break the question into sub-questions. Run independent searches via search_web; when they're independent, dispatch them together with run_subagents.
2. Prefer recent, authoritative sources, and cross-check any contested or fast-moving fact across more than one source.
3. Synthesize — don't just list results. Lead with the direct answer, then the supporting detail, then caveats and open questions.
4. Cite sources: inline where it matters, plus a short Sources list with URLs at the end.
5. Keep it concise and answer in chat by default. Only produce a create_document if the user asks for a file or the result is long and structured enough to warrant one.`,
    },
    {
        id: "second-brain",
        name: "Second Brain (Research & Study)",
        whenToUse: "The user wants a topic researched/studied AND remembered long-term, asks to save an article or notes to the knowledge base, or asks what the vault already knows about something.",
        instructions: `Grow and use the second-brain vault: durable research/study knowledge as interlinked wiki pages. (Personal facts, preferences and reminders belong in save_note, NOT here.)
1. Always check coverage first: vault_search the topic. If pages exist, vault_read the relevant ones and build on them instead of duplicating; vault_read('index.md') shows the full catalogue.
2. To answer a study/research question: read the relevant vault pages and answer from them with page citations (e.g. wiki/concepts/attention.md). Fill gaps with search_web.
3. To add knowledge: gather the substance first (search_web / run_subagents for 2+ independent threads / the user's pasted material), then call vault_ingest with the FULL material in content — it synthesizes the page, auto-links related pages bidirectionally, updates the catalogue, and commits. Never pass a stub.
4. Pick the category: 'sources' for one external article/paper/video, 'concepts' for a durable idea or method, 'entities' for a person/tool/project, 'synthesis' for a cross-source answer to a question. Pass the origin URL/reference as source.
5. One page per distinct topic — a research session with three distinct findings is three vault_ingest calls, not one dump.
6. If you answered a substantial question from multiple sources and the answer is durable, file it back as a 'synthesis' ingest so the vault learns from the question.
7. Use vault_write only to correct or extend a page you have just vault_read, sending the complete updated markdown.
8. If asked to check, clean up, or maintain the vault: vault_lint with mode 'suggest' to report, 'auto' to also fix low-risk link/catalogue issues. Relay its warnings — those need the user's judgement.
9. To remove a redundant page (e.g. the leftover after merging duplicates, and only with the user's go-ahead): vault_delete — it unlinks the page everywhere and updates the catalogue in one commit. NEVER 'mark' a page as deleted by overwriting it with vault_write; that leaves junk in the vault.
10. In chat, summarize what was learned and mention the page path(s) saved.`,
    },
    {
        id: "plan-my-day",
        name: "Plan My Day",
        whenToUse: "The user wants a daily plan, a morning briefing, help prioritizing today, or asks 'what should I do today?'.",
        instructions: `Turn today's calendar, tasks and inbox into one prioritized plan.
1. Gather in parallel: list_calendar_events (next ~24h), manage_todo_list action 'list' (pending tasks), and list_unread_emails. Note the current time with get_current_time.
2. Triage: fixed commitments (events) are anchors; then anything urgent from email or overdue/dated tasks; then the highest-value pending tasks. Flag conflicts or an overloaded day honestly.
3. Produce a compact plan: a timeline around the fixed events, a short "top 3 focus" list, and a "can wait" list. Keep it scannable — no walls of text.
4. If the user commits to new tasks during the conversation, add them with manage_todo_list so they land in the Notes checklist. Do NOT re-add tasks that already exist.
5. End with the single most important thing to do first.`,
    },
    {
        id: "email-triage",
        name: "Email Triage",
        whenToUse: "The user wants their inbox processed: what's urgent, what needs a reply, and drafts prepared — more than a plain unread summary.",
        instructions: `Process the inbox to zero-decision state.
1. list_unread_emails (and list_recent_emails if the user mentions a time span). If it's empty, say so and stop.
2. Categorize each email: URGENT (needs action today), REPLY NEEDED, FYI (read and archive), and NOISE (ignore).
3. For each REPLY NEEDED email the user plausibly wants answered: read_email for full context, then draft_gmail_reply with a concise, appropriate reply. Never send_email unless the user explicitly asked to send.
4. If an email implies a task or deadline, add it via manage_todo_list (with due_date when one is stated) so it shows in the Notes checklist.
5. Report as a short table/list grouped by category: sender, subject, one-line gist, and what you did (drafted / task added / nothing). Lead with the urgent items.`,
    },
    {
        id: "compare-options",
        name: "Compare Options",
        whenToUse: "The user is choosing between products, tools, libraries, services, or approaches and wants a researched comparison with a recommendation.",
        instructions: `Research the options and make a real recommendation.
1. Pin down the options and the criteria that actually matter to THIS user (cost, learning curve, ecosystem, performance, lock-in…). Infer criteria from context; state them explicitly.
2. Research each option with search_web — current pricing, recent releases, known problems. For 3+ options, dispatch run_subagents with one worker per option.
3. Build a comparison table: options as columns, criteria as rows, concrete facts in the cells (numbers, not adjectives).
4. Give ONE clear recommendation for the user's situation and say why, plus the main scenario in which you'd pick the runner-up instead. Never end with "it depends".
5. Answer in chat for quick comparisons; use create_document only if the user asked for a document or there are many options/criteria.`,
    },
    {
        id: "explain-concept",
        name: "Explain a Concept",
        whenToUse: "The user wants to learn, understand, or study a concept, technology, or idea — 'explain X', 'how does X work', 'teach me X'.",
        instructions: `Teach the concept so it sticks, building on what the vault already knows.
1. vault_search the topic first — if the vault has pages on it, build on them and cite the page paths; fill gaps with search_web for anything recent or factual.
2. Explain in layers: one-sentence essence → a concrete everyday analogy → how it actually works (with a small example, code if it's a programming topic) → where it breaks down or gets misused.
3. Calibrate depth to the user's question; they are a developer, so technical precision beats hand-waving, but lead with intuition before formalism.
4. Name the 2–3 most common misconceptions or gotchas about the topic.
5. If the explanation is substantial and durable (not a quick lookup), save it as a 'concepts' page with vault_ingest so the second brain learns it; mention the saved path.`,
    },
    {
        id: "refactor-code",
        name: "Refactor Code",
        whenToUse: "The user shares working code and wants it cleaned up, simplified, modernized, or restructured WITHOUT changing behavior.",
        instructions: `Improve the code while provably preserving behavior.
1. Read the whole input and state in one line what the code does — refactor only what you understand.
2. Identify the improvements worth making: duplication, dead code, misleading names, oversized functions, outdated idioms, missing error handling. Skip cosmetic churn.
3. Preserve behavior exactly: same inputs → same outputs and side effects. If a change WOULD alter behavior (even fixing an apparent bug), do not silently include it — flag it separately as a suggested fix.
4. Keep the user's style and conventions (naming, formatting, framework idioms) rather than imposing your own.
5. Return the refactored code via create_code_file (or create_code_bundle for multiple files). In chat, list each meaningful change and why, plus the separate list of flagged behavior-changing suggestions.`,
    },
    {
        id: "write-tests",
        name: "Write Tests",
        whenToUse: "The user wants unit/integration tests written for code they provide or describe.",
        instructions: `Deliver a runnable test suite, not sample assertions.
1. Identify the language and the test framework from the code or the user's stack (their projects use Vitest/Jest for TS/JS); state your choice in one line if it's ambiguous.
2. Read the code and enumerate what must be covered: the happy path, edge cases (empty/null/boundary values), error paths, and any tricky branch you can see in the logic.
3. Write complete, runnable tests — real imports, correct mocking of external calls (network, DB, time), descriptive test names that read as specifications.
4. Don't test implementation details; test observable behavior, so the tests survive refactors.
5. Return the tests via create_code_file (matching the source filename, e.g. utils.test.ts). In chat, list what's covered, what isn't, and the command to run them.`,
    },
    {
        id: "plan-feature",
        name: "Plan a Feature",
        whenToUse: "The user wants an implementation plan, technical design, or phased roadmap for building a feature or project.",
        instructions: `Produce a concrete, staged implementation plan document.
1. Clarify the goal, the constraints (stack, infra, time, budget), and what already exists — plan changes against the real codebase, not a blank slate.
2. Research the unknowns first with search_web (APIs, libraries, limits, best practices) before committing to an approach; prefer reusing what already exists over adding new infrastructure.
3. Structure the plan as: Context → Architecture overview → Components/changes (named by file, module, function, table) → Rollout phases (each one independently shippable) → Risks & tradeoffs → Verification steps.
4. Be specific and decisive — name the actual files, libraries, and data shapes involved, and make a clear recommendation rather than listing every option.
5. Deliver as ONE Markdown document via create_document (format "md" unless the user asks otherwise) with a clear title. In chat, give a short phase-by-phase overview.`,
    },
];

const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export const SKILL_IDS: string[] = SKILLS.map((s) => s.id);

export function getSkill(id: string): Skill | undefined {
    return SKILL_BY_ID.get(id);
}

export function getSkillInstructions(id: string): string {
    const skill = SKILL_BY_ID.get(id);
    if (!skill) {
        return `No skill named "${id}". Available skills: ${SKILL_IDS.join(", ")}. Proceed without a skill, or pick a valid one.`;
    }
    return `# Skill: ${skill.name}\n\n${skill.instructions}`;
}

export function buildSkillIndex(): string {
    return SKILLS.map((s) => `- ${s.id}: ${s.whenToUse}`).join("\n");
}

// Async variants include approved (active) custom skills from the DB.
// Drafts never surface here — approval in /admin is the guardrail.
export async function buildSkillIndexAsync(): Promise<string> {
    const { getActiveCustomSkills } = await import("@/lib/ai/skills/custom-store");
    const customs = await getActiveCustomSkills();
    const lines = SKILLS.map((s) => `- ${s.id}: ${s.whenToUse}`);
    for (const c of customs) lines.push(`- ${c.slug}: ${c.whenToUse} (custom)`);
    return lines.join("\n");
}

export async function getSkillInstructionsAsync(id: string): Promise<string> {
    const skill = SKILL_BY_ID.get(id);
    if (skill) return `# Skill: ${skill.name}\n\n${skill.instructions}`;

    const { getActiveCustomSkills } = await import("@/lib/ai/skills/custom-store");
    const customs = await getActiveCustomSkills();
    const custom = customs.find((c) => c.slug === id);
    if (custom) return `# Skill: ${custom.name}\n\n${custom.instructions}`;

    const known = [...SKILL_IDS, ...customs.map((c) => c.slug)];
    return `No skill named "${id}". Available skills: ${known.join(", ")}. Proceed without a skill, or pick a valid one.`;
}
