import { NextRequest, NextResponse } from "next/server";
import { listProjects, createProject, updateProject, deleteProject } from "@/lib/projects";
import { getDefaultProfile } from "@/lib/db";

export async function GET() {
    try {
        const projects = await listProjects();
        return NextResponse.json({ projects });
    } catch (error: unknown) {
        console.error("[Projects API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!name) {
            return NextResponse.json({ error: "Project name is required." }, { status: 400 });
        }

        const profile = await getDefaultProfile();
        const project = await createProject({
            name,
            instructions: typeof body?.instructions === "string" ? body.instructions : undefined,
            color: typeof body?.color === "string" ? body.color : undefined,
            userProfileId: profile?.id,
        });
        return NextResponse.json(project);
    } catch (error: unknown) {
        console.error("[Projects API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        const body = await req.json();
        if (!body?.id) {
            return NextResponse.json({ error: "Project ID is required." }, { status: 400 });
        }

        await updateProject({
            id: body.id,
            name: typeof body.name === "string" ? body.name.trim() : undefined,
            instructions: typeof body.instructions === "string" ? body.instructions : undefined,
            color: typeof body.color === "string" ? body.color : undefined,
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("[Projects API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (!id) {
            return NextResponse.json({ error: "Project ID is required." }, { status: 400 });
        }

        await deleteProject(id);
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("[Projects API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
