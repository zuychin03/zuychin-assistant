import { supabaseAdmin as supabase } from "./supabase";

export interface Project {
    id: string;
    name: string;
    instructions: string;
    color: string;
    createdAt: string;
    updatedAt: string;
}

function mapProject(row: {
    id: string;
    name: string;
    instructions: string;
    color: string;
    created_at: string;
    updated_at: string;
}): Project {
    return {
        id: row.id,
        name: row.name,
        instructions: row.instructions,
        color: row.color,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export async function listProjects(): Promise<Project[]> {
    const { data, error } = await supabase
        .from("projects")
        .select("id, name, instructions, color, created_at, updated_at")
        .order("created_at", { ascending: true });

    if (error) {
        console.error("[Projects] Failed to list:", error.message);
        return [];
    }
    return (data ?? []).map(mapProject);
}

export async function getProject(id: string): Promise<Project | null> {
    const { data, error } = await supabase
        .from("projects")
        .select("id, name, instructions, color, created_at, updated_at")
        .eq("id", id)
        .single();

    if (error) {
        console.error("[Projects] Failed to fetch:", error.message);
        return null;
    }
    return mapProject(data);
}

export async function createProject(params: {
    name: string;
    instructions?: string;
    color?: string;
    userProfileId?: string;
}): Promise<Project> {
    const { data, error } = await supabase
        .from("projects")
        .insert({
            name: params.name,
            instructions: params.instructions ?? "",
            color: params.color ?? "",
            user_profile_id: params.userProfileId ?? null,
        })
        .select("id, name, instructions, color, created_at, updated_at")
        .single();

    if (error) {
        console.error("[Projects] Failed to create:", error.message);
        throw new Error("Failed to create project.");
    }
    return mapProject(data);
}

export async function updateProject(params: {
    id: string;
    name?: string;
    instructions?: string;
    color?: string;
}): Promise<void> {
    const patch: Record<string, string> = {};
    if (params.name !== undefined) patch.name = params.name;
    if (params.instructions !== undefined) patch.instructions = params.instructions;
    if (params.color !== undefined) patch.color = params.color;
    if (Object.keys(patch).length === 0) return;

    const { error } = await supabase.from("projects").update(patch).eq("id", params.id);

    if (error) {
        console.error("[Projects] Failed to update:", error.message);
        throw new Error("Failed to update project.");
    }
}

// Conversations drop to Ungrouped and scoped facts go global (FKs set null).
export async function deleteProject(id: string): Promise<void> {
    const { error } = await supabase.from("projects").delete().eq("id", id);

    if (error) {
        console.error("[Projects] Failed to delete:", error.message);
        throw new Error("Failed to delete project.");
    }
}

export async function setConversationProject(
    conversationId: string,
    projectId: string | null
): Promise<void> {
    const { error } = await supabase
        .from("conversations")
        .update({ project_id: projectId })
        .eq("id", conversationId);

    if (error) {
        console.error("[Projects] Failed to move conversation:", error.message);
        throw new Error("Failed to move conversation.");
    }
}

/**
 * One-query lookup of the project a conversation belongs to, for prompt
 * composition. Null when the conversation is ungrouped or missing.
 */
export async function getConversationProject(
    conversationId: string
): Promise<{ id: string; name: string; instructions: string } | null> {
    const { data, error } = await supabase
        .from("conversations")
        .select("project_id, projects (id, name, instructions)")
        .eq("id", conversationId)
        .single();

    if (error) {
        console.warn("[Projects] Failed to resolve conversation project:", error.message);
        return null;
    }
    const project = data?.projects as unknown as { id: string; name: string; instructions: string } | null;
    return project ? { id: project.id, name: project.name, instructions: project.instructions } : null;
}
