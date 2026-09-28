"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { observeAnchoredMenu } from "./anchored-menu";
import styles from "./dropdown.module.css";

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
    id?: string;
    autoFocus?: boolean;
    /** Shown only when `value` matches no option. */
    placeholder?: string;
    disabled?: boolean;
    style?: React.CSSProperties;
    className?: string;
    /** Which trigger edge the menu lines up with when it is wider than the trigger. */
    align?: "start" | "end";
}

const MENU_MAX_HEIGHT = 280;
const TYPEAHEAD_RESET_MS = 700;

function normalize(option: DropdownOption | string): DropdownOption {
    return typeof option === "string" ? { value: option } : option;
}

function labelOf(option: DropdownOption): string {
    return option.label ?? option.value;
}

export function Dropdown({
    value, onChange, options, ariaLabel, id, autoFocus, placeholder, disabled, style, className, align = "start",
}: DropdownProps) {
    const items = options.map(normalize);
    const selectedIndex = items.findIndex((item) => item.value === value);
    const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

    const [open, setOpen] = useState(false);
    const [activeValue, setActiveValue] = useState<string | null>(null);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const enabledSelectedIndex = selectedIndex >= 0 && !items[selectedIndex].disabled ? selectedIndex : -1;
    const requestedIndex = items.findIndex((item) => item.value === activeValue && !item.disabled);
    const activeIndex = requestedIndex >= 0 ? requestedIndex
        : enabledSelectedIndex >= 0 ? enabledSelectedIndex : items.findIndex((item) => !item.disabled);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
    const listId = useId();

    if (open && disabled) setOpen(false);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current || !menuRef.current) return;
        return observeAnchoredMenu(triggerRef.current, menuRef.current, { align, maxHeight: MENU_MAX_HEIGHT });
    }, [open, portalTarget, align, items.length]);

    useEffect(() => {
        if (!open) return;
        const dismissOutside = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
            typeahead.current = { buffer: "", at: 0 };
        };
        document.addEventListener("pointerdown", dismissOutside, true);
        document.addEventListener("focusin", dismissOutside);
        return () => {
            document.removeEventListener("pointerdown", dismissOutside, true);
            document.removeEventListener("focusin", dismissOutside);
        };
    }, [open]);

    useEffect(() => {
        const trigger = triggerRef.current;
        if (!open || !trigger) return;
        const observer = new MutationObserver(() => {
            if (trigger.matches(":disabled")) setOpen(false);
        });
        for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLFieldSetElement) observer.observe(parent, { attributes: true, attributeFilter: ["disabled"] });
        }
        return () => observer.disconnect();
    }, [open]);

    useEffect(() => {
        if (!open || activeIndex < 0) return;
        const menu = menuRef.current;
        const option = menu?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
        if (!menu || !option) return;
        if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
        }
    }, [open, activeIndex]);

    function openMenu(startAt?: number, resetSearch = true) {
        if (disabled || triggerRef.current?.matches(":disabled")) return;
        if (resetSearch) typeahead.current = { buffer: "", at: 0 };
        setActiveValue(items[startAt ?? (enabledSelectedIndex >= 0 ? enabledSelectedIndex : edge(1))]?.value ?? null);
        setPortalTarget(triggerRef.current?.closest("dialog") ?? document.body);
        setOpen(true);
    }

    function closeMenu(refocus = true) {
        setOpen(false);
        setActiveValue(null);
        typeahead.current = { buffer: "", at: 0 };
        if (refocus) triggerRef.current?.focus({ preventScroll: true });
    }

    function commit(index: number) {
        const item = items[index];
        if (!item || item.disabled) return;
        if (disabled || triggerRef.current?.matches(":disabled")) { closeMenu(false); return; }
        if (item.value !== value) onChange(item.value);
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
        return -1;
    }

    function edge(direction: 1 | -1): number {
        return step(direction === 1 ? -1 : items.length, direction);
    }

    function searchFrom(buffer: string, from: number): number {
        const count = items.length;
        for (let hop = 1; hop <= count; hop++) {
            const index = (from + hop) % count;
            if (items[index].disabled) continue;
            if (labelOf(items[index]).toLocaleLowerCase().startsWith(buffer)) return index;
        }
        return -1;
    }

    function activate(index: number) {
        setActiveValue(items[index]?.value ?? null);
    }

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (disabled || triggerRef.current?.matches(":disabled") || event.nativeEvent.isComposing) return;
        const key = event.key;
        const now = event.timeStamp;
        const hasSearch = typeahead.current.buffer.length > 0 && now - typeahead.current.at <= TYPEAHEAD_RESET_MS;

        if (!open) {
            if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
                event.preventDefault();
                openMenu(enabledSelectedIndex >= 0 ? enabledSelectedIndex : edge(key === "ArrowUp" ? -1 : 1));
                return;
            }
            if (key === "Home" || key === "End") {
                event.preventDefault();
                openMenu(edge(key === "Home" ? 1 : -1));
                return;
            }
        } else switch (key) {
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                return;
            case "Tab":
                closeMenu(false);
                return;
            case "ArrowDown":
                event.preventDefault();
                activate(step(activeIndex, 1));
                return;
            case "ArrowUp":
                event.preventDefault();
                if (event.altKey) closeMenu();
                else activate(step(activeIndex < 0 ? items.length : activeIndex, -1));
                return;
            case "Home":
                event.preventDefault();
                activate(edge(1));
                return;
            case "End":
                event.preventDefault();
                activate(edge(-1));
                return;
            case "Enter":
            case " ":
                if (key === " " && hasSearch) break;
                event.preventDefault();
                if (activeIndex >= 0) commit(activeIndex);
                return;
        }

        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const state = typeahead.current;
            state.buffer = hasSearch ? state.buffer + key.toLocaleLowerCase() : key.toLocaleLowerCase();
            state.at = now;
            const repeated = state.buffer.length > 1 && state.buffer.split("").every((c) => c === state.buffer[0]);
            const needle = repeated ? state.buffer[0] : state.buffer;
            const from = needle === state.buffer && state.buffer.length > 1 ? activeIndex - 1 : activeIndex;
            const found = searchFrom(needle, Math.max(-1, from));
            if (found >= 0) {
                if (open) activate(found);
                else openMenu(found, false);
            }
        }
    };

    const triggerLabel = selected ? labelOf(selected) : (placeholder ?? "Select an option");
    const accessibleLabel = ariaLabel || placeholder || "Select an option";

    return (
        <>
            <button
                ref={triggerRef}
                id={id}
                autoFocus={autoFocus}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
                aria-label={accessibleLabel}
                aria-disabled={disabled || undefined}
                disabled={disabled}
                onClick={() => (open ? closeMenu() : openMenu())}
                onKeyDown={onKeyDown}
                className={[styles.trigger, className].filter(Boolean).join(" ")}
                style={{ ...triggerStyle, ...(disabled ? disabledStyle : null), ...style }}
            >
                <span style={valueStyle} title={triggerLabel}>{triggerLabel}</span>
                <ChevronDown
                    size={14}
                    aria-hidden
                    className={styles.chevron}
                />
            </button>

            {open && portalTarget && createPortal(
                <div
                    ref={menuRef}
                    id={listId}
                    role="listbox"
                    aria-label={accessibleLabel}
                    tabIndex={-1}
                    onKeyDown={onKeyDown}
                    onMouseDown={(event) => event.preventDefault()}
                    style={menuStyle}
                >
                    {items.length === 0 && <div role="status" style={emptyStyle}>No options available</div>}
                    {items.map((item, index) => {
                        const isSelected = item.value === value;
                        const isActive = index === activeIndex;
                        return (
                            <div
                                key={`${item.value}-${index}`}
                                id={`${listId}-option-${index}`}
                                data-index={index}
                                role="option"
                                aria-selected={isSelected}
                                aria-disabled={item.disabled || undefined}
                                onPointerMove={(event) => event.pointerType === "mouse" && !item.disabled && activate(index)}
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
                </div>,
                portalTarget,
            )}
        </>
    );
}

const triggerStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6,
    minWidth: 0, padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
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
    width: "max-content", boxSizing: "border-box", visibility: "hidden", overscrollBehavior: "contain",
    padding: 4, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)",
    background: "var(--color-background)", color: "var(--color-text-primary)",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.18)", fontSize: 13, fontFamily: "var(--font-family)",
};

const optionStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    minHeight: 44, padding: "9px", borderRadius: "var(--radius-sm)", cursor: "pointer",
};

const optionActiveStyle: React.CSSProperties = {
    background: "color-mix(in srgb, var(--color-surface) 85%, transparent)",
    outline: "2px solid var(--color-primary)", outlineOffset: -2,
};

const optionDisabledStyle: React.CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const optionLabelStyle: React.CSSProperties = {
    minWidth: 0, overflowWrap: "anywhere", whiteSpace: "normal",
};

const emptyStyle: React.CSSProperties = {
    padding: "7px 9px", color: "var(--color-text-muted)",
};
