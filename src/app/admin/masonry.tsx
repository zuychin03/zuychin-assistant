"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";

// Replaces CSS multi-column, which had two failure modes here: break-inside is
// ignored once a panel contains its own scroll container, so tall panels split
// across columns, and the balancer re-flows every time a panel's data lands, so
// tiles visibly jump between columns while the page loads. Real column elements
// cannot split, and a late height change only grows the column it is in.
export function Masonry({ minColumnWidth, gap, children }: {
    minColumnWidth: number;
    gap: number;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [columns, setColumns] = useState(1);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const width = el.clientWidth;
            if (width > 0) {
                setColumns(Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))));
            }
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [minColumnWidth, gap]);

    const items = Children.toArray(children);
    // Round-robin rather than shortest-column-first: packing by measured height
    // makes the layout depend on its own output, so panels re-order themselves
    // as they load. This keeps reading order left-to-right and never moves.
    const buckets: ReactNode[][] = Array.from({ length: columns }, () => []);
    items.forEach((child, i) => buckets[i % columns].push(child));

    return (
        <div ref={ref} style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "flex-start", gap }}>
            {buckets.map((bucket, i) => (
                <div key={i} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap }}>
                    {bucket}
                </div>
            ))}
        </div>
    );
}
