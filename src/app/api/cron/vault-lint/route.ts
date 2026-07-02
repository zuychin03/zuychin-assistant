import { NextRequest, NextResponse } from "next/server";
import { getVaultConfig } from "@/lib/vault/github";
import { lintVault } from "@/lib/vault/lint";

const CRON_SECRET = process.env.CRON_SECRET;

// GitHub round-trips + three LLM calls (review, verify, embeds) need headroom.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("authorization");
        if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!getVaultConfig()) {
            return NextResponse.json({ error: "Vault not configured." }, { status: 500 });
        }

        const mode = req.nextUrl.searchParams.get("mode") === "suggest" ? "suggest" : "auto";
        const result = await lintVault({ mode });
        console.log(`[VaultLint] ${result.report.split("\n")[0]}`);

        return NextResponse.json({
            mode: result.mode,
            fixed: result.fixes.length,
            warnings: result.warnings,
            commit: result.commit ?? null,
            report: result.report,
        });
    } catch (error) {
        console.error("[VaultLint] Error:", error);
        return NextResponse.json({ error: "Vault lint failed." }, { status: 500 });
    }
}
