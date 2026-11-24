/** Collapses whitespace and cuts on a whole word with "…"; text that fits comes back unchanged. */
export function shortenOnWord(text: string, max: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;
    const window = clean.slice(0, max);
    const space = clean[max] === " " ? max : window.lastIndexOf(" ");
    // One long word: cut inside it rather than leave almost nothing.
    const cut = space > max / 2 ? window.slice(0, space) : window;
    return `${cut.replace(/[\s,;:.\-\u2013\u2014]+$/, "")}…`;
}
