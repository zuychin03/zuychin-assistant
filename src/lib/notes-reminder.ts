import { shortenOnWord } from "@/lib/short-text";

const REMINDER_TASKS = 3;
const REMINDER_TITLE_CHARS = 56;

/** The note appended to the first reply of the day about undated pending tasks; "" when there are none. */
export function notesReminderText(undated: readonly { title: string }[]): string {
    if (!undated.length) return "";
    // A Markdown list: web renders single line breaks as spaces, and Telegram's converter turns "- " into bullets.
    const shown = undated.slice(0, REMINDER_TASKS)
        .map((todo) => `- ${shortenOnWord(todo.title.replace(/^Follow up:\s*/i, ""), REMINDER_TITLE_CHARS)}`).join("\n");
    const more = undated.length > REMINDER_TASKS ? `and ${undated.length - REMINDER_TASKS} more. ` : "";
    const count = undated.length === 1 ? "1 task has" : `${undated.length} tasks have`;
    return `\n\n---\n📌 First chat of the day: ${count} no date.\n\n${shown}\n\n${more}In the Notes panel, tick off what is done or skip what you won't do.`;
}
