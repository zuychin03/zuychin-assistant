import { reviewInput } from "./contracts";

export type PendingReview = ReturnType<typeof reviewInput.parse>;
const prefix = "zuychin-study-pending-review";
export function clearStudyPending(storage: Storage) {
    for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) storage.removeItem(key);
    }
}
export function readStudyPending(storage: Storage, profileId: string): PendingReview | null {
    storage.removeItem(prefix);
    const key = `${prefix}:${profileId}`;
    for (let index = storage.length - 1; index >= 0; index--) {
        const other = storage.key(index);
        if (other?.startsWith(prefix) && other !== key) storage.removeItem(other);
    }
    const saved = storage.getItem(key);
    if (!saved) return null;
    try {
        const envelope = JSON.parse(saved);
        if (envelope.profileId !== profileId || envelope.version !== 1) throw new Error("Profile mismatch");
        return reviewInput.parse(envelope.request);
    } catch {
        storage.removeItem(key);
        throw new Error("The saved review could not be verified. Refresh your records before reviewing again.");
    }
}
export function writeStudyPending(storage: Storage, profileId: string, request: PendingReview) {
    if (!profileId) throw new Error("An authenticated profile is required.");
    storage.setItem(`${prefix}:${profileId}`, JSON.stringify({ version: 1, profileId, request: reviewInput.parse(request) }));
}
