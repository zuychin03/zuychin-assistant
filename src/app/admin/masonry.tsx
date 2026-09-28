"use client";

import { Children, type ReactNode } from "react";

export function Masonry({ minColumnWidth, gap, children }: {
    minColumnWidth: number;
    gap: number;
    children: ReactNode;
}) {
    return (
        <div style={{ position: "relative", zIndex: 1, columnWidth: minColumnWidth, columnGap: gap }}>
            {Children.toArray(children).map((child, index) => (
                <div key={index} style={{ display: "inline-block", width: "100%", minWidth: 0, breakInside: "avoid", paddingBottom: gap, verticalAlign: "top" }}>
                    {child}
                </div>
            ))}
        </div>
    );
}
