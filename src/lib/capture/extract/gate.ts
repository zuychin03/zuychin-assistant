import { CaptureError } from "../service";

// On globalThis so every route bundle in the process shares one slot (1 GB box).
const KEY = Symbol.for("zuychin.capture.extractionSlot");
const scope = globalThis as unknown as Record<symbol, boolean | undefined>;

export async function withExtractionSlot<T>(run: () => Promise<T>): Promise<T> {
    if (scope[KEY]) throw new CaptureError("Another source is being read. Try again in a moment.", 429);
    scope[KEY] = true;
    try { return await run(); } finally { scope[KEY] = false; }
}
