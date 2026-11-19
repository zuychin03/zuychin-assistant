"use client";

import { useEffect, useRef } from "react";
import styles from "./zuychin-mark.module.css";

/** still: no motion. idle: blinks now and then. thinking: the lens turns. writing, speaking: the lens pulses. */
export type MarkState = "still" | "idle" | "thinking" | "writing" | "speaking";

type Props = {
    size?: number;
    className?: string;
    state?: MarkState;
    /** The eye follows the pointer and a tap pokes it. */
    follow?: boolean;
};

// The glint in the logo's eye sits up and to the left.
const GLINT_ANGLE = -128;
// Room between the eye and its ring, in logo units.
const LOOK_RANGE = 15;

// Paths from public/zuychin-logo.svg, split so the eye and the side arms can move on their own.
export function ZuychinMark({ size = 22, className, state = "still", follow = false }: Props) {
    const ref = useRef<SVGSVGElement>(null);

    useEffect(() => {
        const svg = ref.current;
        if (!follow || !svg || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        let frame = 0;
        let x = 0;
        let y = 0;
        let inside = false;
        let glint = 0;
        const apply = () => {
            frame = 0;
            if (!inside) {
                svg.style.setProperty("--look-x", "0px");
                svg.style.setProperty("--look-y", "0px");
                return;
            }
            const box = svg.getBoundingClientRect();
            const dx = x - (box.left + box.width / 2);
            const dy = y - (box.top + box.height / 2);
            const distance = Math.hypot(dx, dy) || 1;
            const reach = Math.min(1, distance / 160) * LOOK_RANGE;
            svg.style.setProperty("--look-x", `${(dx / distance) * reach}px`);
            svg.style.setProperty("--look-y", `${(dy / distance) * reach}px`);
            // Turn the shortest way, so crossing behind the mark never spins the eye all the way round.
            const target = (Math.atan2(dy, dx) * 180) / Math.PI - GLINT_ANGLE;
            glint += ((((target - glint) % 360) + 540) % 360) - 180;
            svg.style.setProperty("--glint", `${glint.toFixed(1)}deg`);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
        const onMove = (e: PointerEvent) => {
            x = e.clientX;
            y = e.clientY;
            inside = true;
            schedule();
        };
        const onLeave = () => {
            inside = false;
            schedule();
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("pointermove", onMove);
            document.documentElement.removeEventListener("pointerleave", onLeave);
        };
    }, [follow]);

    const poke = () => {
        const svg = ref.current;
        if (!svg) return;
        // Restart the poke animation even mid-way through.
        svg.removeAttribute("data-poke");
        void svg.getBoundingClientRect();
        svg.setAttribute("data-poke", "");
    };

    return (
        <svg
            ref={ref}
            viewBox="140 135 974 650"
            width={Math.round(size * 1.28)}
            height={size}
            className={`${styles.mark} ${className ?? ""}`}
            data-state={state}
            data-follow={follow || undefined}
            aria-hidden="true"
            fill="currentColor"
            fillRule="evenodd"
            onPointerDown={follow ? poke : undefined}
            onAnimationEnd={(e) => { if (e.animationName.includes("poke")) e.currentTarget.removeAttribute("data-poke"); }}
        >
            <g className={styles.body}>
            <path d="M394.68 144.58L859.32 144.58L925.65 224.5L782.84 456.04A156 156 0 0 0 745.3 361.31L832.08 220.61L421.92 220.61L495.44 339.81L399.46 339.81L328.35 224.5Z" />
            <path d="M859.32 781.42L394.68 781.42L328.35 701.5L471.16 469.96A156 156 0 0 0 508.7 564.69L421.92 705.39L832.08 705.39L758.56 586.19L854.54 586.19L925.65 701.5Z" />
            <path className={styles.armLeft} d="M330.74 274.69L374.19 345.14L337.84 388.93L337.84 537.07L374.19 580.86L330.74 651.31L268.16 575.9V487.51H230.11V504.91Q230.11 516.91 218.11 516.91H156.78Q144.78 516.91 144.78 504.91V421.09Q144.78 409.09 156.78 409.09H218.11Q230.11 409.09 230.11 421.09V438.49H268.16L268.16 350.1Z" />
            <path className={styles.armRight} d="M923.26 274.69L879.81 345.14L916.16 388.93L916.16 537.07L879.81 580.86L923.26 651.31L985.84 575.9V487.51H1023.89V504.91Q1023.89 516.91 1035.89 516.91H1097.22Q1109.22 516.91 1109.22 504.91V421.09Q1109.22 409.09 1097.22 409.09H1035.89Q1023.89 409.09 1023.89 421.09V438.49H985.84L985.84 350.1Z" />
            <path d="M767 463A140 140 0 1 1 487 463A140 140 0 1 1 767 463ZM739 463A112 112 0 1 0 515 463A112 112 0 1 0 739 463Z" />
            <g className={styles.look}>
                <g className={styles.lid}>
                    <path className={styles.eye} d="M722 463A95 95 0 1 1 532 463A95 95 0 1 1 722 463ZM617 404C617 410 610 412 603 414C584 423 573 436 571 451C569 463 551 462 554 448C562 421 579 403 602 395C610 391 617 396 617 404Z" />
                </g>
            </g>
            </g>
        </svg>
    );
}
