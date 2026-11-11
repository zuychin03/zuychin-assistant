"use client";

import { Children, type ReactNode } from "react";

export function Masonry({ minColumnWidth, gap, children }: {
    minColumnWidth: number;
    gap: number;
    children: ReactNode;
}) {
    // column-gap only spaces columns, so items pad their own bottoms; the negative margin drops the last row's padding.
    return (
        <div style={{ columnWidth: minColumnWidth, columnGap: gap, marginBottom: -gap }}>
            {Children.toArray(children).map((child, index) => (
                <div key={index} style={{ display: "inline-block", width: "100%", minWidth: 0, breakInside: "avoid", paddingBottom: gap, verticalAlign: "top" }}>
                    {child}
                </div>
            ))}
        </div>
    );
}
