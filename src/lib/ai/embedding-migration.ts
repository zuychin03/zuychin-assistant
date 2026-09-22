export const MIGRATION_TABLES = [
    "embeddings", "memories", "vault_pages", "knowledge_chunks", "knowledge_assertions",
] as const;

export type MigrationTable = typeof MIGRATION_TABLES[number];
export type MigrationRow = Record<string, unknown> & { id: string };

export interface MigrationItem {
    table: MigrationTable;
    row: MigrationRow;
    text: string;
}

export interface PreparedItem extends MigrationItem {
    vector: number[];
}

export interface MigrationStore {
    scan(table: MigrationTable, afterId: string | null, limit: number): Promise<MigrationRow[]>;
    read(table: MigrationTable, id: string): Promise<MigrationRow | null>;
    update(item: MigrationItem, vector: number[], target: string): Promise<boolean>;
    activate(target: string): Promise<void>;
}

export interface MigrationPlan {
    target: string;
    dimension: number;
    items: MigrationItem[];
    counts: Record<MigrationTable, { total: number; pending: number }>;
}

export function parseVector(value: unknown): number[] | null {
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
    }
    return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n))
        ? value as number[] : null;
}

export function validVector(value: unknown, dimension: number): boolean {
    const vector = parseVector(value);
    return !!vector && vector.length === dimension && vector.some((n) => n !== 0);
}

function requiredText(row: MigrationRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string") throw new Error(`Missing ${column} on a migration row.`);
    return value;
}

export function migrationText(table: MigrationTable, row: MigrationRow): string {
    if (table === "memories") return requiredText(row, "fact");
    if (table === "knowledge_assertions") return requiredText(row, "assertion");
    if (table === "vault_pages") return `${requiredText(row, "title")}\n\n${requiredText(row, "content")}`.slice(0, 8000);
    if (table === "knowledge_chunks") {
        const document = row.document as { title?: unknown } | null;
        if (typeof document?.title !== "string") throw new Error("Missing parent title on a knowledge chunk.");
        if (!Array.isArray(row.heading_path) || !row.heading_path.every((part) => typeof part === "string")) {
            throw new Error("Invalid heading path on a knowledge chunk.");
        }
        return [document.title, row.heading_path.join(" > "), requiredText(row, "content")].filter(Boolean).join("\n\n");
    }
    return requiredText(row, "content");
}

export function assertCasSafe(table: MigrationTable, row: MigrationRow): void {
    if (table === "embeddings") {
        // PostgREST carries filters in the URL; refuse oversized unversioned sources.
        if (encodeURIComponent(requiredText(row, "content")).length > 12000) {
            throw new Error("An embeddings source exceeds the safe conditional-update URL size.");
        }
    } else if (typeof row.updated_at !== "string" || !row.updated_at) {
        throw new Error(`${table} needs updated_at for conditional migration.`);
    }
    if (table === "knowledge_chunks" && typeof row.content_hash !== "string") {
        throw new Error("A knowledge chunk is missing its source hash.");
    }
}

export function sameSource(item: MigrationItem, current: MigrationRow): boolean {
    return migrationText(item.table, current) === item.text
        && current.embedding_model === item.row.embedding_model
        && current.updated_at === item.row.updated_at
        && current.content_hash === item.row.content_hash
        && (current.embedding == null) === (item.row.embedding == null);
}

async function visitRows(
    store: MigrationStore,
    visit: (table: MigrationTable, row: MigrationRow) => void | boolean,
    pageSize = 250,
): Promise<void> {
    for (const table of MIGRATION_TABLES) {
        let cursor: string | null = null;
        for (;;) {
            const rows = await store.scan(table, cursor, pageSize);
            if (!rows.length) break;
            const next = rows.at(-1)?.id;
            if (!next || next === cursor) throw new Error(`${table} pagination did not advance.`);
            for (const row of rows) if (visit(table, row) === false) return;
            cursor = next;
        }
    }
}

export async function planMigration(
    store: MigrationStore, target: string, dimension: number,
    options: { maxItems?: number; stopAfterMaxItems?: boolean } = {},
): Promise<MigrationPlan> {
    if (!target || !Number.isInteger(dimension) || dimension < 1) throw new Error("A registered target and dimension are required.");
    if (options.maxItems !== undefined && (!Number.isInteger(options.maxItems) || options.maxItems < 1)) {
        throw new Error("The migration batch size must be a positive integer.");
    }
    const counts = Object.fromEntries(MIGRATION_TABLES.map((table) => [table, { total: 0, pending: 0 }])) as MigrationPlan["counts"];
    const items: MigrationItem[] = [];
    await visitRows(store, (table, row) => {
        counts[table].total++;
        if (row.embedding_model === target && validVector(row.embedding, dimension)) return;
        counts[table].pending++;
        if (items.length >= (options.maxItems ?? Infinity)) return;
        const text = migrationText(table, row);
        if (!text.trim()) throw new Error(`${table} contains an empty embedding source.`);
        assertCasSafe(table, row);
        items.push({ table, row, text });
        if (options.stopAfterMaxItems && items.length >= (options.maxItems ?? Infinity)) return false;
    }, options.stopAfterMaxItems ? Math.min(250, options.maxItems ?? 250) : 250);
    return { target, dimension, counts, items };
}

export async function mapBounded<T, U>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<U>): Promise<U[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Concurrency must be between 1 and 8.");
    const results = new Array<U>(items.length);
    let next = 0;
    let failure: unknown;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!failed) {
            const index = next++;
            if (index >= items.length) return;
            try { results[index] = await work(items[index], index); }
            catch (error) { failed = true; failure = error; }
        }
    }));
    if (failed) throw failure;
    return results;
}

export async function prepareMigration(
    plan: MigrationPlan,
    embed: (text: string) => Promise<number[]>,
    concurrency = 2,
    progress?: (completed: number, total: number) => void,
): Promise<PreparedItem[]> {
    let completed = 0;
    return mapBounded(plan.items, concurrency, async (item) => {
        const vector = await embed(item.text);
        if (!validVector(vector, plan.dimension)) throw new Error(`The provider returned an invalid ${plan.dimension}-dimensional vector.`);
        progress?.(++completed, plan.items.length);
        return { ...item, vector };
    });
}

export async function verifyMigration(store: MigrationStore, target: string, dimension: number) {
    const remaining = Object.fromEntries(MIGRATION_TABLES.map((table) => [table, 0])) as Record<MigrationTable, number>;
    await visitRows(store, (table, row) => {
        if (row.embedding_model !== target || !validVector(row.embedding, dimension)) remaining[table]++;
    });
    return remaining;
}

export async function applyMigration(
    store: MigrationStore, plan: MigrationPlan, prepared: PreparedItem[], concurrency = 2,
    verify: typeof verifyMigration = verifyMigration,
) {
    if (prepared.length !== plan.items.length || Array.from(prepared).some((item, index) => !item
        || item.table !== plan.items[index].table || item.row.id !== plan.items[index].row.id || item.text !== plan.items[index].text
        || !validVector(item.vector, plan.dimension))) throw new Error("Prepared vectors do not match the migration plan.");
    const conflicts: { table: MigrationTable; id: string }[] = [];
    const failures: { table: MigrationTable; id: string }[] = [];
    let updated = 0, alreadyCurrent = 0;
    await mapBounded(prepared, concurrency, async (item) => {
        try {
            const current = await store.read(item.table, item.row.id);
            if (current && migrationText(item.table, current) === item.text
                && current.embedding_model === plan.target && validVector(current.embedding, plan.dimension)) {
                alreadyCurrent++;
            } else if (!current || !sameSource(item, current) || !await store.update(item, item.vector, plan.target)) {
                conflicts.push({ table: item.table, id: item.row.id });
            } else updated++;
        } catch { failures.push({ table: item.table, id: item.row.id }); }
    });
    const remaining = await verify(store, plan.target, plan.dimension);
    const complete = !conflicts.length && !failures.length && Object.values(remaining).every((count) => count === 0);
    if (complete) await store.activate(plan.target);
    return { complete, updated, alreadyCurrent, conflicts, failures, remaining };
}
