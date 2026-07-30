import * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";
import type { CosmosView, GLink, GNode } from "./model";
import { COSMOS, LABEL_VISIBILITY_FLOOR, lensOpacity } from "./palette";

// Labels live in an HTML layer rather than as three.js sprites: one SpriteText per
// node means one canvas texture per node, and text in the DOM also gets real
// typography, ellipsis and subpixel rendering for free.

const LABEL_BUDGET = 45;
const FRAME_MS = 33;
const FADE_START = 1200;
const FADE_END = 2700;

export interface LabelLayer {
    setNodes(nodes: GNode[]): void;
    start(): void;
    stop(): void;
    dispose(): void;
}

export function createLabelLayer(options: {
    container: HTMLElement;
    graph: ForceGraph3DInstance<GNode, GLink>;
    view: CosmosView;
}): LabelLayer {
    const { container, graph, view } = options;

    const layer = document.createElement("div");
    layer.style.cssText =
        "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;" +
        "font-family:var(--font-family,system-ui);";
    container.appendChild(layer);

    const pool: HTMLDivElement[] = [];
    // Sorted once per data change; re-sorting every frame would be wasted work.
    let ordered: GNode[] = [];
    let frame = 0;
    let lastPaint = 0;

    const forward = new THREE.Vector3();
    const toNode = new THREE.Vector3();

    function take(index: number): HTMLDivElement {
        let element = pool[index];
        if (!element) {
            element = document.createElement("div");
            element.style.cssText =
                "position:absolute;transform:translate(-50%,0);white-space:nowrap;" +
                "max-width:190px;overflow:hidden;text-overflow:ellipsis;" +
                "text-shadow:0 1px 6px rgba(0,0,0,0.9);will-change:transform,opacity;";
            layer.appendChild(element);
            pool[index] = element;
        }
        return element;
    }

    function paint() {
        const camera = graph.camera() as THREE.PerspectiveCamera;
        const width = layer.clientWidth;
        const height = layer.clientHeight;
        camera.getWorldDirection(forward);

        const must = new Set<string>();
        if (view.hover) must.add(view.hover);
        if (view.selectedNode) must.add(view.selectedNode);
        for (const id of view.pathNodes) must.add(id);
        if (view.searchActive) {
            const top = [...view.searchScores.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12);
            for (const [id] of top) must.add(id);
        }

        const safe = view.labelSafeArea;
        const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
        let used = 0;
        let budget = LABEL_BUDGET;

        const place = (node: GNode, forced: boolean): boolean => {
            if (node.x === undefined) return false;
            if (!forced && view.searchActive && !view.searchScores.has(node.id)) return false;
            if (!forced && view.pathActive) return false;
            // Never leave a name floating over a star the lens has faded out.
            if (!forced && lensOpacity(node, view.lens) < LABEL_VISIBILITY_FLOOR) return false;

            toNode.set(node.x, node.y ?? 0, node.z ?? 0).sub(camera.position);
            if (toNode.dot(forward) <= 0) return false;

            const screen = graph.graph2ScreenCoords(node.x, node.y ?? 0, node.z ?? 0);
            if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return false;
            if (screen.x < -120 || screen.x > width + 120 || screen.y < -60 || screen.y > height + 60) return false;

            const distance = toNode.length();
            const fade = distance <= FADE_START
                ? 1
                : Math.max(0, 1 - (distance - FADE_START) / (FADE_END - FADE_START));
            if (fade <= 0.06 && !forced) return false;

            // A label for a star that is itself behind a rail is pure noise.
            if (screen.x < safe.left || screen.x > width - safe.right) return false;

            const size = 11 + Math.round(node.centrality * 3);
            const offset = 10 + Math.cbrt(1 + node.links) * 3.4;
            // Approximate the box rather than measuring: a getBoundingClientRect per
            // label per frame would force layout 45 times a frame.
            const boxWidth = Math.min(190, node.title.length * size * 0.54);
            const top = screen.y + offset;
            // Labels are centre-aligned, so a star clear of a rail can still have half
            // its text under one. Slide the text back into view rather than dropping it.
            let centre = screen.x;
            let x1 = centre - boxWidth / 2;
            let x2 = centre + boxWidth / 2;
            if (x1 < safe.left) {
                const shift = safe.left - x1;
                centre += shift;
                x1 += shift;
                x2 += shift;
            }
            if (x2 > width - safe.right) {
                const shift = x2 - (width - safe.right);
                centre -= shift;
                x1 -= shift;
                x2 -= shift;
            }
            if (x1 < safe.left) return false;

            const box = { x1, y1: top, x2, y2: top + size * 1.35 };
            for (const other of placed) {
                if (box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1) return false;
            }
            placed.push(box);

            const element = take(used++);
            element.textContent = node.title;
            element.style.transform = `translate(-50%,0) translate(${centre}px,${top}px)`;
            element.style.fontSize = `${size}px`;
            element.style.fontWeight = forced || node.centrality > 0.5 ? "650" : "500";
            element.style.color = forced ? COSMOS.text : COSMOS.muted;
            element.style.opacity = String(forced ? 1 : fade * 0.9);
            element.style.display = "block";
            return true;
        };

        // Forced labels claim their space first so a hovered or routed page never
        // loses a collision to an incidental neighbour.
        for (const node of ordered) {
            if (must.has(node.id)) place(node, true);
        }
        for (const node of ordered) {
            if (budget <= 0) break;
            if (must.has(node.id)) continue;
            if (place(node, false)) budget--;
        }

        for (let index = used; index < pool.length; index++) pool[index].style.display = "none";
    }

    function tick(now: number) {
        frame = requestAnimationFrame(tick);
        if (!view.labelsOn) {
            if (lastPaint !== -1) {
                for (const element of pool) element.style.display = "none";
                lastPaint = -1;
            }
            return;
        }
        if (lastPaint !== -1 && now - lastPaint < FRAME_MS) return;
        lastPaint = now;
        paint();
    }

    return {
        setNodes(nodes) {
            ordered = [...nodes].sort((a, b) => b.centrality - a.centrality || b.links - a.links);
        },
        start() {
            if (!frame) frame = requestAnimationFrame(tick);
        },
        stop() {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
        },
        dispose() {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            layer.remove();
            pool.length = 0;
        },
    };
}
