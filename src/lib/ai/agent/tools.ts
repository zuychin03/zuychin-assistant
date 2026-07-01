// Tools available only to the lead agent (not the fast path or workers):
// declaring a plan (drives the live tracker), dispatching parallel workers, and
// pulling in a skill playbook on demand.
import type { McpTool } from "@/lib/ai/mcp-service";
import { SKILL_IDS } from "@/lib/ai/skills/registry";

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
        description: "Delegate independent subtasks to parallel worker agents to save time, each optionally on a specific model. Use when the task has 2+ independent parts (e.g. research several subtopics at once). Workers gather information and return findings as text — they do NOT create files; you synthesize their results and author the deliverables yourself. Do NOT use this for a single simple step — just do it yourself.",
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
                        model: { type: "string", description: "Optional model hint — a short name like 'gemini-3.5-flash', 'deepseek-v4-flash', 'minimax-m3', 'gemma-4', or 'mimo'. Omit to auto-pick a fast model.", required: false },
                    },
                },
            },
        },
    },
    {
        name: "use_skill",
        description: "Load a skill playbook — a detailed, proven procedure for a kind of task — before you carry it out. Consult the skill index in your instructions and call this when a skill fits, then follow the returned steps. Cheap to call; prefer using a skill over improvising when one matches.",
        parameters: {
            skill_id: {
                type: "string",
                description: "The id of the skill to load, from the skill index.",
                required: true,
                enum: SKILL_IDS,
            },
        },
    },
];
