import { NextRequest, NextResponse } from "next/server";
import { updateSystemPrompt, getDefaultProfile } from "@/lib/db";

/** PUT /api/admin/personality — Update bot personality */

export async function PUT(req: NextRequest) {
    try {
        const { systemPrompt } = await req.json();

        if (!systemPrompt || typeof systemPrompt !== "string") {
            return NextResponse.json(
                { error: "systemPrompt is required." },
                { status: 400 }
            );
        }

        if (systemPrompt.length > 5000) {
            return NextResponse.json(
                { error: "System prompt too long (max 5,000 characters)." },
                { status: 400 }
            );
        }

        const profile = await getDefaultProfile();
        if (!profile) {
            return NextResponse.json(
                { error: "No user profile found." },
                { status: 404 }
            );
        }

        await updateSystemPrompt(profile.id, systemPrompt);

        return NextResponse.json({
            success: true,
            message: "Bot personality updated.",
        });
    } catch (error) {
        console.error("[Admin Personality] Error:", error);
        return NextResponse.json(
            { error: "Failed to update personality." },
            { status: 500 }
        );
    }
}
