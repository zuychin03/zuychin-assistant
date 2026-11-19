"use client";

import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { ArrowUp, SkipForward, X } from "lucide-react";
import { VoiceConstellation, parseColour, type VoicePhase } from "./voice-constellation";
import styles from "./voice-stage.module.css";

const PHASE_LABEL: Record<VoicePhase, string> = {
    idle: "Voice chat",
    listening: "Listening",
    transcribing: "Transcribing",
    thinking: "Thinking",
    tools: "Using tools",
    speaking: "Speaking",
};

// With reduced motion the frame is still, redrawn this often so the core can show loudness.
const STILL_FRAME_MS = 120;

type Props = {
    phase: VoicePhase;
    /** What the running tool is doing, shown while using tools. */
    activity: string | null;
    /** Mic or speaker loudness, 0 to 1; read every frame. */
    readLevel: () => number;
    stopPhrase: string;
    onSendNow: () => void;
    onSkip: () => void;
    onEnd: () => void;
};

/** Replaces the composer while a voice chat runs. */
export function VoiceStage({ phase, activity, readLevel, stopPhrase, onSendNow, onSkip, onEnd }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const endRef = useRef<HTMLButtonElement>(null);
    const sceneRef = useRef<VoiceConstellation | null>(null);
    const phaseRef = useRef(phase);
    const readLevelRef = useRef(readLevel);

    useEffect(() => {
        phaseRef.current = phase;
        readLevelRef.current = readLevel;
    });

    // The mic button that started the chat is hidden with the composer, so keyboard focus moves here.
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active.closest("[hidden]")) endRef.current?.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const scene = new VoiceConstellation();
        sceneRef.current = scene;

        const readPalette = () => {
            const css = getComputedStyle(canvas);
            const ink = parseColour(css.getPropertyValue("--ink"));
            const accent = parseColour(css.getPropertyValue("--accent"));
            if (ink && accent) scene.setPalette({ ink, accent, dark: document.documentElement.dataset.theme === "dark" });
        };
        readPalette();
        const themeWatch = new MutationObserver(readPalette);
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

        let width = 0;
        let height = 0;
        const resize = () => {
            const box = canvas.getBoundingClientRect();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            width = box.width;
            height = box.height;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const sizeWatch = new ResizeObserver(resize);
        sizeWatch.observe(canvas);

        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let frame = 0;
        let last = performance.now();
        const tick = (now: number) => {
            frame = requestAnimationFrame(tick);
            const still = motion.matches;
            if (still && now - last < STILL_FRAME_MS) return;
            const dt = Math.min(still ? STILL_FRAME_MS / 1000 : 0.05, (now - last) / 1000);
            last = now;
            scene.update(dt, width, height, phaseRef.current, readLevelRef.current(), still);
            scene.draw(ctx);
        };
        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            sizeWatch.disconnect();
            themeWatch.disconnect();
            sceneRef.current = null;
        };
    }, []);

    const point = (e: PointerEvent<HTMLCanvasElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        return [e.clientX - box.left, e.clientY - box.top] as const;
    };

    const detail = {
        idle: "Starting the mic",
        listening: `Say “${stopPhrase}” to end`,
        transcribing: "Writing down what you said",
        thinking: "Working on a reply",
        tools: activity ?? "Working on a reply",
        speaking: "Listening again after this reply",
    }[phase];

    return (
        <section className={styles.stage} aria-label="Voice chat">
            <canvas
                ref={canvasRef}
                className={styles.sky}
                aria-hidden="true"
                onPointerMove={(e) => sceneRef.current?.setPointer(...point(e))}
                onPointerDown={(e) => sceneRef.current?.tap(...point(e))}
                onPointerUp={(e) => { if (e.pointerType !== "mouse") sceneRef.current?.clearPointer(); }}
                onPointerLeave={() => sceneRef.current?.clearPointer()}
                onPointerCancel={() => sceneRef.current?.clearPointer()}
            />
            <div className={styles.bar}>
                <div className={styles.text}>
                    <strong key={phase} className={styles.state}>{PHASE_LABEL[phase]}</strong>
                    <span className={styles.detail}>{detail}</span>
                </div>
                {phase === "listening" && (
                    <button type="button" className={styles.button} onClick={onSendNow} aria-label="Send now" title="Send what was captured (silence sends automatically)">
                        <ArrowUp size={14} aria-hidden="true" /><span className={styles.buttonLabel}>Send now</span>
                    </button>
                )}
                {phase === "speaking" && (
                    <button type="button" className={styles.button} onClick={onSkip} aria-label="Skip" title="Stop this reply and listen again">
                        <SkipForward size={14} aria-hidden="true" /><span className={styles.buttonLabel}>Skip</span>
                    </button>
                )}
                <button ref={endRef} type="button" className={styles.button} onClick={onEnd} aria-label="End voice chat" title="End voice chat">
                    <X size={14} aria-hidden="true" /><span className={styles.buttonLabel}>End</span>
                </button>
            </div>
        </section>
    );
}
