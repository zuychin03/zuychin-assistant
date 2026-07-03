import { NextRequest, NextResponse } from "next/server";
import { createGraphLink, deleteGraphLink } from "@/lib/vault/graph";

export const maxDuration = 60;

const PAGE_PATH_RE = /^wiki\/(sources|concepts|entities|synthesis)\/[a-z0-9-]+\.md$/;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const source = typeof body.source === "string" ? body.source : "";
        const target = typeof body.target === "string" ? body.target : "";
        const label = typeof body.label === "string" ? body.label : "related";
        if (!PAGE_PATH_RE.test(source) || !PAGE_PATH_RE.test(target) || source === target) {
            return NextResponse.json({ error: "Two distinct valid wiki page paths are required." }, { status: 400 });
        }
        const result = await createGraphLink(source, target, label);
        return NextResponse.json({ success: true, ...result });
    } catch (error: unknown) {
        console.error("[Vault Link API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const source = req.nextUrl.searchParams.get("source") ?? "";
        const target = req.nextUrl.searchParams.get("target") ?? "";
        if (!PAGE_PATH_RE.test(source) || !PAGE_PATH_RE.test(target) || source === target) {
            return NextResponse.json({ error: "Two distinct valid wiki page paths are required." }, { status: 400 });
        }
        const result = await deleteGraphLink(source, target);
        return NextResponse.json({ success: true, ...result });
    } catch (error: unknown) {
        console.error("[Vault Link API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
