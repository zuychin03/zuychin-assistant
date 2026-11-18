// Finds the part of a streaming reply that can be spoken already: whole sentences or lines, never inside a code fence.

// A full stop after these does not end a sentence (list numbers, initials, common abbreviations).
const NOT_AN_END = /(?:^|\s)(?:\d+|[a-z]|e\.g|i\.e|etc|vs|approx|dr|mr|mrs|ms|st)\.$/i;
const CLOSERS = /["')\]*_]/;

/** End index of the text from `from` that is ready to speak, or `from` when none is. */
export function speakableEnd(text: string, from: number): number {
    let end = from;
    let fences = text.slice(0, from).split("```").length - 1;
    for (let i = from; i < text.length; i++) {
        if (text.startsWith("```", i)) {
            fences++;
            i += 2;
            continue;
        }
        if (fences % 2 === 1) continue;
        const ch = text[i];
        if (ch === "\n") {
            end = i + 1;
        } else if (ch === "." || ch === "!" || ch === "?") {
            let next = i + 1;
            while (next < text.length && CLOSERS.test(text[next])) next++;
            if (next >= text.length || !/\s/.test(text[next])) continue;
            if (ch === "." && NOT_AN_END.test(text.slice(Math.max(from, i - 12), i + 1))) continue;
            end = next;
        }
    }
    return end;
}
