"use client";

import { useEffect, useState } from "react";
import { EyeOff, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { ModeToggle } from "@/app/home/generation-settings";

interface Privacy { enabled: boolean; names: string[]; limits?: { names: number; nameChars: number } }

const listed = (text: string) => text.split("\n").map((name) => name.trim()).filter(Boolean);

/** V8 F13: masking of personal details on chat routes that may train. */
export default function PrivacyPanel() {
    const [state, setState] = useState<"loading" | "ready" | "error">("loading");
    const [saved, setSaved] = useState<Privacy | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [names, setNames] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const apply = (privacy: Privacy) => {
        setSaved(privacy);
        setEnabled(privacy.enabled);
        setNames(privacy.names.join("\n"));
    };

    useEffect(() => {
        let live = true;
        fetch("/api/admin/privacy", { cache: "no-store" })
            .then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (!live) return;
                if (!response.ok) { setState("error"); setMessage(data.error ?? "Could not load the privacy settings."); return; }
                apply(data as Privacy);
                setState("ready");
            })
            .catch(() => { if (live) { setState("error"); setMessage("Could not load the privacy settings."); } });
        return () => { live = false; };
    }, []);

    const dirty = !!saved && (enabled !== saved.enabled || listed(names).join("\n") !== saved.names.join("\n"));
    const limit = saved?.limits?.names ?? 40;
    const tooMany = listed(names).length > limit;

    const save = async () => {
        setBusy(true);
        setMessage("");
        try {
            const response = await fetch("/api/admin/privacy", {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, names: listed(names) }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { setMessage(data.error ?? "Could not save the privacy settings."); return; }
            apply(data as Privacy);
            const dropped = listed(names).length - (data as Privacy).names.length;
            setMessage(`Saved. It applies from the next message.${dropped > 0 ? ` ${dropped} repeated or unusable name${dropped === 1 ? " was" : "s were"} left out.` : ""}`);
        } catch {
            setMessage("Could not save the privacy settings.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div className="panel-head">
                <ShieldCheck size={16} />
                <div className="panel-heading">
                    <h2>Privacy</h2>
                    <p>Personal details sent to models that may train on them</p>
                </div>
            </div>
            {state === "loading" && <p className="meta"><LoaderCircle size={14} className="animate-spin" /> Loading...</p>}
            {state !== "loading" && (
                <div style={styles.body}>
                    <ModeToggle label="Mask personal details on free routes" icon={<EyeOff size={15} />} checked={enabled}
                        disabled={state !== "ready" || busy} onChange={() => setEnabled((value) => !value)} />
                    <label style={styles.label}>
                        <span>Names to mask</span>
                        <textarea className="field" rows={4} value={names} disabled={state !== "ready" || busy || !enabled}
                            placeholder="One name per line" onChange={(event) => setNames(event.target.value)} />
                    </label>
                    <p className="meta">
                        Emails, phone numbers, street addresses and card numbers are masked automatically. Names are masked when they start with a capital letter.
                        This covers the free Gemini key and catalogue models that may train (OpenRouter and Agnes free models, and Kilo models that say so).
                        The model sees placeholders such as [PERSON_1]; you see the real details.
                    </p>
                    {tooMany && <p className="meta" role="alert">Up to {limit} names can be saved.</p>}
                    <button type="button" className="btn" data-tone="primary" style={styles.save} disabled={state !== "ready" || busy || !dirty || tooMany} onClick={() => void save()}>
                        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
                        {busy ? "Saving..." : "Save privacy settings"}
                    </button>
                </div>
            )}
            {message && <p role="status" className="meta" style={styles.message}>{message}</p>}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    body: { display: "grid", gap: 10 },
    label: { display: "grid", gap: 6, fontSize: 13.5, fontWeight: 600 },
    save: { justifySelf: "start" },
    message: { marginTop: 10 },
};
