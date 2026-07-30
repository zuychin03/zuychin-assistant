import { supabaseAdmin as supabase } from "@/lib/supabase";
import type { GraphEdge, VaultGraph } from "@/lib/vault/graph-types";

const SNAPSHOT_ID = "current";

function isSchemaUnavailable(message: string): boolean {
    return /does not exist|schema cache|could not find the table/i.test(message);
}

export interface GraphSnapshot {
    graph: VaultGraph;
    builtAt: string;
    buildMs: number | null;
}

export async function readGraphSnapshot(): Promise<GraphSnapshot | null> {
    const { data, error } = await supabase
        .from("vault_graph_snapshot")
        .select("payload, built_at, build_ms")
        .eq("id", SNAPSHOT_ID)
        .maybeSingle();

    if (error) {
        if (!isSchemaUnavailable(error.message)) {
            console.warn("[Vault Graph] Snapshot unreadable:", error.message);
        }
        return null;
    }
    if (!data?.payload) return null;
    return {
        graph: data.payload as VaultGraph,
        builtAt: data.built_at as string,
        buildMs: (data.build_ms as number | null) ?? null,
    };
}

export async function writeGraphSnapshot(graph: VaultGraph, buildMs: number): Promise<void> {
    const { error } = await supabase.from("vault_graph_snapshot").upsert({
        id: SNAPSHOT_ID,
        payload: graph,
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
        build_ms: Math.round(buildMs),
        built_at: graph.builtAt,
    }, { onConflict: "id" });

    if (!error) return;
    if (isSchemaUnavailable(error.message)) {
        console.warn("[Vault Graph] Run supabase-setup.sql to enable graph snapshots.");
        return;
    }
    console.warn("[Vault Graph] Snapshot unwritable:", error.message);
}

/**
 * Replace the derived adjacency table. Full replace rather than diff: the build
 * already holds the complete edge set, and a stale row here is worse than a
 * momentary gap for the readers that use it.
 */
export async function replacePageLinks(edges: GraphEdge[]): Promise<void> {
    const { error: clearError } = await supabase
        .from("vault_page_links")
        .delete()
        .not("source_path", "is", null);
    if (clearError) {
        if (isSchemaUnavailable(clearError.message)) {
            console.warn("[Vault Graph] Run supabase-setup.sql to enable derived vault links.");
            return;
        }
        console.warn("[Vault Graph] Could not clear derived links:", clearError.message);
        return;
    }
    if (edges.length === 0) return;

    const rows = edges.map((edge) => ({
        source_path: edge.source,
        target_path: edge.target,
        mutual: edge.mutual,
    }));
    for (let start = 0; start < rows.length; start += 500) {
        const { error } = await supabase
            .from("vault_page_links")
            .upsert(rows.slice(start, start + 500), { onConflict: "source_path,target_path" });
        if (error) {
            console.warn("[Vault Graph] Could not write derived links:", error.message);
            return;
        }
    }
}

export interface KnowledgeDocumentDates {
    createdAt: string;
    updatedAt: string;
    trust: string;
    status: string;
    scope: string;
    sensitivity: string;
    kind: string;
}

/** Lifecycle metadata keyed by repo path; empty when the knowledge tables are absent. */
export async function listKnowledgeMetaByPath(): Promise<Map<string, KnowledgeDocumentDates>> {
    const out = new Map<string, KnowledgeDocumentDates>();
    const { data, error } = await supabase
        .from("knowledge_documents")
        .select("path, created_at, updated_at, trust, status, scope, sensitivity, kind")
        .neq("status", "deleted");

    if (error) {
        if (!isSchemaUnavailable(error.message)) {
            console.warn("[Vault Graph] Knowledge metadata unreadable:", error.message);
        }
        return out;
    }
    for (const row of data ?? []) {
        out.set(row.path as string, {
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
            trust: row.trust as string,
            status: row.status as string,
            scope: row.scope as string,
            sensitivity: row.sensitivity as string,
            kind: row.kind as string,
        });
    }
    return out;
}
