"use strict";
const themePreference = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
    let saved;
    try { saved = localStorage.getItem("zuychin-theme"); } catch {}
    document.documentElement.dataset.theme = saved === "light" || saved === "dark" ? saved : themePreference.matches ? "dark" : "light";
}
applyTheme();
themePreference.addEventListener("change", applyTheme);
window.addEventListener("storage", event => { if (event.key === "zuychin-theme" || event.key === null) applyTheme(); });
const statusLine = document.getElementById("status"), list = document.getElementById("documents"), reader = document.getElementById("reader"), retry = document.getElementById("retry");
let database, state, selected, generation = 0, objectUrl, queueBusy = false, verifiedEpoch;
const empty = () => ({ version: 1, profileId: null, epoch: crypto.randomUUID(), enabled: false, documents: [], queue: [], lastSync: null });
function update(change) {
    const current = generation;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction("library", "readwrite"), store = transaction.objectStore("library"), request = store.get("state");
        let failure, next;
        request.onsuccess = () => { try { next = request.result || empty(); change(next); store.put(next, "state"); } catch (error) { failure = error; transaction.abort(); } };
        transaction.oncomplete = () => { if (current === generation) state = next; resolve(); };
        transaction.onerror = transaction.onabort = () => reject(failure || new Error("Storage is full or unavailable. Your note has not been saved; keep this text and retry."));
    });
}
function clearView() {
    generation++; selected = undefined; state = undefined; verifiedEpoch = undefined; list.replaceChildren(); reader.hidden = true; retry.hidden = true;
    document.getElementById("content").textContent = ""; document.getElementById("note").value = "";
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined;
    statusLine.textContent = "Offline data was cleared or the account changed. Reconnect and open Capture.";
}
function notifyPrivacy() {
    clearView();
    try {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
            const key = sessionStorage.key(index);
            if (key?.startsWith("zuychin-study-pending-review")) sessionStorage.removeItem(key);
        }
    } catch { /* Storage may be unavailable. */ }
    if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("zuychin-offline-privacy"); channel.postMessage("cleared"); channel.close();
    }
}
function storedState() {
    return new Promise((resolve, reject) => {
        const request = database.transaction("library", "readonly").objectStore("library").get("state");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
}
function updateControls() {
    document.getElementById("note").disabled = queueBusy || !selected;
    document.getElementById("queue").disabled = queueBusy || !selected || !document.getElementById("note").value.trim();
    document.getElementById("queue").textContent = queueBusy ? "Saving note…" : "Queue note for the inbox";
    list.querySelectorAll("button").forEach(button => { button.disabled = queueBusy; });
}
function readFailure(message = "Could not read saved documents. Your current note stays in this tab. Retry the local library.") {
    statusLine.textContent = message; statusLine.setAttribute("role", "alert"); retry.hidden = false; retry.disabled = false;
}
async function read() {
    const current = generation;
    let value;
    try { value = await storedState(); }
    catch { if (current === generation) readFailure(); return false; }
    if (current !== generation) return;
    if (verifiedEpoch && value?.epoch !== verifiedEpoch) { clearView(); return; }
    statusLine.setAttribute("role", "status"); retry.hidden = true;
    state = value; list.replaceChildren();
    if (!state?.enabled || !state.profileId) { statusLine.textContent = "No offline library is enabled. Connect and choose documents in Capture."; reader.hidden = true; return; }
    statusLine.textContent = `${state.documents.length} downloaded ${state.documents.length === 1 ? "document" : "documents"}. ${state.queue.length} ${state.queue.length === 1 ? "note" : "notes"} queued. Last note sync: ${state.lastSync ? new Date(state.lastSync).toLocaleString("en-AU") : "not yet synchronised"}.`;
    for (const item of state.documents) {
        const row = document.createElement("li"), button = document.createElement("button"), detail = document.createElement("small");
        button.textContent = item.path; button.setAttribute("aria-pressed", String(selected?.documentId === item.documentId)); button.setAttribute("aria-controls", "reader"); detail.textContent = `Saved ${new Date(item.downloadedAt).toLocaleString("en-AU")} · ${item.commitSha.slice(0, 10)}`;
        button.onclick = () => { if (queueBusy) return; if (selected?.documentId === item.documentId) { document.getElementById("title").focus(); return; } if (document.getElementById("note").value.trim() && !window.confirm("Discard this unqueued note and open another document?")) return; selected = item; reader.hidden = false; document.getElementById("title").textContent = item.path; document.getElementById("revision").textContent = detail.textContent; document.getElementById("content").textContent = item.markdown; document.getElementById("pdf").hidden = !item.originalPdf; document.getElementById("note").value = ""; list.querySelectorAll("button").forEach(value => value.setAttribute("aria-pressed", String(value === button))); updateControls(); document.getElementById("title").focus(); };
        row.append(button, detail); list.append(row);
    }
    updateControls();
    return true;
}
async function verify() {
    const current = generation;
    let privacyChange = false;
    try {
        const before = await storedState();
        if (current !== generation) return false;
        verifiedEpoch = before?.epoch;
        const response = await fetch("/api/capture/session", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (current !== generation) return false;
        const unauthorised = response.status === 401 || (response.redirected && new URL(response.url).pathname === "/login");
        if (!response.ok && !unauthorised) return true;
        const profile = unauthorised ? null : await response.json();
        if (current !== generation) return false;
        if (unauthorised || (typeof profile?.profileId === "string" && before?.profileId && before.profileId !== profile.profileId)) {
            privacyChange = true; notifyPrivacy();
            await update(value => {
                if (value.epoch !== before?.epoch) throw new Error("The account changed while checking. Reopen the offline library.");
                Object.assign(value, empty());
            });
            return false;
        }
        const latest = await storedState();
        if (current !== generation) return false;
        if (latest?.epoch !== before?.epoch) { clearView(); return false; }
        return true;
    } catch (error) {
        if (privacyChange) { statusLine.textContent = `Private content is hidden, but device cleanup was not confirmed. ${error.message} Reconnect and clear downloads before sharing this device.`; return false; }
        return current === generation;
    }
}
document.getElementById("note").oninput = updateControls;
document.getElementById("queue").onclick = async () => {
    if (queueBusy) return;
    const text = document.getElementById("note").value, token = state && { profileId: state.profileId, epoch: state.epoch }, source = selected;
    if (!token || !source || !text.trim()) { statusLine.textContent = "Choose a document and write a note first."; return; }
    queueBusy = true; updateControls();
    const current = generation;
    try {
        await update(value => {
            if (!value.enabled || value.profileId !== token.profileId || value.epoch !== token.epoch) throw new Error("The account changed. Reopen the offline library.");
            if (text.length > 20000 || value.queue.length >= 200) throw new Error("Synchronise your queued notes before adding more.");
            value.queue.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), source: { kind: "offline_note", title: `Note: ${source.path}`.slice(0, 200), text,
                source: { documentId: source.documentId, path: source.path, commitSha: source.commitSha, contentHash: source.contentHash } } });
            if (new TextEncoder().encode(JSON.stringify(value)).length + value.documents.reduce((sum, item) => sum + (item.originalPdf?.size || 0), 0) > 20 * 1024 * 1024) throw new Error("Offline storage is full. Keep this text and synchronise existing notes first.");
        });
        if (current !== generation) return;
        document.getElementById("note").value = ""; const loaded = await read(); if (loaded && current === generation) statusLine.textContent = "Note saved on this device. Open Capture when connected to sync it into the inbox.";
    } catch (error) { if (current === generation) statusLine.textContent = error.message; }
    finally { queueBusy = false; updateControls(); }
};
document.getElementById("pdf").onclick = () => {
    if (!selected?.originalPdf) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(selected.originalPdf);
    const link = document.createElement("a"); link.href = objectUrl; link.download = "saved-source.pdf"; link.click();
};
function openLibrary() {
    retry.disabled = true;
    try {
        const opened = indexedDB.open("zuychin-offline-library", 1);
        opened.onupgradeneeded = () => opened.result.createObjectStore("library").put(empty(), "state");
        opened.onerror = () => readFailure("Offline storage is unavailable in this browser. Retry the local library.");
        opened.onsuccess = async () => { database = opened.result; retry.disabled = false; if (await verify()) await read(); };
    } catch { readFailure("Offline storage is unavailable in this browser. Retry the local library."); }
}
retry.onclick = async () => {
    if (!database) { openLibrary(); return; }
    retry.disabled = true;
    try { if (await verify()) await read(); }
    finally { retry.disabled = false; }
};
openLibrary();
window.addEventListener("beforeunload", event => { if (document.getElementById("note").value.trim()) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("online", () => { if (database) void verify().then(allowed => { if (allowed) return read(); }); });
window.addEventListener("focus", () => { if (database) void verify().then(allowed => { if (allowed) return read(); }); });
if (typeof BroadcastChannel !== "undefined") new BroadcastChannel("zuychin-offline-privacy").onmessage = clearView;
