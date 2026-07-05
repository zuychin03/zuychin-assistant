import { NextRequest, NextResponse } from "next/server";
import { SKILLS } from "@/lib/ai/skills/registry";
import { listCustomSkills, updateCustomSkill, deleteCustomSkill } from "@/lib/ai/skills/custom-store";

export async function GET() {
    try {
        const custom = await listCustomSkills();
        const builtIn = SKILLS.map((s) => ({ id: s.id, name: s.name, whenToUse: s.whenToUse }));
        return NextResponse.json({ custom, builtIn });
    } catch (err) {
        console.error("[Admin Skills] List failed:", err);
        return NextResponse.json({ error: "Failed to load skills." }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        const body = await req.json();
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

        const ok = await updateCustomSkill({
            id,
            name: typeof body.name === "string" ? body.name : undefined,
            whenToUse: typeof body.whenToUse === "string" ? body.whenToUse : undefined,
            instructions: typeof body.instructions === "string" ? body.instructions : undefined,
            status: body.action === "approve" ? "active" : body.action === "unapprove" ? "draft" : undefined,
        });
        if (!ok) return NextResponse.json({ error: "Failed to update skill." }, { status: 500 });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("[Admin Skills] Update failed:", err);
        return NextResponse.json({ error: "Failed to update skill." }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");
        if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
        const ok = await deleteCustomSkill(id);
        if (!ok) return NextResponse.json({ error: "Failed to delete skill." }, { status: 500 });
        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("[Admin Skills] Delete failed:", err);
        return NextResponse.json({ error: "Failed to delete skill." }, { status: 500 });
    }
}
