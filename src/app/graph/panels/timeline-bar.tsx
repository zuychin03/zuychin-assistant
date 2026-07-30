"use client";

import { useEffect, useRef } from "react";
import { Pause, Play, X } from "lucide-react";
import { styles } from "../cosmos/styles";
import { COSMOS } from "../cosmos/palette";

// One sweep of the whole vault history takes roughly this long per year of content.
const MS_PER_YEAR_OF_HISTORY = 4000;
const FRAME_MS = 40;

export default function TimelineBar({ start, end, value, playing, onChange, onPlaying, onExit }: {
    start: number;
    end: number;
    value: number;
    playing: boolean;
    onChange(next: number): void;
    onPlaying(next: boolean): void;
    onExit(): void;
}) {
    const timer = useRef<number | null>(null);
    // The sweep advances from wherever the handle currently sits without
    // restarting the interval on every frame it produces.
    const latest = useRef(value);
    useEffect(() => { latest.current = value; }, [value]);

    useEffect(() => {
        if (!playing) return;
        const span = Math.max(1, end - start);
        const years = span / (365 * 86_400_000);
        const perFrame = (span / Math.max(1, (years * MS_PER_YEAR_OF_HISTORY) / FRAME_MS));

        timer.current = window.setInterval(() => {
            const next = latest.current + perFrame;
            if (next >= end) {
                onChange(end);
                onPlaying(false);
                return;
            }
            onChange(next);
        }, FRAME_MS);

        return () => {
            if (timer.current !== null) window.clearInterval(timer.current);
            timer.current = null;
        };
    }, [playing, start, end, onChange, onPlaying]);

    const label = new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const atEnd = value >= end - 1000;

    return (
        <div style={styles.timelineWrap} className="animate-fade-in-scale">
            <button
                style={styles.iconBtn}
                onClick={() => {
                    if (atEnd && !playing) onChange(start);
                    onPlaying(!playing);
                }}
                aria-label={playing ? "Pause the sweep" : "Play the sweep"}
                title={playing ? "Pause (space)" : "Play (space)"}
            >
                {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>

            <div style={styles.timelineMeta}>
                <span style={styles.timelineDate}>{label}</span>
                <span style={styles.timelineNote}>approximate · page dates</span>
            </div>

            <input
                type="range"
                min={start}
                max={end}
                step={Math.max(1, Math.round((end - start) / 800))}
                value={value}
                onChange={(event) => {
                    onPlaying(false);
                    onChange(Number(event.target.value));
                }}
                style={{ ...styles.slider, flex: 1 }}
                aria-label="Vault history position"
            />

            <span style={{ fontSize: 10.5, color: COSMOS.muted, whiteSpace: "nowrap" }}>
                {new Date(end).getFullYear()}
            </span>

            <button style={styles.iconBtn} onClick={onExit} aria-label="Exit time travel" title="Exit time travel">
                <X size={13} />
            </button>
        </div>
    );
}
