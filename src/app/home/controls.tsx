"use client";

// Presentational controls for the Home chat page: grouped model dropdown,
// generation-parameter row and the model-details modal.

import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { styles } from "./styles";

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
  meta?: ModelMeta | null;
}
export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  chatModels: ProviderModel[];
  embeddingModels: ProviderModel[];
}

export function SelectMenu({
  icon, groups, value, onChange, ariaLabel, align = "left", compact = false, dropUp = false, wide = false,
}: {
  icon: React.ReactNode;
  groups: { label: string; options: { value: string; label: string }[] }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  align?: "left" | "right";
  compact?: boolean;
  dropUp?: boolean;
  /** Lifts the trigger/menu width caps so long labels are not truncated. */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

  return (
    <div ref={ref} style={{ ...dropdown.wrap, ...(compact ? { flex: 1, maxWidth: "none" } : {}), ...(wide ? { maxWidth: "none" } : {}) }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...dropdown.trigger, ...(compact ? { width: "100%" } : {}), ...(open ? dropdown.triggerOpen : {}) }}
        aria-label={ariaLabel}
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
            ...(wide ? { maxWidth: "min(380px, calc(100vw - 20px))" } : {}),
          }}
          className="animate-fade-in-scale"
        >
          {groups.map((g) => (
            <div key={g.label} style={dropdown.group}>
              <div style={dropdown.groupLabel}>{g.label}</div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  style={{ ...dropdown.item, ...(o.value === value ? dropdown.itemActive : {}) }}
                >
                  <span style={dropdown.itemLabel}>{o.label}</span>
                  {o.value === value && <Check size={14} style={{ flexShrink: 0 }} />}
                </button>
              ))}
            </div>
          ))}
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

  return (
    <div style={modal.overlay} className="animate-overlay-in" onClick={onClose}>
      <div style={modal.card} className="animate-fade-in-scale" onClick={(e) => e.stopPropagation()}>
        <div style={modal.header}>
          <div style={{ minWidth: 0 }}>
            <h2 style={modal.title}>{model.label}</h2>
            <p style={modal.subtitle}>
              {providerLabel}{meta?.developer ? ` · ${meta.developer}` : ""}
            </p>
          </div>
          <button onClick={onClose} style={styles.iconBtn} aria-label="Close">
            <X size={18} color="var(--color-text-muted)" />
          </button>
        </div>

        {meta?.description && <p style={modal.desc}>{meta.description}</p>}

        {!meta && <p style={modal.desc}>No details available for this model yet.</p>}

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
    </div>
  );
}

const dropdown: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative",
    minWidth: 0,
    flexShrink: 1,
    maxWidth: 220,
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
    minWidth: 200,
    maxWidth: "min(280px, calc(100vw - 20px))",
    maxHeight: 360,
    overflowY: "auto",
    background: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: 6,
    boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
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
