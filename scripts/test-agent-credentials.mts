// Council V3.5 agent credential tests: the scope split, and the mint/exchange/
// resolve/revoke lifecycle for per-agent keys.
//
//   npx tsx --env-file=.env.local scripts/test-agent-credentials.mts
//
// Requires the Council V3.5 wave of supabase-setup.sql to be applied. Every
// client it creates is prefixed zz-test- and hard-deleted afterwards, including
// on failure; the cascade takes its keys and claims with it.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
    ACCESS_SCOPES, createAgentClient, exchangeClaim, mintKnowledgeClaim, resolveAgentKey,
    revokeAgentClient, revokeAgentKey, listAgentClients,
} from "../src/lib/agents/clients.ts";
import {
    OWNER_SCOPES, READONLY_SCOPES, canOwnCouncil, canParticipateInCouncil, canWriteNotes,
    canWriteVault, isCouncilHost, isCouncilOwner,
} from "../src/lib/agents/scopes.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;
const created: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    }
}

const SEAT_SCOPES = ["council:seat"];
const HOST_SCOPES = ["council:host"];

function scopeChecks(): void {
    console.log("\nscope split");
    check("the owner key writes notes", canWriteNotes(OWNER_SCOPES));
    check("the owner key writes the vault", canWriteVault(OWNER_SCOPES));
    check("the owner key convenes", canOwnCouncil(OWNER_SCOPES));
    check("the owner key participates", canParticipateInCouncil(OWNER_SCOPES));

    check("a read-only key cannot write notes", !canWriteNotes(READONLY_SCOPES));
    check("a read-only key cannot write the vault", !canWriteVault(READONLY_SCOPES));
    check("a read-only key cannot convene", !canOwnCouncil(READONLY_SCOPES));

    check("a notes key writes notes", canWriteNotes(ACCESS_SCOPES.notes));
    check("a notes key cannot write the vault", !canWriteVault(ACCESS_SCOPES.notes));
    check("a full key writes the vault", canWriteVault(ACCESS_SCOPES.full));

    // The definition-of-done clause: no minted agent key convenes a council.
    for (const [level, scopes] of Object.entries(ACCESS_SCOPES)) {
        check(`a ${level} key cannot convene`, !canOwnCouncil(scopes), scopes);
        check(`a ${level} key cannot assert a seat`, !isCouncilOwner(scopes), scopes);
    }

    check("a seat key participates", canParticipateInCouncil(SEAT_SCOPES));
    check("a seat key cannot convene", !canOwnCouncil(SEAT_SCOPES));
    check("a seat key cannot write notes", !canWriteNotes(SEAT_SCOPES));

    check("the host key convenes", canOwnCouncil(HOST_SCOPES));
    check("the host key is the host", isCouncilHost(HOST_SCOPES));
    check("the host key holds no knowledge write", !canWriteNotes(HOST_SCOPES) && !canWriteVault(HOST_SCOPES));
    check("the host key is not the owner", !isCouncilOwner(HOST_SCOPES));
}

async function newClient(label: string): Promise<string> {
    const displayName = `zz-test-${label}-${randomUUID().slice(0, 8)}`;
    const result = await createAgentClient({ displayName, kind: "remote_agent" });
    if (!result.ok) throw new Error(`client creation failed: ${result.reason}`);
    created.push(result.id);
    return result.id;
}

async function lifecycleChecks(): Promise<void> {
    console.log("\nagent identity");
    const alphaId = await newClient("alpha");
    check("an agent client is created", !!alphaId);

    const { data: alphaRow } = await db.from("agent_clients")
        .select("display_name").eq("id", alphaId).single();
    const duplicate = await createAgentClient({
        displayName: alphaRow?.display_name as string, kind: "remote_agent",
    });
    check("a duplicate live name is refused", duplicate.ok === false, duplicate);

    console.log("\nclaim exchange");
    const claim = await mintKnowledgeClaim({ clientId: alphaId, accessLevel: "notes" });
    check("a claim is minted", claim.claim.startsWith("zkc_"), claim.claim.slice(0, 8));

    const exchanged = await exchangeClaim(claim.claim);
    check("the claim exchanges into a durable key", exchanged?.key.startsWith("zck_") === true);
    check("the key carries the claim's scopes, not the request's",
        JSON.stringify(exchanged?.scopes) === JSON.stringify(ACCESS_SCOPES.notes), exchanged?.scopes);
    check("the issued level is the level the owner chose", exchanged?.accessLevel === "notes", exchanged?.accessLevel);

    const again = await exchangeClaim(claim.claim);
    check("exchanging the same claim returns the same key", again?.key === exchanged?.key);

    const { count: keyCount } = await db.from("agent_client_keys")
        .select("id", { count: "exact", head: true }).eq("client_id", alphaId).is("revoked_at", null);
    check("a repeated exchange does not mint a second key", keyCount === 1, keyCount);

    check("a garbage claim is refused", (await exchangeClaim("zkc_deadbeef")) === null);
    check("a malformed claim is refused", (await exchangeClaim("not-a-claim")) === null);

    console.log("\nresolution and isolation");
    const identity = await resolveAgentKey(exchanged!.key);
    check("the key resolves to its client", identity?.clientId === alphaId, identity);
    check("the resolved scopes match the claim",
        JSON.stringify(identity?.scopes) === JSON.stringify(ACCESS_SCOPES.notes), identity?.scopes);

    const betaId = await newClient("beta");
    const betaClaim = await mintKnowledgeClaim({ clientId: betaId, accessLevel: "read" });
    const betaKey = await exchangeClaim(betaClaim.claim);
    check("a second client gets a distinct key", betaKey!.key !== exchanged!.key);
    check("the second client's level is its own",
        JSON.stringify(betaKey?.scopes) === JSON.stringify(ACCESS_SCOPES.read), betaKey?.scopes);

    console.log("\nrevocation");
    const { data: alphaKeyRow } = await db.from("agent_client_keys")
        .select("id").eq("client_id", alphaId).is("revoked_at", null).single();
    await revokeAgentKey(alphaKeyRow!.id as string);
    check("a revoked key no longer resolves", (await resolveAgentKey(exchanged!.key)) === null);
    check("the other client is unaffected", (await resolveAgentKey(betaKey!.key))?.clientId === betaId);

    const replay = await exchangeClaim(claim.claim);
    check("a replayed claim cannot re-mint a revoked key", replay === null, replay);

    await revokeAgentClient(betaId);
    check("revoking a client kills its key", (await resolveAgentKey(betaKey!.key)) === null);
    const listed = await listAgentClients();
    check("a revoked client leaves the panel", !listed.some((c) => c.id === betaId));

    console.log("\nclaim lifetime");
    const gammaId = await newClient("gamma");
    const stale = await mintKnowledgeClaim({ clientId: gammaId, accessLevel: "full" });
    await db.from("agent_client_claims")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("client_id", gammaId);
    check("an expired claim is refused", (await exchangeClaim(stale.claim)) === null);

    const fresh = await mintKnowledgeClaim({ clientId: gammaId, accessLevel: "full" });
    check("a fresh claim still works", (await exchangeClaim(fresh.claim))?.accessLevel === "full");

    const deltaId = await newClient("delta");
    const first = await mintKnowledgeClaim({ clientId: deltaId, accessLevel: "read" });
    await mintKnowledgeClaim({ clientId: deltaId, accessLevel: "full" });
    check("minting a second claim invalidates the first", (await exchangeClaim(first.claim)) === null);
}

async function cleanup(): Promise<void> {
    if (created.length === 0) return;
    const { error } = await db.from("agent_clients").delete().in("id", created);
    if (error) console.warn(`cleanup failed for ${created.length} client(s): ${error.message}`);
    else console.log(`\ncleaned up ${created.length} test client(s)`);
}

async function main(): Promise<void> {
    scopeChecks();
    try {
        await lifecycleChecks();
    } catch (err) {
        failed++;
        console.error("\naborted:", err instanceof Error ? err.message : err);
        if (err instanceof Error && /agent_client|agent_claim/.test(err.message)) {
            console.error("This looks like the Council V3.5 wave has not been applied yet.");
        }
    } finally {
        await cleanup();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
