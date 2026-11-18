// On globalThis so every route bundle in the process shares the slots (1 GB box).
const KEY = Symbol.for("zuychin.capture.slots");
const scope = globalThis as unknown as Record<symbol, Set<string> | undefined>;

export type SlotName = "extract" | "ocr";

export function acquireSlot(name: SlotName): (() => void) | null {
    const busy = (scope[KEY] ??= new Set());
    if (busy.has(name)) return null;
    busy.add(name);
    let released = false;
    return () => { if (!released) { released = true; busy.delete(name); } };
}
