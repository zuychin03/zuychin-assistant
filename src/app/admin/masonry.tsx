"use client";

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// Keep panels whole while placing each one in the currently shortest column.
export function Masonry({ minColumnWidth, gap, children }: {
    minColumnWidth: number;
    gap: number;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const itemRefs = useRef(new Map<number, HTMLDivElement>());
    const observerRef = useRef<ResizeObserver | null>(null);
    const [columns, setColumns] = useState(1);
    const [heights, setHeights] = useState<Record<number, number>>({});

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const measure = () => {
            const width = element.clientWidth;
            if (width > 0) setColumns(Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [minColumnWidth, gap]);

    const measureItems = useCallback(() => {
        setHeights((previous) => {
            const next: Record<number, number> = {};
            let changed = Object.keys(previous).length !== itemRefs.current.size;
            itemRefs.current.forEach((element, index) => {
                const height = Math.ceil(element.getBoundingClientRect().height);
                next[index] = height;
                if (previous[index] !== height) changed = true;
            });
            return changed ? next : previous;
        });
    }, []);

    const items = Children.toArray(children);
    const itemCount = items.length;

    useEffect(() => {
        const observer = new ResizeObserver(measureItems);
        observerRef.current = observer;
        itemRefs.current.forEach((element) => observer.observe(element));
        measureItems();
        return () => {
            observer.disconnect();
            observerRef.current = null;
        };
    }, [columns, itemCount, measureItems]);

    const setItemRef = useCallback((index: number, element: HTMLDivElement | null) => {
        if (!element) {
            itemRefs.current.delete(index);
            return;
        }
        itemRefs.current.set(index, element);
        observerRef.current?.observe(element);
    }, []);

    const buckets: ReactNode[][] = Array.from({ length: columns }, () => []);
    const columnHeights = Array.from({ length: columns }, () => 0);
    const estimatedHeight = Object.values(heights).reduce((total, height) => total + height, 0) / Math.max(Object.keys(heights).length, 1);

    items.forEach((child, index) => {
        const column = columnHeights.reduce((shortest, height, candidate) => height < columnHeights[shortest] ? candidate : shortest, 0);
        buckets[column].push(
            <div key={`masonry-item-${index}`} ref={(element) => setItemRef(index, element)} style={{ minWidth: 0 }}>
                {child}
            </div>,
        );
        columnHeights[column] += (heights[index] ?? (estimatedHeight || 260)) + (buckets[column].length > 1 ? gap : 0);
    });

    return (
        <div ref={ref} style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "flex-start", gap }}>
            {buckets.map((bucket, index) => (
                <div key={index} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap }}>
                    {bucket}
                </div>
            ))}
        </div>
    );
}
