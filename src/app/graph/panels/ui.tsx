"use client";

import type { CSSProperties, ReactNode } from "react";
import { styles } from "../cosmos/styles";

export function PanelShell({ icon, title, subtitle, aside, children }: {
    icon?: ReactNode;
    title: string;
    subtitle?: string;
    aside?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section style={styles.panel}>
            <div style={styles.panelHeader}>
                {icon && <div style={styles.panelIcon}>{icon}</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={styles.panelTitle}>{title}</h2>
                    {subtitle && <p style={styles.panelSubtle}>{subtitle}</p>}
                </div>
                {aside}
            </div>
            {children}
        </section>
    );
}

export function Switch({ label, icon, on, onChange }: {
    label: string;
    icon?: ReactNode;
    on: boolean;
    onChange(next: boolean): void;
}) {
    return (
        <div style={styles.switchRow}>
            <span style={styles.switchLabel}>{icon}{label}</span>
            <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                onClick={() => onChange(!on)}
                style={{ ...styles.switch, ...(on ? styles.switchOn : {}) }}
            >
                <span style={{ ...styles.switchKnob, transform: on ? "translateX(17px)" : "translateX(0)" }} />
            </button>
        </div>
    );
}

export function Slider({ label, min, max, step, value, format, onChange }: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format?(value: number): string;
    onChange(next: number): void;
}) {
    return (
        <label style={styles.sliderRow}>
            <span style={styles.sliderHead}>
                <span>{label}</span>
                <span>{format ? format(value) : value}</span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                style={styles.slider}
            />
        </label>
    );
}

export function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
    const style: CSSProperties = {
        ...styles.badge,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 34%, transparent)`,
    };
    return <span style={style} title={title}>{label}</span>;
}
