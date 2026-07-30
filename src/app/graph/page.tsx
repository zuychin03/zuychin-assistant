"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft, Clock, Crosshair, Layers, Loader2, RefreshCw, Route, SlidersHorizontal, Type,
} from "lucide-react";
import { COSMOS, LENSES, TRUST_BUCKETS, type Lens, type TrustBucket } from "./cosmos/palette";
import { styles } from "./cosmos/styles";
import { createCosmos, DEFAULT_PHYSICS, type Cosmos, type PhysicsSettings, type Quality } from "./cosmos/scene";
import { createLabelLayer, type LabelLayer } from "./cosmos/labels";
import {
    buildAdjacency, createView, deriveVisible, earliestCreated, endpoints, pathLinkKeys,
    shortestPath, type ApiGraph, type GLink, type GNode, type NodeHealth, type SelectedLink,
} from "./cosmos/model";
import { parseSections } from "./cosmos/sections";
import ExplorePanel, { type SearchHit } from "./panels/explore-panel";
import LensPanel from "./panels/lens-panel";
import { ClustersPanel, HealthPanel, HubsPanel } from "./panels/insight-panels";
import PagePanel, { LinkPanel, type PageSuggestion } from "./panels/page-panel";
import PathPanel from "./panels/path-panel";
import TimelineBar from "./panels/timeline-bar";

type Selection = { type: "node"; id: string } | { type: "link"; link: SelectedLink } | null;

const MARKDOWN_CSS = `
.graph-markdown h1,.graph-markdown h2,.graph-markdown h3{font-size:13.5px;font-weight:700;margin:12px 0 5px;color:#e8ecf8}
.graph-markdown p{margin:0 0 8px}
.graph-markdown ul,.graph-markdown ol{margin:0 0 8px;padding-left:18px}
.graph-markdown li{margin:2px 0}
.graph-markdown code{background:rgba(148,163,201,0.14);padding:1px 4px;border-radius:4px;font-size:11.5px}
.graph-markdown pre{background:rgba(4,6,11,0.7);padding:9px;border-radius:9px;overflow-x:auto;margin:0 0 9px}
.graph-markdown a{color:#8fc2ff}
.graph-markdown table{border-collapse:collapse;font-size:11.5px;margin:0 0 9px}
.graph-markdown th,.graph-markdown td{border:1px solid rgba(126,141,184,0.22);padding:3px 7px}
.graph-markdown blockquote{margin:0 0 9px;padding-left:9px;border-left:2px solid rgba(126,141,184,0.35);color:#98a2bd}
.cosmos-rail::-webkit-scrollbar{width:7px}
.cosmos-rail::-webkit-scrollbar-thumb{background:rgba(126,141,184,0.26);border-radius:99px}
.cosmos-rail::-webkit-scrollbar-track{background:transparent}
`;

export default function GraphPage() {
    const containerRef = useRef<HTMLDivElement>(null);
    const cosmosRef = useRef<Cosmos | null>(null);
    const labelsRef = useRef<LabelLayer | null>(null);
    const viewRef = useRef(createView());
    const nodeCache = useRef(new Map<string, GNode>());
    const linkCache = useRef(new Map<string, GLink>());
    const searchInputRef = useRef<HTMLInputElement>(null);
    const urlLoaded = useRef(false);

    const [data, setData] = useState<ApiGraph | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    const [railOpen, setRailOpen] = useState(true);
    const [viewport, setViewport] = useState({ width: 1440, height: 900 });
    // The top bar wraps on narrow panes, so the rails cannot use a fixed offset.
    const topBarRef = useRef<HTMLDivElement>(null);
    const [railTop, setRailTop] = useState(68);
    const [lens, setLens] = useState<Lens>("category");
    const [categoryFilter, setCategoryFilter] = useState<Record<string, boolean>>({});
    const [showOrphans, setShowOrphans] = useState(true);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [physics, setPhysics] = useState<PhysicsSettings>(DEFAULT_PHYSICS);
    const [quality, setQuality] = useState<Quality>("auto");
    const [bloomActive, setBloomActive] = useState(false);
    const [labelsOn, setLabelsOn] = useState(true);

    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [activeHit, setActiveHit] = useState(0);

    const [localRoot, setLocalRoot] = useState<string | null>(null);
    const [localDepth, setLocalDepth] = useState<1 | 2>(1);
    const [findings, setFindings] = useState<NodeHealth[]>([]);
    const [trustFilter, setTrustFilter] = useState<TrustBucket[]>([]);

    const [routeFrom, setRouteFrom] = useState<string | null>(null);
    const [routeTo, setRouteTo] = useState<string | null>(null);

    const [timeActive, setTimeActive] = useState(false);
    const [timeValue, setTimeValue] = useState(Date.now());
    const [timePlaying, setTimePlaying] = useState(false);

    const [selected, setSelected] = useState<Selection>(null);
    const [pageMd, setPageMd] = useState<string | null>(null);
    const [pageLoading, setPageLoading] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [editText, setEditText] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);

    const [suggestions, setSuggestions] = useState<PageSuggestion[]>([]);
    const [suggestionsLoading, setSuggestionsLoading] = useState(false);
    const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());

    const [linkQuery, setLinkQuery] = useState("");
    const [linkLabel, setLinkLabel] = useState("");
    const [linkTargetId, setLinkTargetId] = useState<string | null>(null);

    // Matched back to a rendered heading by title, not slug: slugs carry collision
    // suffixes that would not survive a round trip through the DOM.
    const [focusedSection, setFocusedSection] = useState<{ id: string; title: string } | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const showToast = useCallback((message: string) => {
        setToast(message);
        window.setTimeout(() => setToast(null), 3600);
    }, []);

    // ---- Data ----

    const fetchGraph = useCallback(async (mode: "initial" | "refresh" | "rebuild") => {
        if (mode === "initial") setLoading(true);
        else setRefreshing(true);
        try {
            const url = mode === "rebuild" ? "/api/vault/graph?refresh=1" : "/api/vault/graph";
            const response = await fetch(url);
            const json = await response.json();
            if (!response.ok) throw new Error(json.error || "Failed to load the graph.");
            setData(json as ApiGraph);
            setError(null);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Failed to load the graph.");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { void fetchGraph("initial"); }, [fetchGraph]);

    const nodeById = useMemo(() => {
        const map = new Map<string, GNode>();
        for (const node of data?.nodes ?? []) map.set(node.id, node);
        return map;
    }, [data]);

    const titleOf = useCallback(
        (path: string) => nodeById.get(path)?.title ?? path.replace(/\.md$/, "").split("/").pop() ?? path,
        [nodeById],
    );

    const adjacency = useMemo(() => buildAdjacency(data?.edges ?? []), [data]);

    const timeBounds = useMemo(() => {
        const earliest = earliestCreated(data?.nodes ?? []);
        return { start: earliest ?? Date.now() - 86_400_000, end: Date.now() };
    }, [data]);

    const visible = useMemo(() => {
        if (!data) return { nodes: [] as GNode[], links: [] as GLink[] };
        return deriveVisible({
            data,
            adjacency,
            categoryFilter,
            showOrphans,
            showSuggestions,
            localRoot,
            localDepth,
            timeCutoff: timeActive ? timeValue : null,
            onlyFindings: findings.length > 0 ? findings : null,
            onlyTrust: trustFilter.length > 0 ? trustFilter : null,
            nodeCache: nodeCache.current,
            linkCache: linkCache.current,
        });
    }, [data, adjacency, categoryFilter, showOrphans, showSuggestions, localRoot, localDepth, timeActive, timeValue, findings, trustFilter]);

    const path = useMemo(() => {
        if (!routeFrom || !routeTo) return [];
        return shortestPath(routeFrom, routeTo, adjacency);
    }, [routeFrom, routeTo, adjacency]);

    // ---- URL state ----

    useEffect(() => {
        if (urlLoaded.current) return;
        urlLoaded.current = true;
        const params = new URLSearchParams(window.location.search);

        const urlLens = params.get("lens");
        if (urlLens && (LENSES as readonly string[]).includes(urlLens)) setLens(urlLens as Lens);
        const urlQuery = params.get("q");
        if (urlQuery) setQuery(urlQuery);
        const categories = params.get("cat");
        if (categories) {
            const allowed = new Set(categories.split(",").filter(Boolean));
            setCategoryFilter(Object.fromEntries(
                ["sources", "concepts", "entities", "synthesis"].map((category) => [category, allowed.has(category)]),
            ));
        }
        if (params.get("sug") === "1") setShowSuggestions(true);
        if (params.get("quality") === "plain") setQuality("plain");
        const trustParam = params.get("trust");
        if (trustParam) {
            const buckets = trustParam
                .split(",")
                .filter((value): value is TrustBucket => (TRUST_BUCKETS as readonly string[]).includes(value));
            if (buckets.length > 0) setTrustFilter(buckets);
        }
        const from = params.get("from");
        const to = params.get("to");
        if (from) setRouteFrom(from);
        if (to) setRouteTo(to);
        const local = params.get("local");
        const node = params.get("node");
        if (node) {
            setSelected({ type: "node", id: node });
            if (local === "1" || local === "2") {
                setLocalRoot(node);
                setLocalDepth(local === "2" ? 2 : 1);
            }
        }
        const stamp = params.get("t");
        if (stamp) {
            const parsed = Date.parse(stamp);
            if (!Number.isNaN(parsed)) {
                setTimeActive(true);
                setTimeValue(parsed);
            }
        }
    }, []);

    useEffect(() => {
        if (!urlLoaded.current) return;
        const params = new URLSearchParams();
        if (lens !== "category") params.set("lens", lens);
        if (query) params.set("q", query);
        if (showSuggestions) params.set("sug", "1");
        if (quality === "plain") params.set("quality", "plain");
        if (routeFrom) params.set("from", routeFrom);
        if (routeTo) params.set("to", routeTo);
        if (selected?.type === "node") params.set("node", selected.id);
        if (localRoot) params.set("local", String(localDepth));
        if (timeActive) params.set("t", new Date(timeValue).toISOString().slice(0, 10));
        if (trustFilter.length > 0) params.set("trust", trustFilter.join(","));
        const disabled = Object.entries(categoryFilter).filter(([, on]) => on === false);
        if (disabled.length > 0) {
            params.set("cat", Object.entries(categoryFilter).filter(([, on]) => on !== false).map(([key]) => key).join(","));
        }
        const search = params.toString();
        // replaceState, not push: dragging a slider must not fill the back stack.
        window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
    }, [lens, query, showSuggestions, quality, routeFrom, routeTo, selected, localRoot, localDepth, timeActive, timeValue, categoryFilter, trustFilter]);

    // ---- Selection ----

    const openNode = useCallback((id: string) => {
        setSelected({ type: "node", id });
        setEditMode(false);
        setConfirming(null);
        setLinkQuery("");
        setLinkLabel("");
        setLinkTargetId(null);
        setSuggestions([]);
        setSelectedSuggestions(new Set());
    }, []);

    // Selection drives the fetch, so a deep-linked ?node= loads exactly like a click.
    useEffect(() => {
        if (selected?.type !== "node") return;
        const path = selected.id;
        let cancelled = false;
        setPageMd(null);
        setPageLoading(true);
        (async () => {
            try {
                const response = await fetch(`/api/vault/page?path=${encodeURIComponent(path)}`);
                const json = await response.json();
                if (cancelled) return;
                if (!response.ok) throw new Error(json.error || "Failed to load the page.");
                setPageMd(json.markdown);
                setEditText(json.markdown);
            } catch (caught) {
                if (!cancelled) showToast(caught instanceof Error ? caught.message : "Failed to load the page.");
            } finally {
                if (!cancelled) setPageLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selected, showToast]);

    useEffect(() => {
        if (selected?.type !== "node") return;
        let cancelled = false;
        setSuggestionsLoading(true);
        (async () => {
            try {
                const response = await fetch(`/api/vault/suggestions?path=${encodeURIComponent(selected.id)}`);
                const json = await response.json();
                if (cancelled) return;
                setSuggestions(response.ok ? (json.suggestions ?? []).map((item: { target: string; similarity: number }) => item) : []);
            } catch {
                if (!cancelled) setSuggestions([]);
            } finally {
                if (!cancelled) setSuggestionsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selected]);

    const focusNode = useCallback((id: string) => {
        const node = nodeCache.current.get(id);
        if (node) cosmosRef.current?.flyTo(node);
        void openNode(id);
    }, [openNode]);

    // ---- Cosmos instance ----

    const handlersRef = useRef({
        onNodeClick: (node: GNode) => { void node; },
        onNodeDoubleClick: (node: GNode) => { void node; },
        onNodeRightClick: (node: GNode, event: MouseEvent) => { void node; void event; },
        onNodeHover: (node: GNode | null) => { void node; },
        onLinkClick: (link: GLink) => { void link; },
        onBackgroundClick: () => undefined,
        onSectionClick: (sectionId: string, title: string) => { void sectionId; void title; },
    });

    handlersRef.current = {
        onNodeClick: (node) => {
            void openNode(node.id);
            cosmosRef.current?.flyTo(node);
        },
        onNodeDoubleClick: (node) => setLocalRoot(node.id),
        onNodeRightClick: (node, event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY, id: node.id });
        },
        onNodeHover: (node) => {
            const view = viewRef.current;
            view.hover = node?.id ?? null;
            view.highlightNodes.clear();
            view.highlightLinks.clear();
            if (node) {
                view.highlightNodes.add(node.id);
                const links = (cosmosRef.current?.graph.graphData().links ?? []) as GLink[];
                for (const link of links) {
                    const { s, t } = endpoints(link);
                    if (s === node.id || t === node.id) {
                        view.highlightLinks.add(`${link.kind}:${[s, t].sort().join("|")}`);
                        view.highlightNodes.add(s === node.id ? t : s);
                    }
                }
            }
            cosmosRef.current?.restyle();
        },
        onLinkClick: (link) => {
            const { s, t } = endpoints(link);
            setConfirming(null);
            setSelected({ type: "link", link: { source: s, target: t, kind: link.kind, similarity: link.similarity } });
        },
        onBackgroundClick: () => {
            if (editMode) return;
            setContextMenu(null);
            setSelected(null);
            setConfirming(null);
        },
        onSectionClick: (sectionId, title) => setFocusedSection({ id: sectionId, title }),
    };

    useEffect(() => {
        const element = containerRef.current;
        if (!element || cosmosRef.current) return;
        let disposed = false;

        (async () => {
            const { default: ForceGraph3D } = await import("3d-force-graph");
            if (disposed || cosmosRef.current) return;

            const cosmos = createCosmos(
                element,
                ForceGraph3D as unknown as new (el: HTMLElement) => unknown,
                viewRef.current,
                {
                    onNodeClick: (node) => handlersRef.current.onNodeClick(node),
                    onNodeDoubleClick: (node) => handlersRef.current.onNodeDoubleClick(node),
                    onNodeRightClick: (node, event) => handlersRef.current.onNodeRightClick(node, event),
                    onNodeHover: (node) => handlersRef.current.onNodeHover(node),
                    onLinkClick: (link) => handlersRef.current.onLinkClick(link),
                    onBackgroundClick: () => handlersRef.current.onBackgroundClick(),
                    onSectionClick: (id, title) => handlersRef.current.onSectionClick(id, title),
                },
            );
            cosmosRef.current = cosmos;

            labelsRef.current = createLabelLayer({ container: element, graph: cosmos.graph, view: viewRef.current });
            labelsRef.current.start();

            const onResize = () => cosmos.resize(window.innerWidth, window.innerHeight);
            onResize();
            window.addEventListener("resize", onResize);
            (element as HTMLDivElement & { __cleanup?: () => void }).__cleanup = () => {
                window.removeEventListener("resize", onResize);
            };
            setReady(true);
        })();

        return () => {
            disposed = true;
            (element as HTMLDivElement & { __cleanup?: () => void }).__cleanup?.();
            labelsRef.current?.dispose();
            labelsRef.current = null;
            cosmosRef.current?.dispose();
            cosmosRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!ready || !cosmosRef.current) return;
        viewRef.current.hover = null;
        viewRef.current.highlightNodes.clear();
        viewRef.current.highlightLinks.clear();
        cosmosRef.current.setData(visible.nodes, visible.links);
        labelsRef.current?.setNodes(visible.nodes);
        setBloomActive(cosmosRef.current.bloomActive());
    }, [ready, visible]);

    useEffect(() => {
        if (ready && data) cosmosRef.current?.setClusters(data.clusters ?? []);
    }, [ready, data]);

    // The root's own headings become its planets. Only built when the loaded
    // markdown actually belongs to the local root, so selecting a neighbour while
    // in local mode never hangs that page's sections off this star.
    const systemSpec = useMemo(() => {
        if (!localRoot || selected?.type !== "node" || selected.id !== localRoot || !pageMd) return null;
        const root = nodeById.get(localRoot);
        if (!root) return null;
        const { planets } = parseSections(pageMd, root.title);
        return planets.length > 0 ? { rootId: localRoot, planets } : null;
    }, [localRoot, selected, pageMd, nodeById]);

    useEffect(() => {
        if (ready) cosmosRef.current?.setSystem(systemSpec);
    }, [ready, systemSpec]);

    useEffect(() => { setFocusedSection(null); }, [localRoot, selected]);

    useEffect(() => { if (ready) cosmosRef.current?.applyPhysics(physics); }, [ready, physics]);

    // A health filter can cut 44 stars down to 2. Without reframing they are almost
    // certainly off-screen and the graph just looks empty.
    useEffect(() => {
        if (!ready || (findings.length === 0 && trustFilter.length === 0)) return;
        const timer = window.setTimeout(() => cosmosRef.current?.frameAll(), 400);
        return () => window.clearTimeout(timer);
    }, [ready, findings, trustFilter]);

    useEffect(() => {
        if (!ready) return;
        cosmosRef.current?.setQuality(quality);
        setBloomActive(cosmosRef.current?.bloomActive() ?? false);
    }, [ready, quality]);

    // View-only state lives on a ref so hover and search never re-render the tree.
    useEffect(() => {
        viewRef.current.lens = lens;
        viewRef.current.labelsOn = labelsOn;
        viewRef.current.selectedNode = selected?.type === "node" ? selected.id : null;
        viewRef.current.selectedLink = selected?.type === "link" ? selected.link : null;
        cosmosRef.current?.restyle();
    }, [lens, labelsOn, selected]);

    useEffect(() => {
        const view = viewRef.current;
        view.pathNodes = new Set(path);
        view.pathLinks = pathLinkKeys(path);
        view.pathActive = path.length > 1;
        cosmosRef.current?.restyle();
        if (path.length < 2) return;
        // A corridor nobody can see is not an answer; frame the hops themselves.
        const timer = window.setTimeout(() => cosmosRef.current?.frameNodes(new Set(path)), 350);
        return () => window.clearTimeout(timer);
    }, [path]);

    // ---- Search ----

    useEffect(() => {
        const trimmed = query.trim();
        const view = viewRef.current;

        if (!trimmed) {
            view.searchScores = new Map();
            view.searchActive = false;
            setHits([]);
            setSearching(false);
            cosmosRef.current?.restyle();
            return;
        }

        // Instant local pass so typing feels responsive before the request lands.
        const lower = trimmed.toLowerCase();
        const local = (data?.nodes ?? [])
            .filter((node) => node.title.toLowerCase().includes(lower))
            .map((node) => ({ path: node.id, title: node.title, similarity: 0.55 }));
        view.searchScores = new Map(local.map((hit) => [hit.path, hit.similarity]));
        // Staying inactive on an empty result keeps the graph from blacking out while
        // the semantic request is still in flight.
        view.searchActive = local.length > 0;
        setHits(local.slice(0, 8));
        setActiveHit(0);
        cosmosRef.current?.restyle();

        let cancelled = false;
        setSearching(true);
        const timer = window.setTimeout(async () => {
            try {
                const response = await fetch(`/api/vault/search?q=${encodeURIComponent(trimmed)}`);
                const json = await response.json();
                if (cancelled || !response.ok) return;
                // Recall spans the whole knowledge store, including raw/ captures and
                // index.md, which are not graph nodes. Anything without a star would be
                // a dead row in the list and an invisible highlight on the canvas.
                const remote = (json.hits ?? []).filter((hit: SearchHit) => nodeById.has(hit.path)) as SearchHit[];
                const merged = new Map(view.searchScores);
                for (const hit of remote) {
                    merged.set(hit.path, Math.max(merged.get(hit.path) ?? 0, hit.similarity));
                }
                view.searchScores = merged;
                view.searchActive = merged.size > 0;
                const combined = [...merged.entries()]
                    .map(([nodePath, similarity]) => ({
                        path: nodePath,
                        title: nodeById.get(nodePath)?.title ?? nodePath,
                        similarity,
                    }))
                    .sort((a, b) => b.similarity - a.similarity);
                setHits(combined.slice(0, 8));
                cosmosRef.current?.restyle();
                // Bring the constellation the query lit up into view; without this the
                // hits can sit behind a rail and the graph just looks dark.
                const top = combined[0] && nodeCache.current.get(combined[0].path);
                if (top) cosmosRef.current?.flyTo(top, 190);
            } catch {
                // The local pass already gave usable results.
            } finally {
                if (!cancelled) setSearching(false);
            }
        }, 250);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            setSearching(false);
        };
    }, [query, data, nodeById]);

    // ---- Mutations ----

    const patch = useCallback((fn: (graph: ApiGraph) => ApiGraph) => {
        setData((current) => (current ? fn(current) : current));
    }, []);

    const savePage = async () => {
        if (selected?.type !== "node") return;
        setBusy("save");
        try {
            const response = await fetch("/api/vault/page", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: selected.id, markdown: editText }),
            });
            const json = await response.json();
            if (!response.ok) throw new Error(json.error || "Save failed.");
            setPageMd(editText);
            setEditMode(false);
            showToast("Page saved and committed.");
            void fetchGraph("rebuild");
        } catch (caught) {
            showToast(caught instanceof Error ? caught.message : "Save failed.");
        } finally {
            setBusy(null);
        }
    };

    const deletePage = async () => {
        if (selected?.type !== "node") return;
        const id = selected.id;
        setBusy("delete");
        try {
            const response = await fetch(`/api/vault/page?path=${encodeURIComponent(id)}`, { method: "DELETE" });
            const json = await response.json();
            if (!response.ok) throw new Error(json.error || "Delete failed.");
            nodeCache.current.delete(id);
            patch((graph) => ({
                ...graph,
                nodes: graph.nodes.filter((node) => node.id !== id),
                edges: graph.edges.filter((edge) => edge.source !== id && edge.target !== id),
                suggestions: graph.suggestions.filter((s) => s.source !== id && s.target !== id),
            }));
            setSelected(null);
            if (localRoot === id) setLocalRoot(null);
            if (routeFrom === id) setRouteFrom(null);
            if (routeTo === id) setRouteTo(null);
            showToast(`Page deleted; ${json.changedPages?.length ?? 0} reference(s) cleaned.`);
            void fetchGraph("rebuild");
        } catch (caught) {
            showToast(caught instanceof Error ? caught.message : "Delete failed.");
        } finally {
            setBusy(null);
            setConfirming(null);
        }
    };

    const deleteLink = async () => {
        if (selected?.type !== "link") return;
        const { source, target } = selected.link;
        setBusy("unlink");
        try {
            const response = await fetch(
                `/api/vault/link?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
                { method: "DELETE" },
            );
            const json = await response.json();
            if (!response.ok) throw new Error(json.error || "Unlink failed.");
            linkCache.current.delete(`real:${[source, target].sort().join("|")}`);
            patch((graph) => ({
                ...graph,
                edges: graph.edges.filter(
                    (edge) => [edge.source, edge.target].sort().join("|") !== [source, target].sort().join("|"),
                ),
            }));
            setSelected(null);
            showToast("Connection removed from both pages.");
            void fetchGraph("rebuild");
        } catch (caught) {
            showToast(caught instanceof Error ? caught.message : "Unlink failed.");
        } finally {
            setBusy(null);
            setConfirming(null);
        }
    };

    const createLink = useCallback(async (source: string, target: string, label: string) => {
        const response = await fetch("/api/vault/link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source, target, label }),
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Link failed.");
        patch((graph) => ({
            ...graph,
            edges: [...graph.edges, { source, target, mutual: true }],
            suggestions: graph.suggestions.filter(
                (s) => [s.source, s.target].sort().join("|") !== [source, target].sort().join("|"),
            ),
        }));
    }, [patch]);

    const linkOne = async (source: string, target: string, label: string) => {
        setBusy("link");
        try {
            await createLink(source, target, label);
            setSuggestions((current) => current.filter((item) => item.target !== target));
            setSelectedSuggestions((current) => {
                const next = new Set(current);
                next.delete(target);
                return next;
            });
            setLinkQuery("");
            setLinkLabel("");
            setLinkTargetId(null);
            if (selected?.type === "link") setSelected(null);
            showToast("Pages linked.");
            void fetchGraph("rebuild");
        } catch (caught) {
            showToast(caught instanceof Error ? caught.message : "Link failed.");
        } finally {
            setBusy(null);
        }
    };

    const linkSelectedSuggestions = async () => {
        if (selected?.type !== "node" || selectedSuggestions.size === 0) return;
        const targets = [...selectedSuggestions];
        setBusy("link");
        let linked = 0;
        // Sequential on purpose: each link is its own vault commit, and the vault
        // lock would serialise these anyway.
        for (const target of targets) {
            try {
                await createLink(selected.id, target, "related");
                linked++;
            } catch (caught) {
                showToast(caught instanceof Error ? caught.message : "One link failed.");
            }
        }
        setSuggestions((current) => current.filter((item) => !selectedSuggestions.has(item.target)));
        setSelectedSuggestions(new Set());
        setBusy(null);
        showToast(`Linked ${linked} of ${targets.length} page${targets.length === 1 ? "" : "s"}.`);
        void fetchGraph("rebuild");
    };

    // ---- Keyboard ----

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

            if (event.key === "/" && !typing) {
                event.preventDefault();
                searchInputRef.current?.focus();
                return;
            }
            if (event.key === "Escape") {
                if (editMode) return;
                if (contextMenu) { setContextMenu(null); return; }
                if (selected) { setSelected(null); setConfirming(null); return; }
                if (routeFrom || routeTo) { setRouteFrom(null); setRouteTo(null); return; }
                if (localRoot) { setLocalRoot(null); return; }
                if (timeActive) { setTimeActive(false); setTimePlaying(false); }
                return;
            }
            if (typing) return;

            if (event.key >= "1" && event.key <= "5") {
                setLens(LENSES[Number(event.key) - 1]);
                return;
            }
            if (event.key === "f") { cosmosRef.current?.frameAll(); return; }
            if (event.key === "r") { setPhysics(DEFAULT_PHYSICS); return; }
            if (event.key === "l") { setLabelsOn((on) => !on); return; }
            if (event.key === " " && timeActive) {
                event.preventDefault();
                setTimePlaying((playing) => !playing);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [editMode, selected, routeFrom, routeTo, localRoot, timeActive, contextMenu]);

    // ---- Derived panel inputs ----

    const linkTargets = useMemo(() => {
        const trimmed = linkQuery.trim().toLowerCase();
        if (!trimmed || !data || selected?.type !== "node" || linkTargetId) return [];
        const connected = adjacency.get(selected.id) ?? new Set<string>();
        return data.nodes
            .filter((node) => node.id !== selected.id && !connected.has(node.id) && node.title.toLowerCase().includes(trimmed))
            .slice(0, 6);
    }, [linkQuery, data, selected, adjacency, linkTargetId]);

    const selectedNode = selected?.type === "node" ? nodeById.get(selected.id) : undefined;

    const rightPanelOpen = Boolean(selected) || Boolean(routeFrom || routeTo);
    // Both rails cannot fit side by side on a narrow window, and the right one is
    // always the thing the user just asked for.
    const leftRailVisible = railOpen && !(viewport.width < 1080 && rightPanelOpen);

    useEffect(() => {
        const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
        onResize();
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    useEffect(() => {
        const element = topBarRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            setRailTop(Math.round(entry.contentRect.height) + 22);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        viewRef.current.labelSafeArea = {
            left: leftRailVisible ? 316 : 0,
            right: rightPanelOpen ? Math.min(380, viewport.width - 32) + 24 : 0,
        };
    }, [leftRailVisible, rightPanelOpen, viewport.width]);

    return (
        <div style={styles.root}>
            <style>{MARKDOWN_CSS}</style>
            <div style={styles.nebulaOne} />
            <div style={styles.nebulaTwo} />
            <div ref={containerRef} style={styles.canvas} />

            <div style={styles.topBar} ref={topBarRef}>
                <div style={styles.topBarGroup}>
                    <Link href="/" style={styles.backBtn} aria-label="Back to chat" title="Back to chat">
                        <ArrowLeft size={16} />
                    </Link>
                    <div style={styles.titleStack}>
                        <span style={styles.eyebrow}>Second Brain</span>
                        <span style={styles.pageTitle}>Knowledge Cosmos</span>
                    </div>
                </div>

                <div style={styles.topBarSpacer} />

                <div style={styles.topBarGroup}>
                    {data && (
                        <span style={styles.counts}>
                            {viewport.width < 760
                                ? `${visible.nodes.length}/${data.nodes.length}`
                                : `${visible.nodes.length}/${data.nodes.length} stars · ${visible.links.length} filaments`}
                        </span>
                    )}
                    {data?.stale && (
                        <span style={styles.staleDot} title="Serving a cached snapshot; a rebuild is running">
                            <Clock size={11} /> refreshing
                        </span>
                    )}
                    <button
                        onClick={() => setLabelsOn((on) => !on)}
                        style={{ ...styles.iconBtn, ...(labelsOn ? styles.iconBtnActive : {}) }}
                        aria-label="Toggle labels"
                        title="Labels (l)"
                    >
                        <Type size={14} />
                    </button>
                    <button
                        onClick={() => { setTimeActive((on) => !on); setTimeValue(timeBounds.end); setTimePlaying(false); }}
                        style={{ ...styles.iconBtn, ...(timeActive ? styles.iconBtnActive : {}) }}
                        aria-label="Toggle time travel"
                        title="Time travel"
                    >
                        <Clock size={14} />
                    </button>
                    <button
                        onClick={() => void fetchGraph("rebuild")}
                        style={styles.iconBtn}
                        aria-label="Rebuild graph"
                        title="Rebuild from the vault"
                        disabled={refreshing}
                    >
                        <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
                    </button>
                    <button
                        onClick={() => setRailOpen((open) => !open)}
                        style={{ ...styles.iconBtn, ...(railOpen ? styles.iconBtnActive : {}) }}
                        aria-label="Toggle controls"
                        title="Controls"
                    >
                        <SlidersHorizontal size={14} />
                    </button>
                </div>
            </div>

            {localRoot && (
                <div style={{ ...styles.banner, top: railTop }} className="animate-fade-in-scale">
                    <Crosshair size={12} />
                    <span>System: <b>{titleOf(localRoot)}</b></span>
                    <button style={styles.chip} onClick={() => setLocalDepth((depth) => (depth === 1 ? 2 : 1))}>
                        {localDepth} hop{localDepth > 1 ? "s" : ""}
                    </button>
                    <button style={styles.chip} onClick={() => setLocalRoot(null)}>Exit (Esc)</button>
                </div>
            )}

            {leftRailVisible && (
                <div style={{ ...styles.leftRail, top: railTop }} className="cosmos-rail">
                    <ExplorePanel
                        query={query}
                        onQueryChange={setQuery}
                        searching={searching}
                        hits={hits}
                        activeHit={activeHit}
                        onPickHit={focusNode}
                        visibleNodes={visible.nodes.length}
                        visibleLinks={visible.links.length}
                        totalNodes={data?.nodes.length ?? 0}
                        categoryFilter={categoryFilter}
                        onToggleCategory={(category) =>
                            setCategoryFilter((current) => ({ ...current, [category]: current[category] === false }))
                        }
                        showOrphans={showOrphans}
                        onShowOrphans={setShowOrphans}
                        showSuggestions={showSuggestions}
                        onShowSuggestions={setShowSuggestions}
                        suggestionCount={data?.suggestions.length ?? 0}
                        physics={physics}
                        onPhysics={setPhysics}
                        quality={quality}
                        onQuality={setQuality}
                        bloomActive={bloomActive}
                        searchInputRef={searchInputRef}
                    />
                    <LensPanel
                        lens={lens}
                        onLens={setLens}
                        clusters={data?.clusters ?? []}
                        nodes={data?.nodes ?? []}
                        trustFilter={trustFilter}
                        onToggleTrust={(bucket) =>
                            setTrustFilter((current) =>
                                current.includes(bucket)
                                    ? current.filter((item) => item !== bucket)
                                    : [...current, bucket],
                            )
                        }
                    />
                    <ClustersPanel clusters={data?.clusters ?? []} onFocus={focusNode} />
                    {data && (
                        <HealthPanel
                            health={data.health}
                            nodes={data.nodes}
                            activeFindings={findings}
                            onToggleFinding={(finding) =>
                                setFindings((current) =>
                                    current.includes(finding)
                                        ? current.filter((item) => item !== finding)
                                        : [...current, finding],
                                )
                            }
                            onFocus={focusNode}
                        />
                    )}
                    <HubsPanel nodes={data?.nodes ?? []} onFocus={focusNode} />
                </div>
            )}

            <div style={{ ...styles.rightRail, top: railTop }} className="cosmos-rail">
                {(routeFrom || routeTo) && (
                    <PathPanel
                        from={routeFrom}
                        to={routeTo}
                        path={path}
                        titleOf={titleOf}
                        onFocus={focusNode}
                        onClear={() => { setRouteFrom(null); setRouteTo(null); }}
                        onSwap={() => { setRouteFrom(routeTo); setRouteTo(routeFrom); }}
                    />
                )}

                {selectedNode && selected?.type === "node" && (
                    <PagePanel
                        node={selectedNode}
                        markdown={pageMd}
                        loading={pageLoading}
                        editMode={editMode}
                        editText={editText}
                        busy={busy}
                        confirming={confirming}
                        suggestions={suggestions}
                        suggestionsLoading={suggestionsLoading}
                        selectedSuggestions={selectedSuggestions}
                        linkQuery={linkQuery}
                        linkTargets={linkTargets}
                        linkTargetId={linkTargetId}
                        linkLabel={linkLabel}
                        focusedSection={focusedSection}
                        onClearSection={() => setFocusedSection(null)}
                        titleOf={titleOf}
                        onClose={() => { setSelected(null); setConfirming(null); }}
                        onEdit={() => setEditMode(true)}
                        onCancelEdit={() => { setEditMode(false); setEditText(pageMd ?? ""); }}
                        onEditText={setEditText}
                        onSave={() => void savePage()}
                        onDelete={() => void deletePage()}
                        onConfirm={setConfirming}
                        onFocus={focusNode}
                        onLocal={() => setLocalRoot(selected.id)}
                        onRouteFrom={() => setRouteFrom(selected.id)}
                        onRouteTo={() => setRouteTo(selected.id)}
                        onToggleSuggestion={(target) =>
                            setSelectedSuggestions((current) => {
                                const next = new Set(current);
                                if (next.has(target)) next.delete(target);
                                else next.add(target);
                                return next;
                            })
                        }
                        onAcceptSuggestion={(target) => void linkOne(selected.id, target, "related")}
                        onLinkSelected={() => void linkSelectedSuggestions()}
                        onLinkQuery={setLinkQuery}
                        onLinkTarget={setLinkTargetId}
                        onLinkLabel={setLinkLabel}
                        onCreateLink={() => {
                            if (linkTargetId) void linkOne(selected.id, linkTargetId, linkLabel || "related");
                        }}
                    />
                )}

                {selected?.type === "link" && (
                    <LinkPanel
                        source={selected.link.source}
                        target={selected.link.target}
                        kind={selected.link.kind}
                        similarity={selected.link.similarity}
                        titleOf={titleOf}
                        busy={busy}
                        confirming={confirming}
                        onConfirm={setConfirming}
                        onUnlink={() => void deleteLink()}
                        onAccept={() => void linkOne(selected.link.source, selected.link.target, "related")}
                        onClose={() => { setSelected(null); setConfirming(null); }}
                    />
                )}
            </div>

            {timeActive && (
                <TimelineBar
                    start={timeBounds.start}
                    end={timeBounds.end}
                    value={timeValue}
                    playing={timePlaying}
                    onChange={setTimeValue}
                    onPlaying={setTimePlaying}
                    onExit={() => { setTimeActive(false); setTimePlaying(false); }}
                />
            )}

            {contextMenu && (
                <div
                    style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
                    onMouseLeave={() => setContextMenu(null)}
                >
                    <button style={styles.contextItem} onClick={() => { setRouteFrom(contextMenu.id); setContextMenu(null); }}>
                        <Route size={13} /> Route from here
                    </button>
                    <button style={styles.contextItem} onClick={() => { setRouteTo(contextMenu.id); setContextMenu(null); }}>
                        <Route size={13} /> Route to here
                    </button>
                    <button style={styles.contextItem} onClick={() => { setLocalRoot(contextMenu.id); setContextMenu(null); }}>
                        <Crosshair size={13} /> Isolate this system
                    </button>
                    <button style={styles.contextItem} onClick={() => { focusNode(contextMenu.id); setContextMenu(null); }}>
                        <Layers size={13} /> Open page
                    </button>
                </div>
            )}

            {loading && (
                <div style={styles.overlay}>
                    <Loader2 size={22} className="animate-spin" />
                    <span>Charting the vault...</span>
                </div>
            )}

            {error && !loading && (
                <div style={styles.overlay}>
                    <span style={{ color: COSMOS.danger, maxWidth: 420, textAlign: "center", lineHeight: 1.5 }}>{error}</span>
                    <button style={{ ...styles.action, ...styles.actionPrimary }} onClick={() => void fetchGraph("initial")}>
                        Try again
                    </button>
                </div>
            )}

            {toast && <div style={styles.toast} className="animate-fade-in-scale">{toast}</div>}
        </div>
    );
}
