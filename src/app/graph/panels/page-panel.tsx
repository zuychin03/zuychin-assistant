"use client";

import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Check, ChevronDown, Crosshair, Link2, List, Loader2, Orbit, Pencil, Route, Sparkles, Trash2, X,
} from "lucide-react";
import {
    CATEGORY_COLORS, COSMOS, HEALTH_COLORS, HEALTH_LABELS,
} from "../cosmos/palette";
import { styles } from "../cosmos/styles";
import { displayMarkdown, humanizePath, type GraphNode } from "../cosmos/model";
import { documentHeadings } from "../cosmos/sections";
import { Badge, PanelShell } from "./ui";
import { readDocumentPosition, rememberDocumentPosition } from "@/lib/document-navigation";

const TRUST_COLORS: Record<string, string> = {
    trusted: "#dce8ff",
    reviewed: "#8fc2ff",
    untrusted: "#ff7a59",
};

const STATUS_COLORS: Record<string, string> = {
    active: "#45e0a8",
    suggested: "#ffb545",
    superseded: "#6a7086",
    archived: "#6a7086",
    deleted: "#ff5470",
};

export interface PageSuggestion {
    target: string;
    similarity: number;
}

export default function PagePanel(props: {
    node: GraphNode;
    markdown: string | null;
    loading: boolean;
    editMode: boolean;
    editText: string;
    draftDirty: boolean;
    draftPersisted: boolean;
    draftConflict: boolean;
    libraryHref: string;
    busy: string | null;
    confirming: string | null;
    suggestions: PageSuggestion[];
    suggestionsLoading: boolean;
    selectedSuggestions: Set<string>;
    linkQuery: string;
    linkTargets: GraphNode[];
    linkTargetId: string | null;
    linkLabel: string;
    focusedSection: { id: string; title: string } | null;
    onFocusSection(sectionId: string, title: string): void;
    onClearSection(): void;
    titleOf(path: string): string;
    onClose(): void;
    onEdit(): void;
    onCancelEdit(): void;
    onEditText(value: string): void;
    onDiscardDraft(): void;
    onCopyDraft(): void;
    onSave(): void;
    onDelete(): void;
    onConfirm(key: string | null): void;
    onFocus(path: string): void;
    onLocal(): void;
    onRouteFrom(): void;
    onRouteTo(): void;
    onToggleSuggestion(target: string): void;
    onAcceptSuggestion(target: string): void;
    onLinkSelected(): void;
    onLinkQuery(value: string): void;
    onLinkTarget(id: string | null): void;
    onLinkLabel(value: string): void;
    onCreateLink(): void;
}) {
    const {
        node, markdown, loading, editMode, editText, busy, confirming,
        draftDirty, draftPersisted, draftConflict, libraryHref, onDiscardDraft, onCopyDraft,
        suggestions, suggestionsLoading, selectedSuggestions,
        linkQuery, linkTargets, linkTargetId, linkLabel, focusedSection, onFocusSection, onClearSection, titleOf,
        onClose, onEdit, onCancelEdit, onEditText, onSave, onDelete, onConfirm,
        onFocus, onLocal, onRouteFrom, onRouteTo,
        onToggleSuggestion, onAcceptSuggestion, onLinkSelected,
        onLinkQuery, onLinkTarget, onLinkLabel, onCreateLink,
    } = props;

    const markdownRef = useRef<HTMLDivElement>(null);
    const navigationRef = useRef<HTMLDivElement>(null);
    const [outlineOpen, setOutlineOpen] = useState(false);
    const restoredPath = useRef<string | null>(null);
    const headings = useMemo(() => documentHeadings(markdown ?? ""), [markdown]);
    const headingByLine = useMemo(() => new Map(headings.map(heading => [heading.line, heading])), [headings]);
    const headingComponents = useMemo(() => {
        const renderHeading = (Tag: ElementType) => function Heading({ node: element, children }: {
            node?: { position?: { start: { line: number } } };
            children?: React.ReactNode;
        }) {
            const heading = headingByLine.get(element?.position?.start.line ?? -1);
            return <Tag id={heading ? `vault-section-${heading.id}` : undefined}
                data-section-id={heading?.id} tabIndex={-1}
                data-focused={heading?.id === focusedSection?.id || undefined}>{children}</Tag>;
        };
        return {
            h1: renderHeading("h1"), h2: renderHeading("h2"), h3: renderHeading("h3"),
            h4: renderHeading("h4"), h5: renderHeading("h5"), h6: renderHeading("h6"),
        };
    }, [headingByLine, focusedSection?.id]);

    useEffect(() => {
        if (loading || !focusedSection || !markdownRef.current) return;
        const heading = [...markdownRef.current.querySelectorAll<HTMLElement>("[data-section-id]")]
            .find(element => element.dataset.sectionId === focusedSection.id);
        if (!heading) return;
        const pane = markdownRef.current;
        // Keep the document and its containing rail in view without scrolling the canvas.
        const rail = pane.closest<HTMLElement>(".cosmos-rail, .cosmos-dock-body");
        if (rail) rail.scrollTop += pane.getBoundingClientRect().top - rail.getBoundingClientRect().top
            - (navigationRef.current?.offsetHeight ?? 0) - 12;
        pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - 14;
        heading.focus({ preventScroll: true });
    }, [focusedSection, markdown, editMode, loading]);

    useEffect(() => {
        if (loading || !markdown || editMode || restoredPath.current === node.id) return;
        restoredPath.current = node.id;
        if (!focusedSection && markdownRef.current) markdownRef.current.scrollTop = readDocumentPosition(`cosmos:${node.id}`);
    }, [node.id, markdown, loading, editMode, focusedSection]);

    return (
        <section style={styles.panel}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={styles.pagePanelTitle}>{node.title}</h2>
                    <div style={styles.pagePath}>{node.id}</div>
                </div>
                <button style={styles.iconBtn} onClick={onClose} aria-label="Close page" title="Close (Esc)">
                    <X size={13} />
                </button>
            </div>

            <div style={styles.badgeRow}>
                <Badge label={node.category} color={CATEGORY_COLORS[node.category] ?? "#8891a8"} />
                <Badge label={node.trust} color={TRUST_COLORS[node.trust] ?? "#8891a8"} title="Trust level" />
                <Badge label={node.status} color={STATUS_COLORS[node.status] ?? "#8891a8"} title="Lifecycle status" />
                {node.sensitivity !== "private" && <Badge label={node.sensitivity} color="#c07bff" title="Sensitivity" />}
                {node.scope !== "user" && <Badge label={node.scope} color="#5ce1e6" title="Scope" />}
                {node.health.map((finding) => (
                    <Badge key={finding} label={HEALTH_LABELS[finding]} color={HEALTH_COLORS[finding]} />
                ))}
            </div>

            <div style={styles.documentMeta}>
                <span><strong>{node.words.toLocaleString()}</strong> words</span>
                <span><strong>{node.links}</strong> connections</span>
                <span title="PageRank relative to the most central page"><strong>{Math.round(node.centrality * 100)}%</strong> centrality</span>
                {node.updated && <span>Updated {node.updated}</span>}
            </div>

            <div style={styles.actionRow}>
                {!editMode && (
                    <button style={styles.action} onClick={onEdit} disabled={loading || markdown === null}>
                        <Pencil size={12} /> {draftDirty ? "Resume editing" : "Edit"}
                    </button>
                )}
                {editMode && (
                    <>
                        <button style={{ ...styles.action, ...styles.actionPrimary }} onClick={onSave} disabled={busy === "save" || !draftDirty || draftConflict || !editText.trim()}>
                            {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                        </button>
                        <button style={styles.action} onClick={onCancelEdit}>Reader</button>
                    </>
                )}
                <Link href={libraryHref} style={{ ...styles.action, textDecoration: "none" }}>Open in Library</Link>
                <button style={styles.action} onClick={onLocal} title="Isolate this system">
                    <Crosshair size={12} /> System
                </button>
                <button style={styles.action} onClick={onRouteFrom} title="Route from this page">
                    <Route size={12} /> From
                </button>
                <button style={styles.action} onClick={onRouteTo} title="Route to this page">
                    <Route size={12} /> To
                </button>
                {confirming === "delete" ? (
                    <>
                        <button style={{ ...styles.action, ...styles.actionDanger }} onClick={onDelete} disabled={busy === "delete"}>
                            {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Confirm delete
                        </button>
                        <button style={styles.action} onClick={() => onConfirm(null)}>Keep</button>
                    </>
                ) : (
                    <button style={{ ...styles.action, ...styles.actionDanger }} onClick={() => onConfirm("delete")}>
                        <Trash2 size={12} /> Delete
                    </button>
                )}
            </div>

            {draftDirty && <div style={{ ...styles.empty, padding: "10px 0", display: "grid", gap: 8 }} role="status">
                <span>{draftConflict ? "The saved page changed. Copy your draft before discarding it to reopen the current page."
                    : draftPersisted ? "Unsaved changes · Draft saved on this device" : "Unsaved changes · Keep this tab open; draft recovery is unavailable"}</span>
                <div style={styles.actionRow}>
                    {draftConflict && <button style={styles.action} onClick={onCopyDraft}>Copy draft</button>}
                    <button style={styles.action} onClick={onDiscardDraft} disabled={busy === "save"}>Discard draft</button>
                </div>
            </div>}

            {loading && (
                <div style={{ ...styles.empty, display: "flex", alignItems: "center", gap: 7 }}>
                    <Loader2 size={13} className="animate-spin" /> Loading the page...
                </div>
            )}

            {!loading && editMode && (
                <textarea
                    value={editText}
                    onChange={(event) => onEditText(event.target.value)}
                    style={styles.editArea}
                    spellCheck={false}
                    aria-label="Page markdown"
                />
            )}

            {!loading && !editMode && headings.length > 0 && (
                <div ref={navigationRef} style={styles.documentNav}>
                    <button style={styles.outlineToggle} onClick={() => setOutlineOpen(value => !value)}
                        aria-expanded={outlineOpen} aria-controls="cosmos-document-outline">
                        <List size={15} /> In this document
                        <span style={{ marginLeft: "auto", color: COSMOS.muted }}>{headings.length}</span>
                        <ChevronDown size={14} style={{ transform: outlineOpen ? "rotate(180deg)" : undefined }} />
                    </button>
                    {outlineOpen && (
                        <nav id="cosmos-document-outline" aria-label="Document sections" style={styles.outline}>
                            {headings.map(heading => (
                                <button key={heading.id} style={{ ...styles.outlineItem,
                                    paddingLeft: 10 + Math.max(0, heading.level - 1) * 10,
                                    ...(heading.id === focusedSection?.id ? styles.outlineItemActive : {}) }}
                                    aria-current={heading.id === focusedSection?.id ? "location" : undefined}
                                    onClick={() => { onFocusSection(heading.id, heading.title); setOutlineOpen(false); }}>
                                    {heading.title}
                                </button>
                            ))}
                        </nav>
                    )}
                    {focusedSection && (
                        <div style={styles.sectionFocus} role="status">
                            <Orbit size={14} style={{ flexShrink: 0 }} />
                            <span style={{ flex: 1, minWidth: 0 }}>Reading: <strong>{focusedSection.title}</strong></span>
                            <button style={styles.clearBtn} onClick={onClearSection} aria-label="Clear section focus">
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </div>
            )}

            {!loading && !editMode && markdown && (
                <div ref={markdownRef} style={styles.markdown} className="graph-markdown" aria-label={`${node.title} document`}
                    onScroll={(event) => rememberDocumentPosition(`cosmos:${node.id}`, event.currentTarget.scrollTop)}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={headingComponents}>{displayMarkdown(markdown)}</ReactMarkdown>
                </div>
            )}

            <div style={styles.sectionLabel}>Possible connections</div>
            {suggestionsLoading && (
                <div style={{ ...styles.empty, display: "flex", alignItems: "center", gap: 7 }}>
                    <Loader2 size={12} className="animate-spin" /> Comparing against the rest of the vault...
                </div>
            )}
            {!suggestionsLoading && suggestions.length === 0 && (
                <div style={styles.empty}>Nothing similar enough to suggest right now.</div>
            )}
            {suggestions.length > 0 && (
                <>
                    <div style={styles.listStack}>
                        {suggestions.map((suggestion) => {
                            const checked = selectedSuggestions.has(suggestion.target);
                            return (
                                <div key={suggestion.target} style={{ ...styles.listRow, cursor: "default" }}>
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => onToggleSuggestion(suggestion.target)}
                                        aria-label={`Select ${titleOf(suggestion.target)}`}
                                        style={{ accentColor: "#6ba7ff", flexShrink: 0 }}
                                    />
                                    <button
                                        style={{ ...styles.resultRow, padding: 0, flex: 1 }}
                                        onClick={() => onFocus(suggestion.target)}
                                    >
                                        <span style={styles.resultTitle}>{titleOf(suggestion.target)}</span>
                                    </button>
                                    <span style={styles.listRowMeta}>{Math.round(suggestion.similarity * 100)}%</span>
                                    <button
                                        style={styles.clearBtn}
                                        onClick={() => onAcceptSuggestion(suggestion.target)}
                                        title="Link these pages"
                                        aria-label={`Link ${titleOf(suggestion.target)}`}
                                        disabled={busy === "link"}
                                    >
                                        <Link2 size={13} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    {selectedSuggestions.size > 0 && (
                        <div style={styles.actionRow}>
                            <button
                                style={{ ...styles.action, ...styles.actionPrimary }}
                                onClick={onLinkSelected}
                                disabled={busy === "link"}
                            >
                                {busy === "link" ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                                Link selected ({selectedSuggestions.size})
                            </button>
                        </div>
                    )}
                </>
            )}

            <div style={styles.sectionLabel}>Link to another page</div>
            <div style={styles.searchRow}>
                <Link2 size={13} style={{ opacity: 0.65 }} />
                <input
                    value={linkQuery}
                    onChange={(event) => { onLinkQuery(event.target.value); onLinkTarget(null); }}
                    placeholder="Find a page to link..."
                    style={styles.searchInput}
                    aria-label="Link target"
                />
            </div>
            {linkTargets.length > 0 && !linkTargetId && (
                <div style={styles.resultList}>
                    {linkTargets.map((target) => (
                        <button
                            key={target.id}
                            style={styles.resultRow}
                            onClick={() => { onLinkTarget(target.id); onLinkQuery(target.title); }}
                        >
                            <span style={styles.resultTitle}>{target.title}</span>
                            <span style={styles.resultScore}>{target.category}</span>
                        </button>
                    ))}
                </div>
            )}
            {linkTargetId && (
                <>
                    <div style={{ ...styles.searchRow, marginTop: 6 }}>
                        <input
                            value={linkLabel}
                            onChange={(event) => onLinkLabel(event.target.value)}
                            placeholder="Relationship label (default: related)"
                            style={styles.searchInput}
                            aria-label="Relationship label"
                        />
                    </div>
                    <div style={styles.actionRow}>
                        <button
                            style={{ ...styles.action, ...styles.actionPrimary }}
                            onClick={onCreateLink}
                            disabled={busy === "link"}
                        >
                            {busy === "link" ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
                            Link to {humanizePath(linkTargetId)}
                        </button>
                        <button style={styles.action} onClick={() => { onLinkTarget(null); onLinkQuery(""); }}>Cancel</button>
                    </div>
                </>
            )}
        </section>
    );
}

export function LinkPanel({ source, target, kind, similarity, titleOf, busy, confirming, onConfirm, onUnlink, onAccept, onClose }: {
    source: string;
    target: string;
    kind: "real" | "suggestion";
    similarity?: number;
    titleOf(path: string): string;
    busy: string | null;
    confirming: string | null;
    onConfirm(key: string | null): void;
    onUnlink(): void;
    onAccept(): void;
    onClose(): void;
}) {
    return (
        <PanelShell
            icon={<Link2 size={15} />}
            title={kind === "suggestion" ? "Suggested arc" : "Connection"}
            subtitle={
                kind === "suggestion"
                    ? `${Math.round((similarity ?? 0) * 100)}% similar, not yet linked`
                    : "Removing this strips the wikilink from both pages"
            }
            aside={
                <button style={styles.iconBtn} onClick={onClose} aria-label="Close connection" title="Close (Esc)">
                    <X size={13} />
                </button>
            }
        >
            <div style={styles.listStack}>
                <div style={{ ...styles.listRow, cursor: "default" }}>
                    <span style={styles.listRowLead}>A</span>
                    <span style={styles.resultTitle}>{titleOf(source)}</span>
                </div>
                <div style={{ ...styles.listRow, cursor: "default" }}>
                    <span style={styles.listRowLead}>B</span>
                    <span style={styles.resultTitle}>{titleOf(target)}</span>
                </div>
            </div>

            <div style={styles.actionRow}>
                {kind === "suggestion" ? (
                    <button style={{ ...styles.action, ...styles.actionPrimary }} onClick={onAccept} disabled={busy === "link"}>
                        {busy === "link" ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Make it real
                    </button>
                ) : confirming === "unlink" ? (
                    <>
                        <button style={{ ...styles.action, ...styles.actionDanger }} onClick={onUnlink} disabled={busy === "unlink"}>
                            {busy === "unlink" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Confirm unlink
                        </button>
                        <button style={styles.action} onClick={() => onConfirm(null)}>Keep</button>
                    </>
                ) : (
                    <button style={{ ...styles.action, ...styles.actionDanger }} onClick={() => onConfirm("unlink")}>
                        <Trash2 size={12} /> Remove connection
                    </button>
                )}
            </div>

            {kind === "suggestion" && (
                <p style={{ ...styles.empty, color: COSMOS.muted }}>
                    Computed from stored embeddings, so it costs nothing to look at. Accepting writes a
                    labelled wikilink into both pages as one commit.
                </p>
            )}
        </PanelShell>
    );
}
