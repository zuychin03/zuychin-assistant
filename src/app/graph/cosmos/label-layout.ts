export interface LabelBox { x1: number; y1: number; x2: number; y2: number }

export function placeLabel(
    anchor: { x: number; y: number },
    width: number,
    height: number,
    offset: number,
    bounds: LabelBox,
    occupied: readonly LabelBox[],
): LabelBox | null {
    if (width <= 0 || height <= 0 || width > bounds.x2 - bounds.x1 || height > bounds.y2 - bounds.y1) return null;
    const centre = anchor.x - width / 2;
    const candidates = [
        [centre, anchor.y + offset],
        [centre, anchor.y - offset - height],
        [anchor.x + offset, anchor.y - height / 2],
        [anchor.x - offset - width, anchor.y - height / 2],
    ];
    for (const [left, top] of candidates) {
        const x1 = Math.max(bounds.x1, Math.min(left, bounds.x2 - width));
        const y1 = Math.max(bounds.y1, Math.min(top, bounds.y2 - height));
        const box = { x1, y1, x2: x1 + width, y2: y1 + height };
        if (!occupied.some(other => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1)) return box;
    }
    return null;
}
