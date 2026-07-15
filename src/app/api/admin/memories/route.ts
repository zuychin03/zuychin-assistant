import { NextRequest, NextResponse } from "next/server";
import { listMemories, insertMemory, updateMemoryFact, deleteMemory, type MemoryCategory } from "@/lib/ai/memory/store";
import { getDefaultProfile } from "@/lib/db";

const CATEGORIES = ["identity", "preference", "relationship", "project", "routine", "fact", "other"];

function normalizeCategory(raw: unknown): MemoryCategory {
    return (CATEGORIES.includes(String(raw)) ? String(raw) : "other") as MemoryCategory;
}

export async function GET(req: NextRequest) {
    try {
        const category = req.nextUrl.searchParams.get("category") ?? undefined;
        const memories = await listMemories(200, category);
        return NextResponse.json({ memories });
    } catch (err) {
        console.error("[Admin Memories] List failed:", err);
        return NextResponse.json({ error: "Failed to load memories." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const fact = typeof body.fact === "string" ? body.fact.trim() : "";
        if (!fact) return NextResponse.json({ error: "Fact text is required." }, { status: 400 });

        const profile = await getDefaultProfile();
        const id = await insertMemory({
            fact,
            category: normalizeCategory(body.category),
            source: "manual",
            userProfileId: profile?.id,
        });
        if (!id) return NextResponse.json({ error: "Failed to save memory." }, { status: 500 });
        return NextResponse.json({ id });
    } catch (err) {
        console.error("[Admin Memories] Create failed:", err);
        return NextResponse.json({ error: "Failed to save memory." }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        const body = await req.json();
        const id = typeof body.id === "string" ? body.id : "";
        const fact = typeof body.fact === "string" ? body.fact.trim() : "";
        if (!id || !fact) return NextResponse.json({ error: "id and fact are required." }, { status: 400 });

        const ok = await updateMemoryFact({
            id,
            fact,
            category: body.category ? normalizeCategory(body.category) : undefined,
        });
        if (!ok) return NextResponse.json({ error: "Failed to update memory." }, { status: 500 });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("[Admin Memories] Update failed:", err);
        return NextResponse.json({ error: "Failed to update memory." }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
        const ok = await deleteMemory(id);
        if (!ok) return NextResponse.json({ error: "Failed to delete memory." }, { status: 500 });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("[Admin Memories] Delete failed:", err);
        return NextResponse.json({ error: "Failed to delete memory." }, { status: 500 });
    }
}
