import { NextRequest, NextResponse } from "next/server";
import { listTodos, updateTodoStatus, deleteTodo } from "@/lib/db";

// Backs the Notes checklist in the web sidebar.

export async function GET() {
    try {
        const todos = await listTodos("all", 50);
        return NextResponse.json({ todos: todos.filter((t) => t.status !== "done") });
    } catch (error: unknown) {
        console.error("[Todos API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const body = await req.json();
        const id = typeof body.id === "string" ? body.id : "";
        const status = typeof body.status === "string" ? body.status : "done";

        if (!id) {
            return NextResponse.json({ error: "Todo ID is required." }, { status: 400 });
        }
        if (!["pending", "in_progress", "done"].includes(status)) {
            return NextResponse.json({ error: "Invalid status." }, { status: 400 });
        }

        const ok = await updateTodoStatus(id, status as "pending" | "in_progress" | "done");
        if (!ok) {
            return NextResponse.json({ error: "Failed to update the task." }, { status: 500 });
        }
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("[Todos API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (!id) {
            return NextResponse.json({ error: "Todo ID is required." }, { status: 400 });
        }

        const ok = await deleteTodo(id);
        if (!ok) {
            return NextResponse.json({ error: "Failed to delete the task." }, { status: 500 });
        }
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("[Todos API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
