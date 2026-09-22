"use client";

import { useState, useRef, useEffect, useId } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { styles } from "./styles";
import { filterModelGroups, nextModelOption, type ModelPickerGroup } from "./model-picker";
import controlStyles from "./model-controls.module.css";

export { modelSearchTerms } from "./model-picker";

export interface ModelMeta {
  developer: string;
  description: string;
  inputs: string[];
  context?: string;
  maxOutput?: string;
  params?: string;
  strengths: string[];
}
export interface ProviderModel {
  id: string;
  label: string;
  dimension?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsSearch?: boolean;
  supportsStructuredOutput?: boolean;
  /** Verified output-token ceiling; bounds the max-tokens slider. */
  maxOutputTokens?: number;
  meta?: ModelMeta | null;
}
export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  chatModelAliases?: Record<string, string>;
  chatModels: ProviderModel[];
  embeddingModels: ProviderModel[];
}

export function SelectMenu({
  icon, groups, value, onChange, ariaLabel, align = "left", compact = false, dropUp = false, wide = false, integrated = false, searchable = false,
}: {
  icon: React.ReactNode;
  groups: ModelPickerGroup[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  align?: "left" | "right";
  compact?: boolean;
  dropUp?: boolean;
  /** Lifts the trigger/menu width caps so long labels are not truncated. */
  wide?: boolean;
  /** Uses the selector as the leading part of a related control group. */
  integrated?: boolean;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filteredGroups = filterModelGroups(groups, query);
  const options = filteredGroups.flatMap((group) => group.options);
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === activeValue));
  const activeOption = options[activeIndex];
  const optionId = (index: number) => `${listId}-option-${index}`;

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const openMenu = (edge?: "first" | "last") => {
    setQuery("");
    const allOptions = groups.flatMap((group) => group.options);
    setActiveValue(edge === "last" ? allOptions.at(-1)?.value ?? ""
      : edge === "first" ? allOptions[0]?.value ?? "" : value || allOptions[0]?.value || "");
    setOpen(true);
  };

  const selectOption = (selected: string) => {
    onChange(selected);
    closeMenu(true);
  };

  const handleNavigation = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      const next = nextModelOption(activeIndex, options.length, event.key);
      if (options[next]) setActiveValue(options[next].value);
    } else if (event.key === "Enter" || (!searchable && event.key === " ")) {
      event.preventDefault();
      if (activeOption) selectOption(activeOption.value);
    }
  };

  useEffect(() => {
    if (!open) return;
    (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        const focusTarget = e.target instanceof Element && e.target.closest("button, a[href], input, select, textarea, [tabindex], [contenteditable=true]");
        if (!focusTarget) triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open, searchable]);

  useEffect(() => {
    if (open && activeOption) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, activeOption, listId]);

  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

  return (
    <div
      ref={ref}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
      }}
      style={{ ...dropdown.wrap, ...(compact ? { flex: 1, maxWidth: "none" } : {}), ...(wide ? { maxWidth: "none" } : {}), ...(integrated ? dropdown.wrapIntegrated : {}) }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={controlStyles.control}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" || event.key === "End" ? "last" : event.key === "Home" ? "first" : undefined);
          }
        }}
        style={{ ...dropdown.trigger, ...(compact ? { width: "100%" } : {}), ...(integrated ? dropdown.triggerIntegrated : {}), ...(open ? dropdown.triggerOpen : {}) }}
        aria-label={`${ariaLabel}: ${current?.label ?? "Select"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={current?.label}
      >
        <span style={dropdown.triggerIcon}>{icon}</span>
        <span style={dropdown.triggerLabel}>{current?.label ?? "Select"}</span>
        <ChevronDown
          size={14}
          style={{ flexShrink: 0, opacity: 0.5, transform: (dropUp ? !open : open) ? "rotate(180deg)" : "none", transition: "transform .18s ease" }}
        />
      </button>
      {open && (
        <div
          style={{
            ...dropdown.menu,
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            ...(dropUp ? { top: "auto", bottom: "calc(100% + 6px)" } : {}),
          }}
          className="animate-fade-in-scale"
        >
          {searchable && (
            <div style={dropdown.searchWrap}>
              <Search size={15} aria-hidden="true" style={{ flexShrink: 0, color: "var(--color-text-muted)" }} />
              <input
                ref={searchRef}
                role="combobox"
                type="text"
                className={controlStyles.search}
                style={dropdown.search}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveValue("");
                }}
                onKeyDown={handleNavigation}
                aria-label={`Search ${ariaLabel.toLowerCase()}s`}
                aria-controls={listId}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
                placeholder="Search models or capabilities"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            aria-activedescendant={!searchable && activeOption ? optionId(activeIndex) : undefined}
            tabIndex={searchable ? undefined : 0}
            onKeyDown={searchable ? undefined : handleNavigation}
            style={dropdown.options}
          >
            {filteredGroups.map((group, groupIndex) => (
              <div key={group.label} role="group" aria-labelledby={`${listId}-group-${groupIndex}`} style={dropdown.group}>
                <div id={`${listId}-group-${groupIndex}`} style={dropdown.groupLabel}>{group.label}</div>
                {group.options.map((option) => {
                  const index = options.indexOf(option);
                  return (
                    <button
                      key={option.value}
                      id={optionId(index)}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={option.value === value}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerMove={() => setActiveValue(option.value)}
                      onClick={() => selectOption(option.value)}
                      style={{ ...dropdown.item, ...(option.value === value ? dropdown.itemActive : {}), ...(index === activeIndex ? dropdown.itemFocused : {}) }}
                    >
                      <span style={dropdown.itemLabel}>{option.label}</span>
                      {option.value === value && <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {searchable && (
            <p role="status" aria-live="polite" style={dropdown.resultStatus}>
              {options.length ? `${options.length} model${options.length === 1 ? "" : "s"}` : "No matching models. Try a model or provider name, or a capability such as vision."}
            </p>
          )}
          {!searchable && !options.length && <p style={dropdown.resultStatus}>No models available.</p>}
        </div>
      )}
    </div>
  );
}

export function ParamRow({
  label, value, min, max, step, def, onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  def: number;
  onChange: (v: number | null) => void;
}) {
  const active = value !== null;
  return (
    <div style={paramRow.wrap}>
      <div style={paramRow.top}>
        <span style={paramRow.label}>{label}</span>
        <div style={paramRow.right}>
          <span style={{ ...paramRow.value, opacity: active ? 1 : 0.5 }}>
            {active ? value : "Auto"}
          </span>
          <button
            type="button"
            onClick={() => onChange(active ? null : def)}
            style={{ ...paramRow.toggle, ...(active ? paramRow.toggleOn : {}) }}
          >
            {active ? "Custom" : "Auto"}
          </button>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={active ? value : def}
        disabled={!active}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ ...paramRow.slider, opacity: active ? 1 : 0.4 }}
      />
    </div>
  );
}

const STRENGTH_COLORS: Record<string, string> = {
  Coding: "#8b5cf6", Code: "#8b5cf6", Reasoning: "#3b82f6", Agentic: "#ec4899",
  Math: "#f59e0b", Science: "#10b981", Multimodal: "#a855f7", Vision: "#06b6d4",
  Multilingual: "#14b8a6", "Long context": "#6366f1", "Tool use": "#0ea5e9",
  Fast: "#22c55e", Video: "#f43f5e", Knowledge: "#eab308", Research: "#d946ef",
  "Document RAG": "#f97316", Retrieval: "#0ea5e9", "High throughput": "#84cc16",
  "Visual documents": "#f97316",
};
const strengthColor = (s: string) => STRENGTH_COLORS[s] ?? "#94a3b8";

export function ModelInfoModal({
  model, providerLabel, onClose,
}: {
  model: ProviderModel;
  providerLabel: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const meta = model.meta;
  const specs: { label: string; value: string }[] = [];
  if (meta?.context) specs.push({ label: "Context", value: meta.context });
  if (meta?.maxOutput) specs.push({ label: "Max output", value: meta.maxOutput });
  if (meta?.params) specs.push({ label: "Parameters", value: meta.params });
  if (model.dimension) specs.push({ label: "Dimensions", value: String(model.dimension) });

  const caps: string[] = [];
  if (model.supportsTools) caps.push("Tools");
  if (model.supportsVision) caps.push("Vision");
  if (model.supportsThinking) caps.push("Reasoning toggle");
  if (model.supportsSearch) caps.push("Web search");
  if (model.supportsStructuredOutput) caps.push("Structured output");

  return (
    <dialog
      ref={dialogRef}
      className={controlStyles.modelDialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={modal.card} className="animate-fade-in-scale">
        <div style={modal.header}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={modal.title}>{model.label}</h2>
            <p style={modal.subtitle}>
              {providerLabel}{meta?.developer ? ` · ${meta.developer}` : ""}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} style={styles.iconBtn} className={controlStyles.control} aria-label="Close model details">
            <X size={18} color="var(--color-text-muted)" />
          </button>
        </div>

        <p id={descriptionId} style={modal.desc}>{meta?.description || "No details available for this model yet."}</p>

        {specs.length > 0 && (
          <div style={modal.specGrid}>
            {specs.map((s) => (
              <div key={s.label} style={modal.spec}>
                <span style={modal.specLabel}>{s.label}</span>
                <span style={modal.specValue}>{s.value}</span>
              </div>
            ))}
          </div>
        )}

        {meta?.inputs && meta.inputs.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Inputs</span>
            <div style={modal.tagRow}>
              {meta.inputs.map((i) => (
                <span key={i} style={modal.plainTag}>{i}</span>
              ))}
            </div>
          </div>
        )}

        {caps.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Capabilities</span>
            <div style={modal.tagRow}>
              {caps.map((c) => (
                <span key={c} style={modal.plainTag}>{c}</span>
              ))}
            </div>
          </div>
        )}

        {meta?.strengths && meta.strengths.length > 0 && (
          <div style={modal.section}>
            <span style={modal.sectionLabel}>Excels at</span>
            <div style={modal.tagRow}>
              {meta.strengths.map((s) => (
                <span key={s} style={modal.strengthTag}>
                  <span style={{ ...modal.dot, background: strengthColor(s) }} />
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

export function ConfirmModal({
  title, body, confirmLabel, busyText, onConfirm, onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** When set, the modal is locked into a progress view (no buttons, no dismiss). */
  busyText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);
  const dismissedRef = useRef(false);
  // The opening render disables the source button before effects run.
  const [previousFocus] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      requestAnimationFrame(() => {
        if (!dialog?.open && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      });
    };
  }, [previousFocus]);

  useEffect(() => {
    if (busyText) dialogRef.current?.focus({ preventScroll: true });
    else confirmingRef.current = false;
  }, [busyText]);

  const cancel = () => {
    if (busyText || confirmingRef.current || dismissedRef.current) return;
    dismissedRef.current = true;
    onCancel();
  };
  const confirm = () => {
    if (busyText || confirmingRef.current || dismissedRef.current) return;
    confirmingRef.current = true;
    onConfirm();
  };

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className={controlStyles.modelDialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      aria-busy={!!busyText}
      onCancel={(event) => { event.preventDefault(); cancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}
    >
      <div style={modal.card} className="animate-fade-in-scale">
        <div style={modal.header}>
          <h2 id={titleId} style={modal.title}>{title}</h2>
          {!busyText && (
            <button type="button" onClick={cancel} style={styles.iconBtn} className={controlStyles.control} aria-label="Close">
              <X size={18} color="var(--color-text-muted)" />
            </button>
          )}
        </div>
        <p id={descriptionId} style={modal.desc}>{body}</p>
        {busyText ? (
          <p role="status" style={{ ...modal.desc, color: "var(--color-primary)", fontWeight: 600 }}>{busyText}</p>
        ) : (
          <div style={confirmRow}>
            <button ref={cancelRef} type="button" onClick={cancel} style={confirmCancelBtn} className={controlStyles.control}>Cancel</button>
            <button type="button" onClick={confirm} style={confirmDangerBtn} className={controlStyles.control}>{confirmLabel}</button>
          </div>
        )}
      </div>
    </dialog>
  );
}

const confirmRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  marginTop: 16,
};
const confirmBtnBase: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "var(--font-family)",
};
const confirmCancelBtn: React.CSSProperties = {
  ...confirmBtnBase,
  border: "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-text-primary)",
};
const confirmDangerBtn: React.CSSProperties = {
  ...confirmBtnBase,
  border: "none",
  background: "#ef4444",
  color: "#fff",
};

const dropdown: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative",
    minWidth: 0,
    flexShrink: 1,
    maxWidth: 220,
  },
  wrapIntegrated: {
    flex: 1,
    maxWidth: "none",
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    maxWidth: "100%",
    padding: "7px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    cursor: "pointer",
    color: "var(--color-text-primary)",
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    transition: "border-color 0.15s ease, background 0.15s ease",
  },
  triggerIntegrated: {
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: 9,
  },
  triggerOpen: {
    border: "1px solid var(--color-primary)",
  },
  triggerIcon: {
    display: "flex",
    flexShrink: 0,
  },
  triggerLabel: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,

    flex: 1,
    textAlign: "left",
  },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    zIndex: 50,
    width: "100%",
    minWidth: 240,
    maxWidth: "calc(100vw - 20px)",
    maxHeight: "min(420px, 65dvh)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: 6,
    boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
  },
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 8px 10px",
    borderBottom: "1px solid var(--color-border)",
    flexShrink: 0,
  },
  search: {
    width: "100%",
    minWidth: 0,
    padding: "5px 2px",
    border: "none",
    borderRadius: 3,
    background: "transparent",
    color: "var(--color-text-primary)",
    fontSize: 16,
    fontFamily: "var(--font-family)",
  },
  options: {
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: 2,
  },
  resultStatus: {
    padding: "8px 10px 4px",
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--color-text-muted)",
    flexShrink: 0,
  },
  group: {
    marginBottom: 2,
  },
  groupLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    padding: "8px 10px 4px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    minHeight: 44,
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    color: "var(--color-text-primary)",
    fontSize: 13,
    fontFamily: "var(--font-family)",
    textAlign: "left",
    transition: "background 0.12s ease",
  },
  itemActive: {
    background: "var(--color-surface)",
    color: "var(--color-text-primary)",
    fontWeight: 600,
  },
  itemFocused: {
    outline: "2px solid var(--color-primary)",
    outlineOffset: -2,
    background: "var(--color-surface)",
  },
  itemLabel: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
};

const paramRow: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  top: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    fontSize: 12.5,
    fontWeight: 500,
    color: "var(--color-text-primary)",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  value: {
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    color: "var(--color-text-muted)",
    minWidth: 36,
    textAlign: "right",
  },
  toggle: {
    fontSize: 11,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    padding: "3px 9px",
    borderRadius: 999,
    border: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-muted)",
    cursor: "pointer",
  },
  toggleOn: {
    background: "var(--color-primary)",
    border: "1px solid var(--color-primary)",
    color: "var(--color-primary-foreground)",
  },
  slider: {
    width: "100%",
    accentColor: "var(--color-primary)",
    cursor: "pointer",
  },
};

const modal: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    background: "rgba(0, 0, 0, 0.45)",
    backdropFilter: "blur(3px)",
    WebkitBackdropFilter: "blur(3px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "85dvh",
    overflowY: "auto",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 18,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,0.30)",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--color-text-primary)",
    letterSpacing: "-0.2px",
  },
  subtitle: {
    fontSize: 12.5,
    color: "var(--color-text-muted)",
    marginTop: 2,
  },
  desc: {
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "var(--color-text-primary)",
    opacity: 0.9,
  },
  specGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 8,
  },
  spec: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "10px 12px",
    background: "var(--color-surface)",
    borderRadius: 10,
  },
  specLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
  },
  specValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
  },
  tagRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
  },
  plainTag: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 999,
    padding: "4px 11px",
  },
  strengthTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 999,
    padding: "4px 11px 4px 9px",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
};
