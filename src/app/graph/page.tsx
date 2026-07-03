"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft, Check, Crosshair, Link2, Loader2, Pencil, RefreshCw,
  Search, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import type { ForceGraph3DInstance } from "3d-force-graph";

// ---- Server payload ----

interface ApiNode {
  id: string;
  title: string;
  category: string;
  summary: string;
  links: number;
  updated: string | null;
}
interface ApiEdge { source: string; target: string; mutual: boolean }
interface ApiSuggestion { source: string; target: string; similarity: number }
interface ApiGraph { nodes: ApiNode[]; edges: ApiEdge[]; suggestions: ApiSuggestion[] }

// ---- Graph-lib objects (cached across refreshes so layout positions survive) ----

interface GNode extends ApiNode { x?: number; y?: number; z?: number }
interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: "real" | "suggestion";
  mutual: boolean;
  similarity?: number;
}
type Graph = ForceGraph3DInstance<GNode, GLink>;

const CATEGORIES = ["sources", "concepts", "entities", "synthesis"] as const;
const CATEGORY_COLORS: Record<string, string> = {
  sources: "#d9952b",
  concepts: "#5b8def",
  entities: "#3fbf8f",
  synthesis: "#b678e0",
};

const DEFAULT_PHYSICS = { repel: 120, linkDist: 60, center: 1 };

function linkId(l: GLink): { s: string; t: string } {
  return {
    s: typeof l.source === "string" ? l.source : l.source.id,
    t: typeof l.target === "string" ? l.target : l.target.id,
  };
}
function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Blend a hex color toward a target hex by t (0..1). */
function blend(hex: string, target: string, t: number): string {
  const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(hex);
  const [r2, g2, b2] = p(target);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}
/** 0..1 glow factor from the page's last update date. */
function recency(updated: string | null): number {
  if (!updated) return 0;
  const days = (Date.now() - new Date(updated).getTime()) / 86_400_000;
  if (days <= 3) return 0.55;
  if (days <= 7) return 0.4;
  if (days <= 30) return 0.2;
  return 0;
}
/** [[path|label]] → label, [[path]] → last segment, for read-mode display. */
function displayMarkdown(md: string): string {
  return md.replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, path: string, label?: string) => {
    const text = label?.trim() || path.replace(/\.md$/, "").split("/").pop()!.replace(/-/g, " ");
    return `**${text}**`;
  });
}

type Selection =
  | { type: "node"; id: string }
  | { type: "link"; source: string; target: string; kind: "real" | "suggestion"; similarity?: number }
  | null;

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const nodeCache = useRef(new Map<string, GNode>());
  const linkCache = useRef(new Map<string, GLink>());

  const [data, setData] = useState<ApiGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graphReady, setGraphReady] = useState(false);

  const [controlsOpen, setControlsOpen] = useState(true);
  const [catFilter, setCatFilter] = useState<Record<string, boolean>>(
    () => Object.fromEntries(CATEGORIES.map((c) => [c, true])),
  );
  const [showOrphans, setShowOrphans] = useState(true);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [physics, setPhysics] = useState(DEFAULT_PHYSICS);
  const [search, setSearch] = useState("");
  const [localRoot, setLocalRoot] = useState<string | null>(null);
  const [localDepth, setLocalDepth] = useState<1 | 2>(1);

  const [selected, setSelected] = useState<Selection>(null);
  const [pageMd, setPageMd] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "save" | "delete" | "unlink" | "link"
  const [confirming, setConfirming] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Accessor callbacks read these refs so the graph restyles without re-registering.
  const hoverRef = useRef<string | null>(null);
  const highlightNodes = useRef(new Set<string>());
  const highlightLinks = useRef(new Set<string>());
  const selectedRef = useRef<Selection>(null);
  const searchRef = useRef("");
  const editModeRef = useRef(false);
  const themeRef = useRef({ bg: "#0c0c0e", text: "#f2f2f7", muted: "#98989f", dim: "#3a3a3c", light: false });

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const fetchGraph = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      const res = await fetch("/api/vault/graph?suggestions=1");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load the graph.");
      setData(json as ApiGraph);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the graph.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchGraph(true); }, [fetchGraph]);

  // ---- Derived visible slice (filters, orphans, local mode, suggestions) ----

  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!data) return map;
    for (const e of data.edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [data]);

  const visible = useMemo(() => {
    if (!data) return { nodes: [] as GNode[], links: [] as GLink[] };

    let keep = new Set(
      data.nodes
        .filter((n) => catFilter[n.category] !== false)
        .filter((n) => showOrphans || n.links > 0)
        .map((n) => n.id),
    );

    if (localRoot && keep.has(localRoot)) {
      const within = new Set([localRoot]);
      let frontier = [localRoot];
      for (let d = 0; d < localDepth; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const nb of neighborMap.get(id) ?? []) {
            if (!within.has(nb) && keep.has(nb)) { within.add(nb); next.push(nb); }
          }
        }
        frontier = next;
      }
      keep = within;
    }

    const nodes: GNode[] = [];
    for (const n of data.nodes) {
      if (!keep.has(n.id)) continue;
      const cached = nodeCache.current.get(n.id);
      if (cached) {
        Object.assign(cached, n);
        nodes.push(cached);
      } else {
        const fresh: GNode = { ...n };
        nodeCache.current.set(n.id, fresh);
        nodes.push(fresh);
      }
    }

    const links: GLink[] = [];
    const pushLink = (s: string, t: string, kind: "real" | "suggestion", mutual: boolean, similarity?: number) => {
      if (!keep.has(s) || !keep.has(t)) return;
      const key = `${kind}:${pairKey(s, t)}`;
      const cached = linkCache.current.get(key);
      if (cached) {
        cached.mutual = mutual;
        cached.similarity = similarity;
        links.push(cached);
      } else {
        const fresh: GLink = { source: s, target: t, kind, mutual, similarity };
        linkCache.current.set(key, fresh);
        links.push(fresh);
      }
    };
    for (const e of data.edges) pushLink(e.source, e.target, "real", e.mutual);
    if (showSuggestions) {
      for (const s of data.suggestions) pushLink(s.source, s.target, "suggestion", false, s.similarity);
    }
    return { nodes, links };
  }, [data, catFilter, showOrphans, showSuggestions, localRoot, localDepth, neighborMap]);

  // ---- Graph instance ----

  const restyle = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor(g.nodeColor());
    g.linkColor(g.linkColor());
    g.linkWidth(g.linkWidth());
  }, []);

  const setHover = useCallback((node: GNode | null) => {
    hoverRef.current = node?.id ?? null;
    highlightNodes.current.clear();
    highlightLinks.current.clear();
    if (node) {
      highlightNodes.current.add(node.id);
      const g = graphRef.current;
      const links = (g?.graphData().links ?? []) as GLink[];
      for (const l of links) {
        const { s, t } = linkId(l);
        if (s === node.id || t === node.id) {
          highlightLinks.current.add(`${l.kind}:${pairKey(s, t)}`);
          highlightNodes.current.add(s === node.id ? t : s);
        }
      }
    }
    restyle();
  }, [restyle]);

  const flyTo = useCallback((id: string) => {
    const g = graphRef.current;
    const node = nodeCache.current.get(id);
    if (!g || !node || node.x === undefined) return;
    const dist = 140;
    const len = Math.hypot(node.x, node.y ?? 0, node.z ?? 0) || 1;
    const k = 1 + dist / len;
    g.cameraPosition({ x: node.x * k, y: (node.y ?? 0) * k, z: (node.z ?? 0) * k }, node as { x: number; y: number; z: number }, 900);
  }, []);

  const openNode = useCallback(async (id: string) => {
    setSelected({ type: "node", id });
    setEditMode(false);
    setConfirming(null);
    setLinkQuery("");
    setLinkLabel("");
    setLinkTargetId(null);
    setPageMd(null);
    setPageLoading(true);
    try {
      const res = await fetch(`/api/vault/page?path=${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load the page.");
      setPageMd(json.markdown);
      setEditText(json.markdown);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load the page.");
    } finally {
      setPageLoading(false);
    }
  }, [showToast]);

  const applyPhysics = useCallback((p: typeof DEFAULT_PHYSICS) => {
    const g = graphRef.current;
    if (!g) return;
    (g.d3Force("charge") as { strength?: (v: number) => void } | undefined)?.strength?.(-p.repel);
    (g.d3Force("link") as { distance?: (v: number) => void } | undefined)?.distance?.(p.linkDist);
    (g.d3Force("center") as { strength?: (v: number) => void } | undefined)?.strength?.(p.center);
    // Reheating before the first graphData() crashes tickFrame (state.layout is undefined).
    if (g.graphData().nodes.length > 0) g.d3ReheatSimulation();
  }, []);

  useEffect(() => { selectedRef.current = selected; restyle(); }, [selected, restyle]);
  useEffect(() => { searchRef.current = search.trim().toLowerCase(); restyle(); }, [search, restyle]);
  useEffect(() => { editModeRef.current = editMode; }, [editMode]);

  // Click vs double-click: a second click on the same node within the window isolates it.
  const lastClick = useRef<{ id: string; at: number }>({ id: "", at: 0 });

  useEffect(() => {
    if (!containerRef.current || graphRef.current) return;
    const el = containerRef.current;
    let disposed = false;

    (async () => {
      const [{ default: ForceGraph3D }, { default: SpriteText }] = await Promise.all([
        import("3d-force-graph"),
        import("three-spritetext"),
      ]);
      if (disposed || graphRef.current) return;

      const css = getComputedStyle(document.documentElement);
      const light = document.documentElement.getAttribute("data-theme") !== "dark";
      themeRef.current = {
        bg: css.getPropertyValue("--color-background").trim() || (light ? "#ffffff" : "#0c0c0e"),
        text: css.getPropertyValue("--color-text-primary").trim() || (light ? "#000000" : "#f2f2f7"),
        muted: css.getPropertyValue("--color-text-muted").trim() || "#98989f",
        dim: light ? "#c9c9ce" : "#3a3a3c",
        light,
      };
      const theme = themeRef.current;

      const g = (new ForceGraph3D(el) as unknown as Graph)
        .backgroundColor(theme.bg)
        .showNavInfo(false)
        .nodeVal((n) => 1 + n.links)
        .nodeResolution(32)
        .nodeOpacity(0.85)
        .nodeLabel((n) =>
          `<div style="padding:6px 9px;border-radius:8px;background:${theme.light ? "rgba(255,255,255,.95)" : "rgba(20,20,24,.95)"};color:${theme.text};font-size:12px;max-width:260px;box-shadow:0 2px 10px rgba(0,0,0,.25)">` +
          `<b>${escapeHtml(n.title)}</b><br/><span style="opacity:.7">${n.category} · ${n.links} link${n.links === 1 ? "" : "s"}</span>` +
          (n.summary ? `<br/><span style="opacity:.85">${escapeHtml(n.summary)}</span>` : "") +
          `</div>`)
        .nodeColor((n) => {
          const q = searchRef.current;
          const hovering = hoverRef.current !== null;
          const dimmed =
            (hovering && !highlightNodes.current.has(n.id)) ||
            (q && !n.title.toLowerCase().includes(q));
          if (dimmed) return themeRef.current.dim;
          const base = CATEGORY_COLORS[n.category] ?? "#888888";
          const glow = recency(n.updated);
          return glow > 0 ? blend(base, themeRef.current.light ? "#000000" : "#ffffff", glow * 0.6) : base;
        })
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((n) => {
          const sprite = new SpriteText(n.title, 2.6, theme.muted);
          (sprite.material as { depthWrite: boolean }).depthWrite = false;
          sprite.position.y = -(Math.cbrt(1 + n.links) * 4 + 4);
          return sprite;
        })
        .linkColor((l) => {
          const { s, t } = linkId(l);
          const key = `${l.kind}:${pairKey(s, t)}`;
          const sel = selectedRef.current;
          if (sel?.type === "link" && pairKey(sel.source, sel.target) === pairKey(s, t) && sel.kind === l.kind) {
            return themeRef.current.text;
          }
          if (hoverRef.current && highlightLinks.current.has(key)) return themeRef.current.text;
          if (l.kind === "suggestion") return "#7aa2ff";
          return themeRef.current.light ? "#b3b3bb" : "#4a4a52";
        })
        .linkOpacity(0.4)
        .linkWidth((l) => {
          const { s, t } = linkId(l);
          const sel = selectedRef.current;
          if (sel?.type === "link" && pairKey(sel.source, sel.target) === pairKey(s, t) && sel.kind === l.kind) return 2.4;
          if (hoverRef.current && highlightLinks.current.has(`${l.kind}:${pairKey(s, t)}`)) return 1.6;
          return l.kind === "suggestion" ? 0.6 : 1;
        })
        .linkLabel((l) => {
          const { s, t } = linkId(l);
          const name = (id: string) => escapeHtml(nodeCache.current.get(id)?.title ?? id);
          return l.kind === "suggestion"
            ? `${name(s)} ~ ${name(t)} · ${(l.similarity! * 100).toFixed(0)}% similar (click to review)`
            : `${name(s)} ↔ ${name(t)}`;
        })
        .onNodeHover((n) => { setHover(n); el.style.cursor = n ? "pointer" : "default"; })
        .onLinkHover((l) => { el.style.cursor = l ? "pointer" : "default"; })
        .onNodeClick((n) => {
          const now = Date.now();
          if (lastClick.current.id === n.id && now - lastClick.current.at < 350) {
            setLocalRoot(n.id);
            lastClick.current = { id: "", at: 0 };
            return;
          }
          lastClick.current = { id: n.id, at: now };
          openNode(n.id);
          flyTo(n.id);
        })
        .onLinkClick((l) => {
          const { s, t } = linkId(l);
          setConfirming(null);
          setLinkLabel("");
          setSelected({ type: "link", source: s, target: t, kind: l.kind, similarity: l.similarity });
        })
        .onBackgroundClick(() => {
          if (selectedRef.current?.type === "node" && editModeRef.current) return;
          setSelected(null);
          setConfirming(null);
        });

      graphRef.current = g;
      setGraphReady(true);

      const onResize = () => g.width(window.innerWidth).height(window.innerHeight);
      onResize();
      window.addEventListener("resize", onResize);
      (el as HTMLDivElement & { __cleanup?: () => void }).__cleanup = () => window.removeEventListener("resize", onResize);
    })();

    return () => {
      disposed = true;
      (el as HTMLDivElement & { __cleanup?: () => void }).__cleanup?.();
      graphRef.current?._destructor();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!graphReady || !graphRef.current) return;
    setHover(null);
    graphRef.current.graphData({ nodes: visible.nodes, links: visible.links });
  }, [graphReady, visible, setHover]);

  useEffect(() => { if (graphReady) applyPhysics(physics); }, [graphReady, physics, applyPhysics]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editMode) return;
      if (selected) { setSelected(null); setConfirming(null); return; }
      if (localRoot) setLocalRoot(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, localRoot, editMode]);

  // ---- Mutations (optimistic, then background re-sync) ----

  const patchData = useCallback((fn: (d: ApiGraph) => ApiGraph) => {
    setData((d) => (d ? fn(d) : d));
  }, []);

  const savePage = async () => {
    if (selected?.type !== "node") return;
    setBusy("save");
    try {
      const res = await fetch("/api/vault/page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected.id, markdown: editText }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed.");
      setPageMd(editText);
      setEditMode(false);
      showToast("Page saved and committed.");
      fetchGraph(false); // edits can add/remove wikilinks
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  };

  const deletePage = async () => {
    if (selected?.type !== "node") return;
    const id = selected.id;
    setBusy("delete");
    try {
      const res = await fetch(`/api/vault/page?path=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed.");
      nodeCache.current.delete(id);
      patchData((d) => ({
        nodes: d.nodes.filter((n) => n.id !== id),
        edges: d.edges.filter((e) => e.source !== id && e.target !== id),
        suggestions: d.suggestions.filter((s) => s.source !== id && s.target !== id),
      }));
      setSelected(null);
      if (localRoot === id) setLocalRoot(null);
      showToast(`Page deleted; ${json.changedPages?.length ?? 0} reference(s) cleaned.`);
      fetchGraph(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const deleteLink = async () => {
    if (selected?.type !== "link") return;
    const { source, target } = selected;
    setBusy("unlink");
    try {
      const res = await fetch(
        `/api/vault/link?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Unlink failed.");
      linkCache.current.delete(`real:${pairKey(source, target)}`);
      patchData((d) => ({
        ...d,
        edges: d.edges.filter((e) => pairKey(e.source, e.target) !== pairKey(source, target)),
      }));
      setSelected(null);
      showToast("Connection removed from both pages.");
      fetchGraph(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Unlink failed.");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const createLink = async (source: string, target: string, label: string) => {
    setBusy("link");
    try {
      const res = await fetch("/api/vault/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, target, label }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Link failed.");
      patchData((d) => ({
        ...d,
        edges: [...d.edges, { source, target, mutual: true }],
        suggestions: d.suggestions.filter((s) => pairKey(s.source, s.target) !== pairKey(source, target)),
      }));
      showToast("Pages linked.");
      setLinkQuery("");
      setLinkLabel("");
      setLinkTargetId(null);
      if (selectedRef.current?.type === "link") setSelected(null);
      fetchGraph(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Link failed.");
    } finally {
      setBusy(null);
    }
  };

  // ---- Panel helpers ----

  const nodeById = useCallback((id: string) => data?.nodes.find((n) => n.id === id), [data]);

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !data) return [];
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [search, data]);

  const linkTargets = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    if (!q || !data || selected?.type !== "node") return [];
    const connected = neighborMap.get(selected.id) ?? new Set();
    return data.nodes
      .filter((n) => n.id !== selected.id && !connected.has(n.id) && n.title.toLowerCase().includes(q))
      .slice(0, 6);
  }, [linkQuery, data, selected, neighborMap]);

  const selectedNode = selected?.type === "node" ? nodeById(selected.id) : undefined;

  return (
    <div style={styles.root}>
      <div style={styles.ambientOne} />
      <div style={styles.ambientTwo} />
      <div ref={containerRef} style={styles.canvas} />

      {/* Top bar */}
      <div style={styles.topBar}>
        <Link href="/" style={styles.backBtn} aria-label="Back to chat">
          <ArrowLeft size={17} />
        </Link>
        <div style={styles.titleStack}>
          <span style={styles.eyebrow}>Second Brain</span>
          <span style={styles.pageTitle}>Knowledge Graph</span>
        </div>
        {data && <span style={styles.counts}>{visible.nodes.length}/{data.nodes.length} pages</span>}
        <button
          onClick={() => fetchGraph(false)}
          style={styles.iconBtn}
          aria-label="Refresh graph"
          title="Refresh"
          disabled={refreshing}
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
        </button>
        <button
          onClick={() => setControlsOpen((o) => !o)}
          style={{ ...styles.iconBtn, ...(controlsOpen ? styles.iconBtnActive : {}) }}
          aria-label="Toggle controls"
          title="Controls"
        >
          <SlidersHorizontal size={15} />
        </button>
      </div>

      {/* Local mode banner */}
      {localRoot && (
        <div style={styles.localBanner} className="animate-fade-in-scale">
          <Crosshair size={13} />
          <span>Local: <b>{nodeById(localRoot)?.title ?? localRoot}</b></span>
          <button
            style={styles.depthBtn}
            onClick={() => setLocalDepth((d) => (d === 1 ? 2 : 1))}
            title="Neighborhood depth"
          >
            {localDepth} hop{localDepth > 1 ? "s" : ""}
          </button>
          <button style={styles.depthBtn} onClick={() => setLocalRoot(null)}>Exit (Esc)</button>
        </div>
      )}

      {/* Controls panel */}
      {controlsOpen && (
        <div style={styles.controls} className="animate-fade-in-scale">
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.cardTitle}>Explore</div>
              <div style={styles.cardSubtle}>Filter, search and tune the layout</div>
            </div>
            {data && <span style={styles.suggestionPill}>{data.suggestions.length} suggestions</span>}
          </div>

          <div style={styles.searchRow}>
            <Search size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages..."
              style={styles.searchInput}
            />
            {search && (
              <button style={styles.clearBtn} onClick={() => setSearch("")} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>

          {data && (
            <div style={styles.statsGrid}>
              <div style={styles.statCard}>
                <span style={styles.statValue}>{visible.nodes.length}</span>
                <span style={styles.statLabel}>Visible pages</span>
              </div>
              <div style={styles.statCard}>
                <span style={styles.statValue}>{visible.links.length}</span>
                <span style={styles.statLabel}>Visible links</span>
              </div>
            </div>
          )}

          {searchMatches.length > 0 && (
            <div style={styles.searchResults}>
              {searchMatches.map((n) => (
                <button
                  key={n.id}
                  style={styles.searchItem}
                  onClick={() => { openNode(n.id); flyTo(n.id); setSearch(""); }}
                >
                  <span style={{ ...styles.dot, background: CATEGORY_COLORS[n.category] }} />
                  <span style={styles.searchItemText}>{n.title}</span>
                </button>
              ))}
            </div>
          )}

          <div style={styles.sectionLabel}>Categories</div>
          {CATEGORIES.map((c) => (
            <label key={c} style={styles.checkRow}>
              <input
                type="checkbox"
                checked={catFilter[c] !== false}
                onChange={(e) => setCatFilter((f) => ({ ...f, [c]: e.target.checked }))}
              />
              <span style={{ ...styles.dot, background: CATEGORY_COLORS[c] }} />
              <span style={styles.checkLabel}>{c}</span>
            </label>
          ))}
          <label style={styles.checkRow}>
            <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} />
            <span style={styles.checkLabel}>orphan pages</span>
          </label>
          <label style={styles.checkRow}>
            <input type="checkbox" checked={showSuggestions} onChange={(e) => setShowSuggestions(e.target.checked)} />
            <span style={{ ...styles.dot, background: "#7aa2ff" }} />
            <span style={styles.checkLabel}>
              suggested links{data ? ` (${data.suggestions.length})` : ""}
            </span>
          </label>

          <div style={styles.sectionLabel}>Forces</div>
          <SliderRow label="Repel" min={0} max={300} step={10} value={physics.repel}
            onChange={(v) => setPhysics((p) => ({ ...p, repel: v }))} />
          <SliderRow label="Link distance" min={10} max={200} step={5} value={physics.linkDist}
            onChange={(v) => setPhysics((p) => ({ ...p, linkDist: v }))} />
          <SliderRow label="Center pull" min={0} max={1} step={0.05} value={physics.center}
            onChange={(v) => setPhysics((p) => ({ ...p, center: v }))} />

          <p style={styles.hint}>Click a page to inspect it. Double-click to isolate its neighborhood. Click a connection to manage it.</p>
        </div>
      )}

      {/* Node panel */}
      {selected?.type === "node" && (
        <div style={styles.panel} className="animate-fade-in-scale">
          <div style={styles.panelHeader}>
            <span style={{ ...styles.categoryChip, background: CATEGORY_COLORS[selectedNode?.category ?? ""] ?? "#888" }}>
              {selectedNode?.category}
            </span>
            <button style={styles.clearBtn} onClick={() => { setSelected(null); setEditMode(false); }} aria-label="Close panel">
              <X size={15} />
            </button>
          </div>
          <h2 style={styles.panelTitle}>{selectedNode?.title ?? selected.id}</h2>
          <div style={styles.panelMeta}>
            <span style={styles.mono}>{selected.id}</span>
            {selectedNode?.updated && <span>updated {selectedNode.updated}</span>}
            <span>{selectedNode?.links ?? 0} link{(selectedNode?.links ?? 0) === 1 ? "" : "s"}</span>
          </div>

          <div style={styles.panelActions}>
            {!editMode ? (
              <button style={styles.actionBtn} onClick={() => { setEditText(pageMd ?? ""); setEditMode(true); }} disabled={pageMd === null}>
                <Pencil size={13} /> Edit
              </button>
            ) : (
              <>
                <button style={{ ...styles.actionBtn, ...styles.actionPrimary }} onClick={savePage} disabled={busy !== null || editText.trim() === ""}>
                  {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
                </button>
                <button style={styles.actionBtn} onClick={() => { setEditMode(false); setEditText(pageMd ?? ""); }} disabled={busy !== null}>
                  Cancel
                </button>
              </>
            )}
            {confirming === "page" ? (
              <>
                <button style={{ ...styles.actionBtn, ...styles.actionDanger }} onClick={deletePage} disabled={busy !== null}>
                  {busy === "delete" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Confirm delete
                </button>
                <button style={styles.actionBtn} onClick={() => setConfirming(null)}>Keep</button>
              </>
            ) : (
              <button style={{ ...styles.actionBtn, ...styles.actionDangerGhost }} onClick={() => setConfirming("page")} disabled={busy !== null}>
                <Trash2 size={13} /> Delete
              </button>
            )}
          </div>
          {confirming === "page" && (
            <p style={styles.dangerNote}>
              Deletes the page, every reference to it in other pages, its index entry and its embedding. The commit is permanent.
            </p>
          )}

          <div style={styles.panelBody}>
            {pageLoading && <div style={styles.panelLoading}><Loader2 size={16} className="animate-spin" /></div>}
            {!pageLoading && editMode && (
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                style={styles.editor}
                spellCheck={false}
              />
            )}
            {!pageLoading && !editMode && pageMd !== null && (
              <div className="markdown-body" style={styles.mdView}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayMarkdown(pageMd)}</ReactMarkdown>
              </div>
            )}
          </div>

          {!editMode && (
            <div style={styles.linkAdder}>
              <div style={styles.sectionLabel}><Link2 size={11} style={{ marginRight: 4 }} />Connect to another page</div>
              <input
                value={linkQuery}
                onChange={(e) => { setLinkQuery(e.target.value); setLinkTargetId(null); }}
                placeholder="Search a page to link..."
                style={styles.textInput}
              />
              {!linkTargetId && linkTargets.length > 0 && (
                <div style={styles.searchResults}>
                  {linkTargets.map((n) => (
                    <button
                      key={n.id}
                      style={styles.searchItem}
                      onClick={() => { setLinkQuery(n.title); setLinkLabel((l) => l || "related"); setLinkTargetId(n.id); }}
                    >
                      <span style={{ ...styles.dot, background: CATEGORY_COLORS[n.category] }} />
                      <span style={styles.searchItemText}>{n.title}</span>
                    </button>
                  ))}
                </div>
              )}
              {linkTargetId && (
                <div style={styles.linkConfirmRow}>
                  <input
                    value={linkLabel}
                    onChange={(e) => setLinkLabel(e.target.value)}
                    placeholder="relationship (e.g. extends)"
                    style={{ ...styles.textInput, flex: 1 }}
                  />
                  <button
                    style={{ ...styles.actionBtn, ...styles.actionPrimary }}
                    disabled={busy !== null}
                    onClick={() => createLink(selected.id, linkTargetId, linkLabel || "related")}
                  >
                    {busy === "link" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Link
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Link panel */}
      {selected?.type === "link" && (
        <div style={{ ...styles.panel, maxHeight: "none", height: "auto" }} className="animate-fade-in-scale">
          <div style={styles.panelHeader}>
            <span style={{ ...styles.categoryChip, background: selected.kind === "suggestion" ? "#7aa2ff" : "var(--color-secondary)" }}>
              {selected.kind === "suggestion" ? "suggested link" : "connection"}
            </span>
            <button style={styles.clearBtn} onClick={() => setSelected(null)} aria-label="Close panel">
              <X size={15} />
            </button>
          </div>
          <h2 style={styles.panelTitle}>
            {nodeById(selected.source)?.title ?? selected.source}
            <span style={{ opacity: 0.5 }}> ↔ </span>
            {nodeById(selected.target)?.title ?? selected.target}
          </h2>
          {selected.kind === "suggestion" ? (
            <>
              <p style={styles.panelNote}>
                These pages are {(selected.similarity! * 100).toFixed(0)}% similar but not linked yet. Materialize the link?
              </p>
              <div style={styles.linkConfirmRow}>
                <input
                  value={linkLabel}
                  onChange={(e) => setLinkLabel(e.target.value)}
                  placeholder="relationship (e.g. related)"
                  style={{ ...styles.textInput, flex: 1 }}
                />
                <button
                  style={{ ...styles.actionBtn, ...styles.actionPrimary }}
                  disabled={busy !== null}
                  onClick={() => createLink(selected.source, selected.target, linkLabel || "related")}
                >
                  {busy === "link" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Create link
                </button>
              </div>
            </>
          ) : (
            <div style={styles.panelActions}>
              {confirming === "link" ? (
                <>
                  <button style={{ ...styles.actionBtn, ...styles.actionDanger }} onClick={deleteLink} disabled={busy !== null}>
                    {busy === "unlink" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Confirm removal
                  </button>
                  <button style={styles.actionBtn} onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <button style={{ ...styles.actionBtn, ...styles.actionDangerGhost }} onClick={() => setConfirming("link")}>
                  <Trash2 size={13} /> Delete connection
                </button>
              )}
            </div>
          )}
          {confirming === "link" && (
            <p style={styles.dangerNote}>Removes the wikilink from both pages (text is kept) and commits the change.</p>
          )}
        </div>
      )}

      {/* Loading / error / empty */}
      {loading && (
        <div style={styles.center}>
          <div style={styles.centerCard}>
            <Loader2 size={22} className="animate-spin" />
            <span style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>Reading the vault...</span>
          </div>
        </div>
      )}
      {!loading && error && (
        <div style={styles.center}>
          <div style={styles.centerCard}>
            <p style={{ fontSize: 14, marginBottom: 12 }}>{error}</p>
            <button style={styles.actionBtn} onClick={() => fetchGraph(true)}>Retry</button>
          </div>
        </div>
      )}
      {!loading && !error && data && data.nodes.length === 0 && (
        <div style={styles.center}>
          <div style={styles.centerCard}>
            <p style={{ fontSize: 14, opacity: 0.75 }}>The vault has no wiki pages yet. Ask the agent to save something first.</p>
          </div>
        </div>
      )}

      {toast && <div style={styles.toast} className="animate-fade-in">{toast}</div>}
    </div>
  );
}

function SliderRow({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={styles.sliderRow}>
      <span style={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={styles.sliderValue}>{value}</span>
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    inset: 0,
    background: "radial-gradient(circle at 20% 10%, color-mix(in srgb, var(--color-secondary) 18%, transparent), transparent 28%), radial-gradient(circle at 90% 80%, color-mix(in srgb, #7aa2ff 14%, transparent), transparent 30%), var(--color-background)",
    color: "var(--color-text-primary)",
    overflow: "hidden",
    fontFamily: "var(--font-family)",
  },
  ambientOne: {
    position: "absolute",
    width: 420,
    height: 420,
    left: -120,
    top: -140,
    borderRadius: "50%",
    background: "color-mix(in srgb, var(--color-secondary) 20%, transparent)",
    filter: "blur(70px)",
    opacity: 0.45,
    pointerEvents: "none",
  },
  ambientTwo: {
    position: "absolute",
    width: 520,
    height: 520,
    right: -180,
    bottom: -180,
    borderRadius: "50%",
    background: "color-mix(in srgb, #7aa2ff 18%, transparent)",
    filter: "blur(90px)",
    opacity: 0.4,
    pointerEvents: "none",
  },
  canvas: { position: "absolute", inset: 0, zIndex: 1 },
  topBar: {
    position: "absolute",
    top: 16,
    left: 16,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    borderRadius: "20px",
    background: "linear-gradient(135deg, color-mix(in srgb, var(--color-surface) 90%, transparent), color-mix(in srgb, var(--color-surface) 72%, transparent))",
    backdropFilter: "blur(22px) saturate(1.2)",
    WebkitBackdropFilter: "blur(22px) saturate(1.2)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    boxShadow: "0 16px 50px rgba(0, 0, 0, 0.22)",
    zIndex: 10,
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    borderRadius: 12,
    background: "color-mix(in srgb, var(--color-background) 72%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    color: "var(--color-text-primary)",
    textDecoration: "none",
  },
  titleStack: { display: "flex", flexDirection: "column", minWidth: 118 },
  eyebrow: {
    fontSize: 10,
    lineHeight: 1,
    fontWeight: 700,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: "var(--color-text-muted)",
  },
  pageTitle: { fontSize: 15, fontWeight: 750, letterSpacing: "-0.03em", lineHeight: 1.25 },
  counts: {
    padding: "6px 9px",
    borderRadius: 999,
    fontSize: 12,
    color: "var(--color-text-muted)",
    background: "color-mix(in srgb, var(--color-background) 70%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 65%, transparent)",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    background: "transparent",
    color: "var(--color-text-primary)",
    cursor: "pointer",
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  iconBtnActive: {
    background: "color-mix(in srgb, var(--color-secondary) 16%, var(--color-background))",
    borderColor: "color-mix(in srgb, var(--color-secondary) 40%, var(--color-border))",
  },
  localBanner: {
    position: "absolute",
    top: 78,
    left: 16,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    fontSize: 12,
    borderRadius: "14px",
    background: "color-mix(in srgb, var(--color-surface) 90%, transparent)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    boxShadow: "0 12px 34px rgba(0, 0, 0, 0.18)",
    zIndex: 10,
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  depthBtn: {
    padding: "3px 8px",
    fontSize: 11,
    borderRadius: 6,
    border: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-primary)",
    cursor: "pointer",
  },
  controls: {
    position: "absolute",
    bottom: 16,
    right: 16,
    width: 304,
    padding: 16,
    borderRadius: "22px",
    background: "linear-gradient(180deg, color-mix(in srgb, var(--color-surface) 93%, transparent), color-mix(in srgb, var(--color-surface) 78%, transparent))",
    backdropFilter: "blur(24px) saturate(1.18)",
    WebkitBackdropFilter: "blur(24px) saturate(1.18)",
    border: "1px solid color-mix(in srgb, var(--color-border) 68%, transparent)",
    boxShadow: "0 22px 70px rgba(0, 0, 0, 0.26)",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 14, fontWeight: 750, letterSpacing: "-0.02em" },
  cardSubtle: { marginTop: 2, fontSize: 11.5, color: "var(--color-text-muted)" },
  suggestionPill: {
    flexShrink: 0,
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 650,
    color: "#7aa2ff",
    background: "color-mix(in srgb, #7aa2ff 14%, transparent)",
    border: "1px solid color-mix(in srgb, #7aa2ff 24%, transparent)",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 10px",
    borderRadius: 14,
    border: "1px solid color-mix(in srgb, var(--color-border) 85%, transparent)",
    background: "color-mix(in srgb, var(--color-background) 78%, transparent)",
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--color-text-primary)",
    fontSize: 13,
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  statCard: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "10px 11px",
    borderRadius: 15,
    background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 62%, transparent)",
  },
  statValue: { fontSize: 18, fontWeight: 800, letterSpacing: "-0.04em" },
  statLabel: { fontSize: 10.5, color: "var(--color-text-muted)" },
  searchResults: {
    display: "flex",
    flexDirection: "column",
    borderRadius: 13,
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    overflow: "hidden",
  },
  searchItem: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 10px",
    fontSize: 12.5,
    border: "none",
    borderBottom: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
    background: "color-mix(in srgb, var(--color-background) 78%, transparent)",
    color: "var(--color-text-primary)",
    cursor: "pointer",
    textAlign: "left",
  },
  searchItemText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  sectionLabel: {
    marginTop: 8,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--color-text-muted)",
    display: "flex",
    alignItems: "center",
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12.5,
    cursor: "pointer",
    padding: "6px 8px",
    borderRadius: 11,
    background: "color-mix(in srgb, var(--color-background) 38%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
  },
  checkLabel: { textTransform: "capitalize" as const },
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    padding: "4px 0",
  },
  sliderLabel: { width: 78, flexShrink: 0, color: "var(--color-text-muted)" },
  sliderValue: { width: 30, textAlign: "right", fontSize: 11, color: "var(--color-text-muted)" },
  hint: {
    marginTop: 10,
    padding: "10px 11px",
    fontSize: 11,
    lineHeight: 1.45,
    color: "var(--color-text-muted)",
    borderRadius: 14,
    background: "color-mix(in srgb, var(--color-background) 45%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
  },
  panel: {
    position: "absolute",
    bottom: 16,
    left: 16,
    width: 430,
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "min(620px, calc(100vh - 110px))",
    display: "flex",
    flexDirection: "column",
    padding: 18,
    borderRadius: "24px",
    background: "linear-gradient(180deg, color-mix(in srgb, var(--color-surface) 94%, transparent), color-mix(in srgb, var(--color-surface) 80%, transparent))",
    backdropFilter: "blur(26px) saturate(1.2)",
    WebkitBackdropFilter: "blur(26px) saturate(1.2)",
    border: "1px solid color-mix(in srgb, var(--color-border) 68%, transparent)",
    boxShadow: "0 28px 80px rgba(0, 0, 0, 0.32)",
    zIndex: 11,
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  panelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  categoryChip: {
    padding: "4px 10px",
    fontSize: 10.5,
    fontWeight: 750,
    borderRadius: 999,
    color: "#fff",
    letterSpacing: 0.3,
    textTransform: "capitalize" as const,
  },
  clearBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
    color: "var(--color-text-muted)",
    cursor: "pointer",
    padding: 5,
    borderRadius: 10,
  },
  panelTitle: { fontSize: 20, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.2, marginBottom: 8 },
  panelMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    fontSize: 11,
    color: "var(--color-text-muted)",
    marginBottom: 14,
  },
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    padding: "2px 6px",
    borderRadius: 7,
    background: "color-mix(in srgb, var(--color-background) 52%, transparent)",
  },
  panelActions: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  actionBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "7px 12px",
    fontSize: 12.5,
    fontWeight: 650,
    borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
    background: "color-mix(in srgb, var(--color-background) 72%, transparent)",
    color: "var(--color-text-primary)",
    cursor: "pointer",
    transition: "all 0.2s cubic-bezier(0.23, 1, 0.32, 1)",
  },
  actionPrimary: {
    background: "var(--color-text-primary)",
    color: "var(--color-background)",
    borderColor: "var(--color-text-primary)",
  },
  actionDanger: { background: "#c0392b", borderColor: "#c0392b", color: "#fff" },
  actionDangerGhost: { color: "#ff6b5a", borderColor: "#c0392b55", background: "color-mix(in srgb, #c0392b 8%, transparent)" },
  dangerNote: {
    fontSize: 11.5,
    lineHeight: 1.45,
    color: "#ff6b5a",
    marginBottom: 10,
    padding: "9px 10px",
    borderRadius: 12,
    background: "color-mix(in srgb, #c0392b 10%, transparent)",
    border: "1px solid color-mix(in srgb, #c0392b 24%, transparent)",
  },
  panelNote: {
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--color-text-muted)",
    margin: "6px 0 12px",
    padding: "10px 11px",
    borderRadius: 14,
    background: "color-mix(in srgb, var(--color-background) 46%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 46%, transparent)",
  },
  panelBody: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    borderRadius: 16,
    paddingRight: 2,
  },
  panelLoading: { display: "flex", justifyContent: "center", padding: 24 },
  mdView: {
    fontSize: 13.5,
    lineHeight: 1.6,
    padding: "2px 2px 4px",
  },
  editor: {
    width: "100%",
    minHeight: 280,
    resize: "vertical",
    padding: 12,
    fontSize: 12,
    lineHeight: 1.5,
    fontFamily: "var(--font-mono)",
    borderRadius: 14,
    border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
    background: "color-mix(in srgb, var(--color-background) 82%, transparent)",
    color: "var(--color-text-primary)",
    outline: "none",
  },
  linkAdder: {
    marginTop: 12,
    padding: 12,
    borderRadius: 17,
    background: "color-mix(in srgb, var(--color-background) 42%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 46%, transparent)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  textInput: {
    padding: "9px 10px",
    fontSize: 12.5,
    borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
    background: "color-mix(in srgb, var(--color-background) 76%, transparent)",
    color: "var(--color-text-primary)",
    outline: "none",
  },
  linkConfirmRow: { display: "flex", gap: 6, alignItems: "center" },
  center: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
    textAlign: "center",
    padding: 24,
  },
  centerCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    maxWidth: 380,
    padding: "22px 24px",
    borderRadius: 24,
    background: "color-mix(in srgb, var(--color-surface) 86%, transparent)",
    backdropFilter: "blur(22px)",
    WebkitBackdropFilter: "blur(22px)",
    border: "1px solid color-mix(in srgb, var(--color-border) 65%, transparent)",
    boxShadow: "0 24px 70px rgba(0, 0, 0, 0.25)",
  },
  toast: {
    position: "absolute",
    bottom: 20,
    left: "50%",
    transform: "translateX(-50%)",
    padding: "10px 16px",
    fontSize: 13,
    borderRadius: 999,
    background: "color-mix(in srgb, var(--color-text-primary) 92%, transparent)",
    color: "var(--color-background)",
    boxShadow: "0 16px 44px rgba(0, 0, 0, 0.28)",
    zIndex: 20,
    maxWidth: "80vw",
  },
};
