"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { observeAnchoredMenu } from "@/components/anchored-menu";
import { X } from "lucide-react";
import { styles } from "./styles";
import modeStyles from "./chat-modes.module.css";

export function GenerationSettings({ children, triggerRef, onClose }: {
    children: ReactNode; triggerRef: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (!triggerRef.current || !panelRef.current) return;
        return observeAnchoredMenu(triggerRef.current, panelRef.current, { align: "end", minWidth: 360, maxHeight: 680, gap: 8 });
    }, [triggerRef]);
    useEffect(() => {
        const panel = panelRef.current;
        const trigger = triggerRef.current;
        if (!panel) return;
        panel.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        const nestedMenu = (target: EventTarget | null) => target instanceof Element && !!target.closest('[data-model-options="generation-settings"]');
        const outside = (event: PointerEvent) => {
            if (!panel.contains(event.target as Node) && !trigger?.contains(event.target as Node) && !nestedMenu(event.target)) onClose();
        };
        document.addEventListener("pointerdown", outside);
        return () => {
            document.removeEventListener("pointerdown", outside);
            if (panel.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
        };
    }, [onClose, triggerRef]);
    return createPortal(<div ref={panelRef} id="generation-settings" data-menu-owner="generation-settings" role="dialog" aria-labelledby="generation-settings-title"
        style={styles.modelSettingsPopover} className={modeStyles.panel}
        onBlur={(event) => {
            const next = event.relatedTarget;
            if (next && !event.currentTarget.contains(next as Node) && next !== triggerRef.current
                && !(next instanceof Element && next.closest('[data-model-options="generation-settings"]'))) onClose();
        }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
        <div className={modeStyles.heading}>
            <h2 id="generation-settings-title">Generation settings</h2>
            <button type="button" onClick={onClose} className={modeStyles.close} aria-label="Close generation settings"><X size={16} aria-hidden="true" /></button>
        </div>
        {children}
    </div>, document.body);
}

export function ModeToggle({ label, checked, disabled, onChange, title, icon }: {
    label: string; checked: boolean; disabled?: boolean; onChange: () => void; title?: string; icon: ReactNode;
}) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={onChange} title={title} className={modeStyles.toggle}>
        <span className={modeStyles.label}>{icon}{label}</span>
        <span className={modeStyles.track} aria-hidden="true"><span /></span>
    </button>;
}
