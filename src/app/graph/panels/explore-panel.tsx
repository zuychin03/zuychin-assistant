"use client";

import { Loader2, Search, Sparkles, Telescope, X } from "lucide-react";
import { CATEGORIES, CATEGORY_COLORS, COSMOS } from "../cosmos/palette";
import { styles } from "../cosmos/styles";
import type { PhysicsSettings, Quality } from "../cosmos/scene";
import { PanelShell, Slider, Switch } from "./ui";

export interface SearchHit {
    path: string;
    title: string;
    similarity: number;
}

export default function ExplorePanel(props: {
    query: string;
    onQueryChange(value: string): void;
    searching: boolean;
    hits: SearchHit[];
    activeHit: number;
    onPickHit(path: string): void;
    visibleNodes: number;
    visibleLinks: number;
    totalNodes: number;
    categoryFilter: Record<string, boolean>;
    onToggleCategory(category: string): void;
    showOrphans: boolean;
    onShowOrphans(next: boolean): void;
    showSuggestions: boolean;
    onShowSuggestions(next: boolean): void;
    suggestionCount: number;
    physics: PhysicsSettings;
    onPhysics(next: PhysicsSettings): void;
    quality: Quality;
    onQuality(next: Quality): void;
    bloomActive: boolean;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
}) {
    const {
        query, onQueryChange, searching, hits, activeHit, onPickHit,
        visibleNodes, visibleLinks, totalNodes, categoryFilter, onToggleCategory,
        showOrphans, onShowOrphans, showSuggestions, onShowSuggestions, suggestionCount,
        physics, onPhysics, quality, onQuality, bloomActive, searchInputRef,
    } = props;

    return (
        <PanelShell
            icon={<Telescope size={15} />}
            title="Explore"
            subtitle="Search meaning, not just titles"
        >
            <div style={styles.searchRow}>
                {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} style={{ opacity: 0.65 }} />}
                <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder="Search the vault..."
                    style={styles.searchInput}
                    aria-label="Search vault pages"
                />
                {query && (
                    <button style={styles.clearBtn} onClick={() => onQueryChange("")} aria-label="Clear search">
                        <X size={13} />
                    </button>
                )}
            </div>

            {query.trim() && !searching && hits.length === 0 && (
                <div style={styles.empty}>No page matches that, semantically or by title.</div>
            )}

            {hits.length > 0 && (
                <div style={styles.resultList}>
                    {hits.slice(0, 8).map((hit, index) => (
                        <button
                            key={hit.path}
                            onClick={() => onPickHit(hit.path)}
                            style={{ ...styles.resultRow, ...(index === activeHit ? styles.resultRowActive : {}) }}
                        >
                            <span style={styles.resultTitle}>{hit.title}</span>
                            <span style={styles.resultScore}>{Math.round(hit.similarity * 100)}%</span>
                        </button>
                    ))}
                </div>
            )}

            <div style={styles.statsGrid}>
                <div style={styles.statCard}>
                    <span style={styles.statValue}>{visibleNodes}</span>
                    <span style={styles.statLabel}>Visible / {totalNodes}</span>
                </div>
                <div style={styles.statCard}>
                    <span style={styles.statValue}>{visibleLinks}</span>
                    <span style={styles.statLabel}>Filaments</span>
                </div>
            </div>

            <div style={styles.sectionLabel}>Spectral families</div>
            <div style={styles.chipRow}>
                {CATEGORIES.map((category) => {
                    const on = categoryFilter[category] !== false;
                    return (
                        <button
                            key={category}
                            onClick={() => onToggleCategory(category)}
                            style={{ ...styles.chip, ...(on ? styles.chipActive : {}) }}
                            aria-pressed={on}
                        >
                            <span style={{ ...styles.chipDot, background: on ? CATEGORY_COLORS[category] : COSMOS.dust }} />
                            {category}
                        </button>
                    );
                })}
            </div>

            <div style={styles.sectionLabel}>Show</div>
            <Switch label="Rogue pages (no links)" on={showOrphans} onChange={onShowOrphans} />
            <Switch
                label={`Suggested arcs${suggestionCount ? ` (${suggestionCount})` : ""}`}
                icon={<Sparkles size={12} />}
                on={showSuggestions}
                onChange={onShowSuggestions}
            />
            <Switch
                label={`Full effects${bloomActive ? " · bloom on" : ""}`}
                on={quality === "auto"}
                onChange={(next) => onQuality(next ? "auto" : "plain")}
            />

            <div style={styles.sectionLabel}>Gravity</div>
            <Slider
                label="Repulsion" min={20} max={400} step={10}
                value={physics.repel}
                onChange={(repel) => onPhysics({ ...physics, repel })}
            />
            <Slider
                label="Filament length" min={20} max={200} step={5}
                value={physics.linkDist}
                onChange={(linkDist) => onPhysics({ ...physics, linkDist })}
            />
            <Slider
                label="Core pull" min={0} max={3} step={0.1}
                value={physics.center}
                format={(value) => value.toFixed(1)}
                onChange={(center) => onPhysics({ ...physics, center })}
            />
            <Slider
                label="Constellation cohesion" min={0} max={0.4} step={0.01}
                value={physics.cluster}
                format={(value) => value.toFixed(2)}
                onChange={(cluster) => onPhysics({ ...physics, cluster })}
            />
        </PanelShell>
    );
}
