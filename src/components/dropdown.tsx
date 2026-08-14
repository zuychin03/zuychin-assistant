"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

// The listbox is positioned fixed against the trigger's viewport rect rather
// than absolutely inside it: several call sites sit in panels that clip
// overflow, and an absolutely positioned menu is cut off by them.

export interface DropdownOption {
    value: string;
    label?: string;
    disabled?: boolean;
}

export interface DropdownProps {
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<DropdownOption | string>;
    ariaLabel?: string;
    /** Shown only when `value` matches no option. */
    placeholder?: string;
    disabled?: boolean;
    style?: React.CSSProperties;
    className?: string;
    /** Which trigger edge the menu lines up with when it is wider than the trigger. */
    align?: "start" | "end";
}

const MENU_MAX_HEIGHT = 280;
const MENU_GAP = 4;
// Long enough to type a word, short enough that a pause starts a new search.
const TYPEAHEAD_RESET_MS = 700;

function normalize(option: DropdownOption | string): DropdownOption {
    return typeof option === "string" ? { value: option } : option;
}

function labelOf(option: DropdownOption): string {
    return option.label ?? option.value;
}

export function Dropdown({
    value, onChange, options, ariaLabel, placeholder, disabled, style, className, align = "start",
}: DropdownProps) {
    const items = options.map(normalize);
    const selectedIndex = items.findIndex((item) => item.value === value);
    const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [rect, setRect] = useState<{ top: number; left: number; width: number; drop: "down" | "up" } | null>(null);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
    const listId = useId();

    // Defined inside the effect so the listener is its own dependency-free
    // identity; the trigger ref is the only thing it reads.
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const trigger = triggerRef.current;
            if (!trigger) return;
            const box = trigger.getBoundingClientRect();
            const below = window.innerHeight - box.bottom;
            const drop: "down" | "up" = below < Math.min(MENU_MAX_HEIGHT, 160) && box.top > below ? "up" : "down";
            setRect({
                top: drop === "down" ? box.bottom + MENU_GAP : box.top - MENU_GAP,
                left: box.left,
                width: box.width,
                drop,
            });
        };
        place();
        // Reposition rather than close: closing on any ancestor scroll makes the
        // control feel broken inside the scrolling council panels.
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        return () => {
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [open]);

    // Keep the active option in view for keyboard and type-ahead movement.
    useEffect(() => {
        if (!open || activeIndex < 0) return;
        menuRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);

    // Plain functions: the React Compiler handles memoization, and none of
    // these is an effect dependency.
    function openMenu(startAt?: number) {
        if (disabled) return;
        setActiveIndex(startAt ?? (selectedIndex >= 0 ? selectedIndex : 0));
        setOpen(true);
    }

    function closeMenu(refocus = true) {
        setOpen(false);
        setActiveIndex(-1);
        if (refocus) triggerRef.current?.focus();
    }

    function commit(index: number) {
        const item = items[index];
        if (!item || item.disabled) return;
        onChange(item.value);
        closeMenu();
    }

    function step(from: number, direction: 1 | -1): number {
        const count = items.length;
        if (count === 0) return -1;
        let next = from;
        for (let hops = 0; hops < count; hops++) {
            next = (next + direction + count) % count;
            if (!items[next].disabled) return next;
        }
        return from;
    }

    function edge(direction: 1 | -1): number {
        return step(direction === 1 ? -1 : items.length, direction);
    }

    function searchFrom(buffer: string, from: number): number {
        const count = items.length;
        for (let hop = 1; hop <= count; hop++) {
            const index = (from + hop) % count;
            if (items[index].disabled) continue;
            if (labelOf(items[index]).toLowerCase().startsWith(buffer)) return index;
        }
        return -1;
    }

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (disabled) return;
        const key = event.key;

        if (!open) {
            if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
                event.preventDefault();
                openMenu();
            }
            return;
        }

        switch (key) {
            case "Escape":
                event.preventDefault();
                closeMenu();
                return;
            case "Tab":
                // Tab commits nothing; it is a move, not a choice.
                setOpen(false);
                setActiveIndex(-1);
                return;
            case "ArrowDown":
                event.preventDefault();
                setActiveIndex((current) => step(current < 0 ? -1 : current, 1));
                return;
            case "ArrowUp":
                event.preventDefault();
                setActiveIndex((current) => step(current < 0 ? items.length : current, -1));
                return;
            case "Home":
                event.preventDefault();
                setActiveIndex(edge(1));
                return;
            case "End":
                event.preventDefault();
                setActiveIndex(edge(-1));
                return;
            case "Enter":
            case " ":
                event.preventDefault();
                if (activeIndex >= 0) commit(activeIndex);
                return;
        }

        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // The event's own timestamp, not Date.now(): only the delta matters
            // here, and reading a clock during render is impure.
            const now = event.timeStamp;
            const state = typeahead.current;
            state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? key.toLowerCase() : state.buffer + key.toLowerCase();
            state.at = now;
            // A repeated single character cycles matches instead of narrowing.
            const repeated = state.buffer.length > 1 && state.buffer.split("").every((c) => c === state.buffer[0]);
            const needle = repeated ? state.buffer[0] : state.buffer;
            const from = needle === state.buffer && state.buffer.length > 1 ? activeIndex - 1 : activeIndex;
            const found = searchFrom(needle, Math.max(-1, from));
            if (found >= 0) setActiveIndex(found);
        }
    };

    const triggerLabel = selected ? labelOf(selected) : (placeholder ?? "");

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={ariaLabel}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                onClick={() => (open ? closeMenu() : openMenu())}
                onKeyDown={onKeyDown}
                className={className}
                style={{ ...triggerStyle, ...(disabled ? disabledStyle : null), ...style }}
            >
                <span style={valueStyle}>{triggerLabel}</span>
                <ChevronDown
                    size={14}
                    aria-hidden
                    style={{ flexShrink: 0, opacity: 0.65, transform: open ? "rotate(180deg)" : undefined, transition: "transform 120ms ease" }}
                />
            </button>

            {open && rect && (
                <div
                    ref={menuRef}
                    id={listId}
                    role="listbox"
                    aria-label={ariaLabel}
                    tabIndex={-1}
                    onKeyDown={onKeyDown}
                    style={{
                        ...menuStyle,
                        top: rect.drop === "down" ? rect.top : undefined,
                        bottom: rect.drop === "up" ? window.innerHeight - rect.top : undefined,
                        left: align === "start" ? rect.left : undefined,
                        right: align === "end" ? window.innerWidth - (rect.left + rect.width) : undefined,
                        minWidth: rect.width,
                    }}
                >
                    {items.length === 0 && <div style={emptyStyle}>No options</div>}
                    {items.map((item, index) => {
                        const isSelected = item.value === value;
                        const isActive = index === activeIndex;
                        return (
                            <div
                                key={item.value}
                                data-index={index}
                                role="option"
                                aria-selected={isSelected}
                                aria-disabled={item.disabled || undefined}
                                onPointerEnter={() => !item.disabled && setActiveIndex(index)}
                                onClick={() => commit(index)}
                                style={{
                                    ...optionStyle,
                                    ...(isActive ? optionActiveStyle : null),
                                    ...(item.disabled ? optionDisabledStyle : null),
                                }}
                            >
                                <span style={optionLabelStyle}>{labelOf(item)}</span>
                                {isSelected && <Check size={13} aria-hidden style={{ flexShrink: 0, opacity: 0.8 }} />}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}

const triggerStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6,
    flex: "1 1 180px", minWidth: 0, padding: "8px 10px", fontSize: 13,
    borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)",
    background: "color-mix(in srgb, var(--color-background) 60%, transparent)",
    color: "var(--color-text-primary)", fontFamily: "inherit", textAlign: "left",
    cursor: "pointer", appearance: "none",
};

const disabledStyle: React.CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

const valueStyle: React.CSSProperties = {
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
};

const menuStyle: React.CSSProperties = {
    position: "fixed", zIndex: 1000, maxHeight: MENU_MAX_HEIGHT, overflowY: "auto",
    padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)",
    background: "var(--color-background)", color: "var(--color-text-primary)",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.18)", fontSize: 13, fontFamily: "inherit",
};

const optionStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "7px 9px", borderRadius: "var(--radius-sm)", cursor: "pointer",
};

const optionActiveStyle: React.CSSProperties = {
    background: "color-mix(in srgb, var(--color-surface) 85%, transparent)",
};

const optionDisabledStyle: React.CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const optionLabelStyle: React.CSSProperties = {
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const emptyStyle: React.CSSProperties = {
    padding: "7px 9px", color: "var(--color-text-muted)",
};
