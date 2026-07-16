import { NextResponse } from "next/server";
import { listTodos, listDueTodos } from "@/lib/db";
import { listUpcomingEvents } from "@/lib/integrations/calendar-service";

export async function GET() {
    const [dueTodos, todos, events] = await Promise.all([
        listDueTodos().catch(() => []),
        listTodos("pending", 10).catch(() => []),
        listUpcomingEvents(48, 10).catch(() => []),
    ]);

    // Due todos also appear in the pending list; the card shows them once.
    const dueIds = new Set(dueTodos.map((t) => t.id));
    return NextResponse.json({
        dueTodos,
        todos: todos.filter((t) => !dueIds.has(t.id)),
        events,
    });
}
