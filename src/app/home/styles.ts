import type { CSSProperties } from "react";

export const styles: Record<string, CSSProperties> = {
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 8,
    border: "none",
    borderRadius: 8,
    background: "none",
    color: "var(--muted)",
    cursor: "pointer",
    transition: "background 0.15s ease",
  },

  modelSettingsPopover: {
    position: "fixed",
    zIndex: 900,
    visibility: "hidden",
    boxSizing: "border-box",
    width: "min(360px, calc(100vw - 24px))",
    padding: "14px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    borderRadius: 12,
    background: "var(--surface)",
    border: "1px solid var(--line)",
    boxShadow: "var(--shadow-pop)",
    color: "var(--ink)",
  },

  settingsNote: {
    margin: 0,
    fontSize: 12.5,
    color: "var(--muted)",
    lineHeight: 1.45,
  },

  settingsEmbedRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    paddingTop: 12,
    borderTop: "1px solid var(--line)",
  },

  settingsEmbedLabel: {
    fontSize: 13,
    color: "var(--muted)",
    flexShrink: 0,
  },

  proposalCard: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxWidth: 600,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid var(--line)",
    background: "var(--surface)",
  },

  proposalHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  proposalKicker: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--ink-2)",
  },

  proposalType: {
    marginLeft: "auto",
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--muted)",
    background: "var(--raised)",
    border: "1px solid var(--line)",
    borderRadius: 999,
  },

  proposalTopic: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.4,
    color: "var(--ink)",
  },

  proposalBrief: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    color: "var(--ink-2)",
  },

  proposalMore: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    alignSelf: "flex-start",
    padding: 0,
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    color: "var(--accent-text)",
    background: "none",
    border: "none",
    cursor: "pointer",
  },

  proposalAgents: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },

  proposalAgent: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 9px",
    fontSize: 12.5,
    fontWeight: 500,
    color: "var(--ink)",
    background: "var(--raised)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--line)",
    borderRadius: 999,
  },

  proposalAgentUnknown: {
    color: "var(--warning)",
    borderColor: "var(--line-strong)",
  },

  proposalCloser: {
    fontSize: 11.5,
    fontWeight: 500,
    color: "var(--muted)",
  },

  proposalWarn: {
    display: "flex",
    alignItems: "flex-start",
    gap: 5,
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--warning)",
  },

  proposalNote: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: "var(--muted)",
  },

  proposalCode: {
    padding: "1px 5px",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    background: "var(--raised)",
    border: "1px solid var(--line)",
    borderRadius: 4,
  },

  proposalCodeStrong: {
    fontFamily: "var(--font-mono)",
    color: "var(--ink)",
  },

  proposalLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    color: "var(--accent-text)",
    textDecoration: "none",
  },

  proposalPairRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },

  proposalPairInput: {
    width: 130,
    height: 32,
    padding: "0 9px",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.08em",
    color: "var(--ink)",
    background: "var(--page)",
    border: "1px solid var(--line-strong)",
    borderRadius: 8,
  },

  proposalGhostBtn: {
    height: 32,
    padding: "0 12px",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "var(--font-family)",
    color: "var(--ink)",
    background: "var(--surface)",
    border: "1px solid var(--line-strong)",
    borderRadius: 8,
    cursor: "pointer",
  },

  proposalLaunch: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    alignSelf: "flex-start",
    height: 32,
    padding: "0 14px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "var(--font-family)",
    color: "var(--on-accent)",
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 8,
    cursor: "pointer",
  },

  proposalLaunchOff: {
    opacity: 0.5,
    cursor: "not-allowed",
  },

  proposalError: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--danger)",
  },
};
