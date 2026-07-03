// Slash commands for the web UI. The input drop-up lists this registry;
// ragChat expands a matching command into the prompt sent to the model.

export interface SlashCommand {
    id: string;
    usage: string;
    description: string;
    /** Force the agent loop instead of the single-pass chat path. */
    agent?: boolean;
    /** Builds the prompt from the args typed after the command. */
    build: (args: string) => string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
    {
        id: "draft_email_reply",
        usage: "/draft_email_reply [topic]",
        description: "Draft a Gmail reply to the latest email, or the one matching a topic",
        build: (args) =>
            args
                ? `Find the email in my inbox about "${args}", read it, and draft a reply in Gmail. Show me the draft text.`
                : "Check my unread emails, pick the most recent one that needs a reply, read it, and draft a reply in Gmail. Show me the draft text.",
    },
    {
        id: "check_emails",
        usage: "/check_emails [filter]",
        description: "Summarize unread emails and what needs attention",
        build: (args) =>
            `Check my unread emails${args ? ` matching "${args}"` : ""} and give me a short summary of what needs attention.`,
    },
    {
        id: "triage_emails",
        usage: "/triage_emails",
        description: "Process the inbox: categorize, draft replies, extract tasks",
        agent: true,
        build: () =>
            "Triage my inbox (follow the email-triage skill): categorize my unread emails, draft replies for the ones that need answering, add any implied tasks to my to-do list, and report what you did.",
    },
    {
        id: "agenda",
        usage: "/agenda [period]",
        description: "Upcoming calendar events plus pending to-dos",
        build: (args) =>
            `List my calendar events for ${args || "the next 7 days"} and my pending to-dos, then give me a brief agenda.`,
    },
    {
        id: "plan_day",
        usage: "/plan_day",
        description: "Prioritized plan for today from calendar, tasks and inbox",
        agent: true,
        build: () =>
            "Plan my day (follow the plan-my-day skill): pull today's calendar, my pending tasks and unread emails, then give me a prioritized plan with a top-3 focus list.",
    },
    {
        id: "schedule",
        usage: "/schedule <event, date & time>",
        description: "Add an event to the calendar",
        build: (args) =>
            args ? `Add this to my calendar: ${args}` : "I want to schedule a calendar event — ask me what and when.",
    },
    {
        id: "todo",
        usage: "/todo [task]",
        description: "Add a task to the to-do list, or list pending tasks",
        build: (args) => (args ? `Add this to my to-do list: ${args}` : "Show me my pending to-dos."),
    },
    {
        id: "note",
        usage: "/note <content>",
        description: "Save a note to memory",
        build: (args) => (args ? `Save this note for me: ${args}` : "I want to save a note — ask me what to remember."),
    },
    {
        id: "research",
        usage: "/research <topic>",
        description: "Web research with a concise, sourced summary",
        agent: true,
        build: (args) => `Research this topic on the web and give me a concise, well-sourced summary: ${args || "(ask me for the topic first)"}`,
    },
    {
        id: "report",
        usage: "/report <topic>",
        description: "Research a topic and deliver a PDF report",
        agent: true,
        build: (args) => `Create a well-structured PDF report about: ${args || "(ask me for the topic first)"}`,
    },
    {
        id: "compare",
        usage: "/compare <options>",
        description: "Researched comparison with a clear recommendation",
        agent: true,
        build: (args) =>
            `Compare these options for me (follow the compare-options skill) and give me one clear recommendation: ${args || "(ask me what to compare first)"}`,
    },
    {
        id: "explain",
        usage: "/explain <concept>",
        description: "Learn a concept: intuition, mechanics, misconceptions",
        agent: true,
        build: (args) =>
            `Explain this so it sticks (follow the explain-concept skill; check the vault first): ${args || "(ask me what to explain first)"}`,
    },
    {
        id: "code",
        usage: "/code <what to build>",
        description: "Write complete, runnable code as downloadable file(s)",
        agent: true,
        build: (args) =>
            `Write complete, runnable code (follow the write-code skill) for: ${args || "(ask me what to build first)"}`,
    },
    {
        id: "review_code",
        usage: "/review_code <code or context>",
        description: "Rigorous code review: bugs, security, performance",
        agent: true,
        build: (args) =>
            `Review this code rigorously (follow the code-review skill) — bugs first, then security, performance and style:\n${args || "(the code is in the attached file or previous message)"}`,
    },
    {
        id: "debug",
        usage: "/debug <error or symptom>",
        description: "Root-cause an error and give the minimal fix",
        agent: true,
        build: (args) =>
            `Debug this issue (follow the debug-issue skill) — find the root cause and give the minimal correct fix:\n${args || "(the error is in the attached file or previous message)"}`,
    },
    {
        id: "refactor",
        usage: "/refactor <code>",
        description: "Clean up code without changing behavior",
        agent: true,
        build: (args) =>
            `Refactor this code without changing its behavior (follow the refactor-code skill):\n${args || "(the code is in the attached file or previous message)"}`,
    },
    {
        id: "tests",
        usage: "/tests <code>",
        description: "Write a runnable test suite for provided code",
        agent: true,
        build: (args) =>
            `Write a complete, runnable test suite (follow the write-tests skill) for:\n${args || "(the code is in the attached file or previous message)"}`,
    },
    {
        id: "plan",
        usage: "/plan <feature or project>",
        description: "Staged implementation plan as a Markdown doc",
        agent: true,
        build: (args) =>
            `Create a staged implementation plan (follow the plan-feature skill) for: ${args || "(ask me what to plan first)"}`,
    },
    {
        id: "vault_save",
        usage: "/vault_save <topic or material>",
        description: "Research and save to the second-brain vault",
        agent: true,
        build: (args) => `Research the following and save it to the second-brain vault as proper wiki pages: ${args || "(ask me what to save first)"}`,
    },
    {
        id: "vault_lint",
        usage: "/vault_lint [auto]",
        description: "Health-check the second-brain vault",
        build: (args) =>
            /^auto$/i.test(args.trim())
                ? "Run a vault lint in auto mode, then report what was fixed and any remaining warnings."
                : "Run a vault lint in suggest mode and report what it finds.",
    },
];

const COMMAND_RE = /^\/([a-z0-9_-]+)\s*([\s\S]*)$/i;

export interface ExpandedCommand {
    command: SlashCommand;
    prompt: string;
    agent: boolean;
}

export function expandSlashCommand(message: string): ExpandedCommand | null {
    const m = message.trim().match(COMMAND_RE);
    if (!m) return null;
    const command = SLASH_COMMANDS.find((c) => c.id === m[1].toLowerCase());
    if (!command) return null;
    return { command, prompt: command.build(m[2].trim()), agent: !!command.agent };
}

/** Commands matching a partially typed first token, e.g. "/dra" or "/". */
export function matchSlashCommands(input: string): SlashCommand[] {
    if (!input.startsWith("/") || /\s/.test(input)) return [];
    const token = input.slice(1).toLowerCase();
    // An exactly-typed id ranks first, e.g. "/plan" ahead of "/plan_day".
    return SLASH_COMMANDS
        .filter((c) => c.id.startsWith(token))
        .sort((a, b) => (a.id === token ? -1 : b.id === token ? 1 : 0));
}
