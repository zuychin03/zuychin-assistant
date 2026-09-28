import * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";
import type { CosmosView, GLink, GNode } from "./model";
import { COSMOS, LABEL_VISIBILITY_FLOOR, lensOpacity } from "./palette";
import { placeLabel } from "./label-layout";

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
    let byId = new Map<string, GNode>();
    const textWidths = new Map<string, number>();
    const textMeasure = document.createElement("canvas").getContext("2d");
    const fontFamily = getComputedStyle(layer).fontFamily;
    const clearTextWidths = () => textWidths.clear();
    document.fonts.addEventListener("loadingdone", clearTextWidths);
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
                "overflow:hidden;text-overflow:ellipsis;line-height:1.35;" +
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
        const bounds = { x1: safe.left + 8, y1: 8, x2: width - safe.right - 8, y2: height - 8 };
        const placed = [...view.labelObstacles];
        let used = 0;
        let budget = LABEL_BUDGET;

        const place = (node: GNode, forced: boolean): boolean => {
            if (node.x === undefined) return false;
            if (view.systemFocus && node.id === view.systemFocus && view.hover !== node.id) return false;
            if (view.systemFocus && node.id !== view.systemFocus && !forced) return false;
            if (!forced && view.searchActive && !view.searchScores.has(node.id)) return false;
            if (!forced && view.pathActive) return false;
            // Never leave a name floating over a star the lens has faded out.
            if (!forced && lensOpacity(node, view.lens) < LABEL_VISIBILITY_FLOOR) return false;

            toNode.set(node.x, node.y ?? 0, node.z ?? 0).sub(camera.position);
            if (toNode.dot(forward) <= 0) return false;

            const screen = graph.graph2ScreenCoords(node.x, node.y ?? 0, node.z ?? 0);
            if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return false;
            if (screen.x < 0 || screen.x > width || screen.y < 0 || screen.y > height) return false;

            const distance = toNode.length();
            const fade = distance <= FADE_START
                ? 1
                : Math.max(0, 1 - (distance - FADE_START) / (FADE_END - FADE_START));
            if (fade <= 0.06 && !forced) return false;

            // A label for a star that is itself behind a rail is pure noise.
            if (screen.x < safe.left || screen.x > width - safe.right) return false;

            const size = 11 + Math.round(node.centrality * 3);
            const weight = forced || node.centrality > 0.5 ? "650" : "500";
            const offset = 10 + Math.cbrt(1 + node.links) * 3.4;
            const font = `${weight} ${size}px ${fontFamily}`;
            const measureKey = `${font}:${node.title}`;
            let measuredWidth = textWidths.get(measureKey);
            if (measuredWidth === undefined) {
                if (textMeasure) textMeasure.font = font;
                measuredWidth = Math.ceil(textMeasure?.measureText(node.title).width ?? node.title.length * size * 0.6);
                textWidths.set(measureKey, measuredWidth);
            }
            const boxWidth = Math.min(190, measuredWidth, bounds.x2 - bounds.x1);
            const box = placeLabel(screen, boxWidth, size * 1.35, offset, bounds, placed);
            if (!box) return false;
            placed.push(box);

            // A background system's name must fade with its star, or the labels are the
            // only thing still reading as foreground.
            const backgrounded = view.systemFocus !== null && node.id !== view.systemFocus;

            const element = take(used++);
            element.textContent = node.title;
            element.style.transform = `translate(${box.x1}px,${box.y1}px)`;
            element.style.width = `${boxWidth}px`;
            element.style.fontSize = `${size}px`;
            element.style.fontWeight = weight;
            element.style.color = forced && !backgrounded ? COSMOS.text : COSMOS.muted;
            const base = forced ? 1 : fade * 0.9;
            element.style.opacity = String(backgrounded ? base * 0.45 : base);
            element.style.display = "block";
            return true;
        };

        // Forced labels claim their space first so a hovered or routed page never
        // loses a collision to an incidental neighbour.
        for (const id of must) {
            const node = byId.get(id);
            if (node) place(node, true);
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
            byId = new Map(nodes.map(node => [node.id, node]));
            textWidths.clear();
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
            document.fonts.removeEventListener("loadingdone", clearTextWidths);
            layer.remove();
            pool.length = 0;
        },
    };
}
