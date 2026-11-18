"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, RefreshCw, Trash2, XCircle } from "lucide-react";
import ui from "./admin.module.css";

export interface ProviderSummary {
    id: string;
    label: string;
    available: boolean;
    unavailableReason?: string;
    unavailableChatModels?: { id: string; label: string; reason: string }[];
    chatModels: unknown[];
    embeddingModels: unknown[];
}

interface ProviderKeyView {
    id: string;
    label: string;
    envVar: string;
    source: "dashboard" | "environment" | null;
    lastFour: string | null;
    savedAt: string | null;
    available: boolean;
    unavailableReason: string | null;
    checkable: boolean;
}

interface ProviderKeysView {
    master: "ready" | "missing" | "invalid";
    storage: "empty" | "ok" | "migration_required" | "unavailable";
    otherRows: number;
    unreadable: string[];
    rotated: string[];
    rotationFailed: string[];
    previousLoaded: boolean;
    passwordRequired: boolean;
    changesBlocked: string | null;
    providers: ProviderKeyView[];
}

type Tone = "success" | "warning" | "danger" | undefined;
type Busy = { id: string; action: "save" | "clear" | "test" } | null;

function formatDate(value: string | null): string {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function keyLine(key: ProviderKeyView | undefined): string {
    if (!key?.source) return "No key";
    const ending = key.lastFour ? `, ends ${key.lastFour}` : "";
    if (key.source === "dashboard") return `Saved on the dashboard${ending}${key.savedAt ? `, ${formatDate(key.savedAt)}` : ""}`;
    return `From ${key.envVar}${ending}`;
}

async function send(url: string, method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: response.ok, data };
}

export default function ProviderKeysPanel({ providers, onChanged }: { providers: ProviderSummary[]; onChanged: () => void }) {
    const [view, setView] = useState<ProviderKeysView | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [editing, setEditing] = useState<{ id: string; action: "save" | "clear" } | null>(null);
    const [apiKey, setApiKey] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState<Busy>(null);
    const [results, setResults] = useState<Record<string, { tone: Tone; text: string }>>({});

    const load = useCallback(async () => {
        try {
            const response = await fetch("/api/admin/provider-keys", { cache: "no-store" });
            if (!response.ok) throw new Error();
            setView(await response.json() as ProviderKeysView);
            setLoadError(false);
        } catch {
            setLoadError(true);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const note = (id: string, tone: Tone, text: string) => setResults((current) => ({ ...current, [id]: { tone, text } }));
    const close = () => { setEditing(null); setApiKey(""); setPassword(""); };

    const save = async (provider: ProviderKeyView) => {
        const payload = { providerId: provider.id, apiKey, password };
        // The key leaves component state before the request goes out.
        setApiKey("");
        setPassword("");
        setBusy({ id: provider.id, action: "save" });
        try {
            const { ok, data } = await send("/api/admin/provider-keys", "PUT", payload);
            if (!ok) { note(provider.id, "danger", String(data.error ?? "The key was not saved.")); return; }
            const started = data.catalogueCheck === "started" ? " A model check has started." : "";
            note(provider.id, data.warning ? "warning" : "success", data.warning ? String(data.warning) : `Saved. ${String((data.check as { message?: string } | undefined)?.message ?? "")}${started}`);
            if (data.view) setView(data.view as ProviderKeysView);
            setEditing(null);
            onChanged();
        } catch {
            note(provider.id, "danger", "The key was not saved. Check your connection and try again.");
        } finally {
            setBusy(null);
        }
    };

    const clear = async (provider: ProviderKeyView) => {
        const payload = { providerId: provider.id, password };
        setPassword("");
        setBusy({ id: provider.id, action: "clear" });
        try {
            const { ok, data } = await send("/api/admin/provider-keys", "DELETE", payload);
            if (!ok) { note(provider.id, "danger", String(data.error ?? "The key was not cleared.")); return; }
            note(provider.id, "success", "Cleared.");
            if (data.view) setView(data.view as ProviderKeysView);
            setEditing(null);
            onChanged();
        } catch {
            note(provider.id, "danger", "The key was not cleared. Check your connection and try again.");
        } finally {
            setBusy(null);
        }
    };

    const test = async (provider: ProviderKeyView) => {
        setBusy({ id: provider.id, action: "test" });
        try {
            const { ok, data } = await send("/api/admin/provider-keys/test", "POST", { providerId: provider.id });
            const outcome = data.outcome;
            note(provider.id, !ok ? "danger" : outcome === "ok" ? "success" : outcome === "rejected" ? "danger" : "warning", String(data.message ?? data.error ?? "The test did not finish."));
        } catch {
            note(provider.id, "danger", "The test did not finish. Check your connection and try again.");
        } finally {
            setBusy(null);
        }
    };

    const keys = new Map((view?.providers ?? []).map((entry) => [entry.id, entry]));
    const ready = providers.filter((provider) => provider.available).length;
    const blocked = view?.changesBlocked ?? null;
    const notices: { tone: Tone; text: string }[] = [];
    if (loadError) notices.push({ tone: "danger", text: "Could not load key status." });
    if (blocked) notices.push({ tone: "warning", text: `Saving keys is off. ${blocked}` });
    if (view && view.otherRows > 0) notices.push({ tone: undefined, text: `${view.otherRows} saved key${view.otherRows === 1 ? " belongs" : "s belong"} to another environment or an old master key, so this server cannot read ${view.otherRows === 1 ? "it" : "them"}.` });
    if (view?.unreadable.length) notices.push({ tone: "danger", text: `The saved key for ${view.unreadable.join(", ")} could not be decrypted, so the env var is used instead. Save the key again.` });
    if (view?.rotated.length) notices.push({ tone: "success", text: `Re-encrypted ${view.rotated.length} saved key${view.rotated.length === 1 ? "" : "s"} with the new master key.` });
    if (view?.previousLoaded) notices.push({ tone: "warning", text: "A previous master key is still loaded. Once the keys are re-encrypted, remove it from the server and restart." });
    if (view?.rotationFailed.length) notices.push({ tone: "danger", text: `Could not re-encrypt the key for ${view.rotationFailed.join(", ")}. It will retry on the next load.` });
    const rows = providers.length ? providers : (view?.providers ?? []).map((entry) => ({ id: entry.id, label: entry.label, available: entry.available, unavailableReason: entry.unavailableReason ?? undefined, chatModels: [], embeddingModels: [] }) as ProviderSummary);

    return <>
        <div className="panel-head">
            <KeyRound size={16} />
            <div className="panel-heading">
                <h2>Providers and keys</h2>
                <p>{ready}/{rows.length || 0} providers ready. Saved keys are encrypted and never shown again.</p>
            </div>
            <button type="button" className="icon-btn" aria-label="Reload key status" title="Reload key status" onClick={() => void load()}><RefreshCw size={14} /></button>
        </div>
        {notices.map((entry) => <div key={entry.text} className="notice" data-tone={entry.tone} role="status" style={styles.notice}><span>{entry.text}</span></div>)}
        <div className="list">
            {rows.map((provider) => {
                const key = keys.get(provider.id);
                const isEditing = editing?.id === provider.id;
                const isBusy = busy?.id === provider.id;
                const result = results[provider.id];
                return <div key={provider.id} className="row" style={styles.row}>
                    <div className={ui.providerHead}>
                        <span className="row-title">{provider.label}</span>
                        <span className="pill" data-tone={provider.available ? "success" : undefined}>
                            {provider.available ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            {provider.available ? "Ready" : provider.unavailableReason ? "Unavailable" : "Missing key"}
                        </span>
                    </div>
                    <div className="meta">{provider.chatModels.length} chat · {provider.embeddingModels.length} embedding</div>
                    <div className="meta">{keyLine(key)}</div>
                    {!provider.available && provider.unavailableReason && <div className="meta">{provider.unavailableReason}</div>}
                    {!!provider.unavailableChatModels?.length && (
                        <details className={ui.providerDetails}>
                            <summary>{provider.unavailableChatModels.length} unavailable model{provider.unavailableChatModels.length === 1 ? "" : "s"}</summary>
                            {provider.unavailableChatModels.map((model) => <p key={model.id}><strong>{model.label}</strong>: {model.reason}</p>)}
                        </details>
                    )}
                    {key && !isEditing && <div style={styles.actions}>
                        <button type="button" className="btn" disabled={!!blocked || busy !== null} onClick={() => { close(); setEditing({ id: provider.id, action: "save" }); }}>
                            <KeyRound size={14} /> {key.source === "dashboard" ? "Replace" : "Set key"}
                        </button>
                        <button type="button" className="btn" disabled={!key.source || !key.checkable || busy !== null} onClick={() => void test(key)}>
                            {isBusy && busy?.action === "test" ? "Testing..." : "Test"}
                        </button>
                        {key.source === "dashboard" && <button type="button" className="btn" data-tone="danger" disabled={!!blocked || busy !== null} onClick={() => { close(); setEditing({ id: provider.id, action: "clear" }); }}>
                            <Trash2 size={14} /> Clear
                        </button>}
                    </div>}
                    {key && isEditing && <form className="box" style={styles.form} onSubmit={(event) => { event.preventDefault(); void (editing.action === "save" ? save(key) : clear(key)); }}>
                        {editing.action === "save"
                            ? <>
                                <label htmlFor={`key-${provider.id}`} style={styles.label}>API key for {provider.label}</label>
                                <input id={`key-${provider.id}`} className="field" style={styles.input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
                                    autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={isBusy} placeholder="Paste the key" />
                                <div className="meta">It is checked with {provider.label} first, then encrypted. Only the last 4 characters are shown afterwards.</div>
                            </>
                            : <div className="meta">Clear the saved key for {provider.label}? The app then uses {key.envVar} if it is set.</div>}
                        {view?.passwordRequired && <>
                            <label htmlFor={`password-${provider.id}`} style={styles.label}>Access password</label>
                            <input id={`password-${provider.id}`} className="field" style={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)}
                                autoComplete="current-password" disabled={isBusy} placeholder="Current password" />
                        </>}
                        <div style={styles.actions}>
                            <button type="submit" className="btn" data-tone={editing.action === "save" ? "primary" : "danger"}
                                disabled={isBusy || (editing.action === "save" && !apiKey.trim()) || (!!view?.passwordRequired && !password)}>
                                {editing.action === "save" ? (isBusy ? "Checking and saving..." : "Save key") : (isBusy ? "Clearing..." : "Clear key")}
                            </button>
                            <button type="button" className="btn" disabled={isBusy} onClick={close}>Cancel</button>
                        </div>
                    </form>}
                    {result && <div className="meta" role="status" style={{ ...styles.result, color: result.tone ? `var(--${result.tone})` : undefined }}>{result.text}</div>}
                </div>;
            })}
            {rows.length === 0 && <div className="empty">No providers loaded.</div>}
        </div>
    </>;
}

const styles: Record<string, React.CSSProperties> = {
    notice: { marginBottom: 8 },
    row: { display: "flex", flexDirection: "column", gap: 4 },
    actions: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 },
    form: { display: "flex", flexDirection: "column", gap: 8, marginTop: 6 },
    label: { fontSize: 13, fontWeight: 600 },
    input: { width: "100%" },
    result: { marginTop: 2 },
};
