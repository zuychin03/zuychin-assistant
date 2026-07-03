import { NextRequest, NextResponse } from "next/server";
import { getFile, requireVaultConfig } from "@/lib/vault/github";
import { writeVaultPage } from "@/lib/vault/ingest";
import { deleteGraphPage } from "@/lib/vault/graph";
import { listVaultPages } from "@/lib/vault/store";
import { getEmbeddingRef } from "@/lib/ai/embeddings";

export const maxDuration = 60;

const PAGE_PATH_RE = /^wiki\/(sources|concepts|entities|synthesis)\/[a-z0-9-]+\.md$/;

function badPath(path: string | null): path is null {
    return !path || !PAGE_PATH_RE.test(path);
}

export async function GET(req: NextRequest) {
    try {
        const path = req.nextUrl.searchParams.get("path");
        if (badPath(path)) {
            return NextResponse.json({ error: "A valid wiki page path is required." }, { status: 400 });
        }
        const file = await getFile(requireVaultConfig(), path);
        if (!file) {
            return NextResponse.json({ error: "Page not found." }, { status: 404 });
        }
        return NextResponse.json({ path: file.path, markdown: file.text });
    } catch (error: unknown) {
        console.error("[Vault Page API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        const body = await req.json();
        const path = typeof body.path === "string" ? body.path : null;
        const markdown = typeof body.markdown === "string" ? body.markdown : "";
        if (badPath(path) || !markdown.trim()) {
            return NextResponse.json({ error: "A valid path and non-empty markdown are required." }, { status: 400 });
        }

        // Preserve the catalogued summary; writeVaultPage would otherwise stamp a generic one.
        const row = (await listVaultPages()).find((r) => r.path === path);
        const result = await writeVaultPage({
            path,
            markdown,
            summary: row?.summary || undefined,
            embRef: getEmbeddingRef(row?.embeddingModel),
        });
        return NextResponse.json({ success: true, commit: result.commit });
    } catch (error: unknown) {
        console.error("[Vault Page API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const path = req.nextUrl.searchParams.get("path");
        if (badPath(path)) {
            return NextResponse.json({ error: "A valid wiki page path is required." }, { status: 400 });
        }
        const result = await deleteGraphPage(path);
        return NextResponse.json({ success: true, ...result });
    } catch (error: unknown) {
        console.error("[Vault Page API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
