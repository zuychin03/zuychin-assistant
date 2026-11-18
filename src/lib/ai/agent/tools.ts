import type { McpTool } from "@/lib/ai/mcp-service";
import { PURPOSE_TAGS } from "@/lib/ai/models/tags";

export const AGENT_TOOLS: McpTool[] = [
    {
        name: "update_plan",
        description: "Record or update your step-by-step plan for the task. Call this FIRST with your planned steps, then call it again to mark steps in_progress/done as you go. Keep it short (2–6 steps). These steps are shown to the user as a live progress tracker.",
        parameters: {
            steps: {
                type: "array",
                description: "The ordered list of steps.",
                required: true,
                items: {
                    type: "object",
                    description: "A single plan step.",
                    properties: {
                        title: { type: "string", description: "Short description of the step.", required: true },
                        status: { type: "string", description: "Current status.", required: true, enum: ["pending", "in_progress", "done"] },
                    },
                },
            },
        },
    },
    {
        name: "run_subagents",
        description: "Delegate independent subtasks to parallel worker agents to save time. Use when the task has 2+ independent parts (e.g. research several subtopics at once). Workers run on fast free models by default; set purpose on each task to get the best measured model for that kind of work. Each result is headed with a worker id (w1, w2...) and its model, for rate_workers. Workers gather information and return findings as text - they do NOT create files; you synthesize their results and author the deliverables yourself. Do NOT use this for a single simple step - just do it yourself.",
        parameters: {
            tasks: {
                type: "array",
                description: "Independent subtasks to run in parallel (a small handful at most).",
                required: true,
                items: {
                    type: "object",
                    description: "One subtask for one worker.",
                    properties: {
                        objective: { type: "string", description: "A clear, self-contained instruction for the worker.", required: true },
                        purpose: { type: "string", enum: [...PURPOSE_TAGS], description: "What kind of work this is. The app picks the best measured free model with that purpose tag. Omit for the default worker order.", required: false },
                        needs_tools: { type: "boolean", description: "Whether the subtask needs tool calls (web search, email, calendar, vault…). Set false for pure writing, summarising or reformatting of material already in the objective; models without tool calls can then take it. Default true.", required: false },
                        complexity: { type: "string", enum: ["simple", "complex"], description: "How demanding the subtask is. 'complex' = multi-step reasoning, synthesis across many sources, or tricky analysis; 'simple' (default) = lookups, summaries, straightforward drafting. Only affects which paid fallback runs if all free models fail - free fast models are always tried first.", required: false },
                        model: { type: "string", description: "Optional model: a provider::model key from list_models, or a name such as 'nemotron-3.5-lightning'. Tried first, then the purpose picks. Paid models are used only when this run's orchestrator is on a paid model. Omit to pick automatically.", required: false },
                    },
                },
            },
        },
    },
    {
        name: "use_skill",
        description: "Load a skill playbook - a detailed, proven procedure for a kind of task - before you carry it out. Consult the skill index in your instructions and call this when a skill fits, then follow the returned steps. Cheap to call; prefer using a skill over improvising when one matches.",
        parameters: {
            skill_id: {
                type: "string",
                description: "The id of the skill to load, from the skill index.",
                required: true,
            },
        },
    },
    {
        name: "save_skill",
        description: "Save a reusable skill playbook after completing a NOVEL multi-step procedure worth repeating. It is saved as a DRAFT for the user to review in the admin panel - it is NOT usable until approved. Only propose skills for genuinely repeatable procedures; never for one-offs, trivial tasks, or anything the skill index already covers.",
        parameters: {
            slug: {
                type: "string",
                description: "Short kebab-case id for the skill (e.g. 'summarize-invoices'). Must not collide with existing skills.",
                required: true,
            },
            name: {
                type: "string",
                description: "Human-readable skill name.",
                required: true,
            },
            when_to_use: {
                type: "string",
                description: "One sentence describing when this skill applies, written for the skill index.",
                required: true,
            },
            instructions: {
                type: "string",
                description: "The full step-by-step playbook: numbered steps naming the exact tools to call and the expected deliverable.",
                required: true,
            },
        },
    },
];
