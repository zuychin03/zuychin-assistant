import * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";
import {
    createBodySprite, createNebulaSprite, createOrbitRing, createSelectionRing,
    createStarfield, createStarMaterial, getTexture,
} from "./textures";
import type { VaultSection } from "./sections";
import {
    CATEGORY_COLORS, classifyStar, COSMOS, clusterColor, lensColor, lensOpacity, starSize,
} from "./palette";
import {
    endpoints, linkKey, pairKey, type CosmosView, type GLink, type GNode, type GraphCluster,
} from "./model";

export type Graph = ForceGraph3DInstance<GNode, GLink>;
export type Quality = "auto" | "plain";

export interface PhysicsSettings {
    repel: number;
    linkDist: number;
    center: number;
    cluster: number;
}

export const DEFAULT_PHYSICS: PhysicsSettings = { repel: 150, linkDist: 62, center: 0.9, cluster: 0.09 };

const BLOOM_NODE_LIMIT = 600;
const NEBULA_EVERY_TICKS = 12;

export interface CosmosHandlers {
    onNodeClick(node: GNode): void;
    onNodeDoubleClick(node: GNode): void;
    onNodeRightClick(node: GNode, event: MouseEvent): void;
    onNodeHover(node: GNode | null): void;
    onLinkClick(link: GLink): void;
    onBackgroundClick(): void;
    onSectionClick(sectionId: string, title: string): void;
}

export interface SystemSpec {
    /** Node the system orbits. */
    rootId: string;
    planets: VaultSection[];
}

interface OrbitingBody {
    sprite: THREE.Sprite;
    sectionId: string;
    title: string;
    radius: number;
    angle: number;
    speed: number;
    /** Tilt of this orbit, so the system does not read as one flat disc. */
    tilt: number;
    moons: OrbitingBody[];
}

// A planet's size comes from how much prose sits under its heading, clamped so a
// one-line section is still clickable and an essay does not eclipse the star.
const PLANET_MIN = 5.5;
const PLANET_MAX = 13;
const MOON_MIN = 3;
const MOON_MAX = 6;
const SYSTEM_FRAME_MS = 33;

function bodyScale(chars: number, min: number, max: number): number {
    const t = Math.min(1, Math.sqrt(chars) / 55);
    return min + (max - min) * t;
}

/**
 * Fill concentric orbits, capacity growing with radius, so any number of sections
 * lays out without crowding. Returns one entry per planet: which ring it sits on
 * and its slot within that ring.
 */
function orbitSlots(count: number): { ring: number; slot: number; ringSize: number }[] {
    const slots: { ring: number; slot: number; ringSize: number }[] = [];
    let ring = 1;
    let placed = 0;
    while (placed < count) {
        const capacity = ring * 6;
        const take = Math.min(capacity, count - placed);
        for (let slot = 0; slot < take; slot++) slots.push({ ring, slot, ringSize: take });
        placed += take;
        ring++;
    }
    return slots;
}

export interface Cosmos {
    graph: Graph;
    setData(nodes: GNode[], links: GLink[]): void;
    restyle(): void;
    setClusters(clusters: GraphCluster[]): void;
    setSystem(spec: SystemSpec | null): void;
    flyTo(node: GNode, distance?: number): void;
    frameAll(): void;
    frameNodes(ids: Set<string>): void;
    applyPhysics(settings: PhysicsSettings): void;
    setQuality(quality: Quality): void;
    bloomActive(): boolean;
    resize(width: number, height: number): void;
    dispose(): void;
}

/** True for software rasterisers, where a bloom pass costs more than it gives. */
function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
    try {
        const gl = renderer.getContext();
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        if (!info) return false;
        const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
        return /swiftshader|software|llvmpipe|basic render/i.test(name);
    } catch {
        return false;
    }
}

/**
 * Weak pull toward each community's centre of mass, so detected constellations
 * physically separate instead of being colour-only groupings.
 */
function createClusterForce(getStrength: () => number) {
    let nodes: GNode[] = [];
    const force = (alpha: number) => {
        const strength = getStrength();
        if (strength <= 0 || nodes.length === 0) return;

        const centroids = new Map<number, { x: number; y: number; z: number; count: number }>();
        for (const node of nodes) {
            if (node.cluster < 0) continue;
            const entry = centroids.get(node.cluster) ?? { x: 0, y: 0, z: 0, count: 0 };
            entry.x += node.x ?? 0;
            entry.y += node.y ?? 0;
            entry.z += node.z ?? 0;
            entry.count++;
            centroids.set(node.cluster, entry);
        }
        for (const entry of centroids.values()) {
            entry.x /= entry.count;
            entry.y /= entry.count;
            entry.z /= entry.count;
        }

        const k = alpha * strength;
        for (const node of nodes as (GNode & { vx: number; vy: number; vz: number })[]) {
            const centroid = centroids.get(node.cluster);
            if (!centroid) continue;
            node.vx += (centroid.x - (node.x ?? 0)) * k;
            node.vy += (centroid.y - (node.y ?? 0)) * k;
            node.vz += (centroid.z - (node.z ?? 0)) * k;
        }
    };
    force.initialize = (input: GNode[]) => { nodes = input; };
    return force;
}

export function createCosmos(
    element: HTMLElement,
    ForceGraph3D: new (el: HTMLElement) => unknown,
    view: CosmosView,
    handlers: CosmosHandlers,
): Cosmos {
    const graph = new ForceGraph3D(element) as Graph;

    const starById = new Map<string, THREE.Sprite>();
    const nodeById = new Map<string, GNode>();
    const nebulaById = new Map<number, THREE.Sprite>();
    let clusters: GraphCluster[] = [];
    let physics = { ...DEFAULT_PHYSICS };
    let quality: Quality = "auto";
    let bloom: { pass: unknown; enabled: boolean } | null = null;
    let styleDirty = true;
    let tickCount = 0;
    let lastClick = { id: "", at: 0 };

    graph
        .backgroundColor(COSMOS.background)
        .showNavInfo(false)
        .nodeVal((node) => 1 + node.links)
        .nodeRelSize(1)
        .nodeThreeObjectExtend(false)
        .nodeThreeObject((node) => {
            const sprite = new THREE.Sprite(createStarMaterial(classifyStar(node)));
            sprite.scale.setScalar(starSize(node));
            starById.set(node.id, sprite);
            styleDirty = true;
            return sprite;
        })
        .nodeLabel(() => "")
        .linkColor((link) => {
            const key = linkKey(link);
            if (view.pathActive) return view.pathLinks.has(key) ? "#ffffff" : COSMOS.dust;
            const selected = view.selectedLink;
            if (selected) {
                const { s, t } = endpoints(link);
                if (selected.kind === link.kind && pairKey(selected.source, selected.target) === pairKey(s, t)) {
                    return "#ffffff";
                }
            }
            if (view.hover && view.highlightLinks.has(key)) return "#dfe7ff";
            if (link.kind === "suggestion") return COSMOS.suggestion;
            return link.mutual ? COSMOS.filamentMutual : COSMOS.filament;
        })
        .linkWidth((link) => {
            const key = linkKey(link);
            if (view.pathActive) return view.pathLinks.has(key) ? 3.2 : 0.4;
            const selected = view.selectedLink;
            if (selected) {
                const { s, t } = endpoints(link);
                if (selected.kind === link.kind && pairKey(selected.source, selected.target) === pairKey(s, t)) {
                    return 2.6;
                }
            }
            if (view.hover && view.highlightLinks.has(key)) return 1.8;
            return link.kind === "suggestion" ? 0.5 : 0.9;
        })
        // Suggestions arc rather than run straight, so a proposed connection never
        // reads as an existing one even at a glance.
        .linkCurvature((link) => (link.kind === "suggestion" ? 0.26 : 0))
        .linkOpacity(0.42)
        .linkLabel((link) => {
            const { s, t } = endpoints(link);
            const name = (id: string) => nodeById.get(id)?.title ?? id;
            return link.kind === "suggestion"
                ? `${name(s)} ~ ${name(t)} · ${Math.round((link.similarity ?? 0) * 100)}% similar (click to review)`
                : `${name(s)} ${link.mutual ? "↔" : "→"} ${name(t)}`;
        })
        .onNodeHover((node) => {
            handlers.onNodeHover(node);
            element.style.cursor = node ? "pointer" : "default";
        })
        .onNodeClick((node) => {
            const now = Date.now();
            if (lastClick.id === node.id && now - lastClick.at < 350) {
                lastClick = { id: "", at: 0 };
                handlers.onNodeDoubleClick(node);
                return;
            }
            lastClick = { id: node.id, at: now };
            handlers.onNodeClick(node);
        })
        .onNodeRightClick((node, event) => handlers.onNodeRightClick(node, event))
        .onLinkHover((link) => { element.style.cursor = link ? "pointer" : "default"; })
        .onLinkClick((link) => handlers.onLinkClick(link))
        .onBackgroundClick(() => handlers.onBackgroundClick());

    const scene = graph.scene();
    const starfield = createStarfield();
    scene.add(starfield);

    const selectionRing = createSelectionRing();
    scene.add(selectionRing);

    // A little ambient fill keeps sprite-free helpers visible; stars are additive
    // and light themselves.
    graph.lights([new THREE.AmbientLight(0xffffff, 0.4)]);

    graph.d3Force("cluster", createClusterForce(() => physics.cluster));

    // ---- Section system overlay ----
    // These bodies are NOT graph nodes. Injecting them into the simulation would
    // make a page's own sections repel its neighbours and tear the neighbourhood
    // apart, so they live in their own group with their own picking.

    const systemGroup = new THREE.Group();
    systemGroup.visible = false;
    scene.add(systemGroup);

    let system: { rootId: string; bodies: OrbitingBody[] } | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredBody: OrbitingBody | null = null;
    let systemRaf = 0;
    let lastSystemPaint = 0;

    const ringTilt = (ring: number) => 0.32 + ring * 0.14;

    function clearSystem() {
        for (const child of [...systemGroup.children]) {
            systemGroup.remove(child);
            if (child instanceof THREE.Sprite) (child.material as THREE.SpriteMaterial).dispose();
            if (child instanceof THREE.Line) {
                child.geometry.dispose();
                (child.material as THREE.LineBasicMaterial).dispose();
            }
        }
        system = null;
        hoveredBody = null;
        systemGroup.visible = false;
    }

    function buildSystem(spec: SystemSpec) {
        clearSystem();
        const root = nodeById.get(spec.rootId);
        if (!root || spec.planets.length === 0) return;

        const base = starSize(root) * 0.8 + 18;
        const slots = orbitSlots(spec.planets.length);
        const bodies: OrbitingBody[] = [];
        const ringsDrawn = new Set<number>();

        spec.planets.forEach((planet, index) => {
            const { ring, slot, ringSize } = slots[index];
            const radius = base + (ring - 1) * 16;
            const tilt = ringTilt(ring);

            if (!ringsDrawn.has(ring)) {
                ringsDrawn.add(ring);
                const orbit = createOrbitRing(radius, COSMOS.filament, 0.2);
                orbit.rotation.x = tilt;
                systemGroup.add(orbit);
            }

            const scale = bodyScale(planet.chars, PLANET_MIN, PLANET_MAX);
            const sprite = createBodySprite("planet", CATEGORY_COLORS[root.category] ?? "#9fb6e8", scale);
            systemGroup.add(sprite);

            const moons: OrbitingBody[] = planet.moons.map((moon, moonIndex) => {
                const moonScale = bodyScale(moon.chars, MOON_MIN, MOON_MAX);
                const moonSprite = createBodySprite("moon", "#c8d2e8", moonScale);
                systemGroup.add(moonSprite);
                return {
                    sprite: moonSprite,
                    sectionId: moon.id,
                    title: moon.title,
                    radius: scale * 0.7 + 4 + planet.moons.length * 0.6,
                    angle: (moonIndex / Math.max(1, planet.moons.length)) * Math.PI * 2,
                    speed: 0.011,
                    tilt: tilt + 0.25,
                    moons: [],
                };
            });

            bodies.push({
                sprite,
                sectionId: planet.id,
                title: planet.title,
                radius,
                angle: (slot / Math.max(1, ringSize)) * Math.PI * 2,
                // Outer orbits run slower, which reads as a system rather than a dial.
                speed: 0.0026 / Math.sqrt(ring),
                tilt,
                moons,
            });
        });

        system = { rootId: spec.rootId, bodies };
        systemGroup.visible = true;
    }

    const orbitOffset = new THREE.Vector3();
    const xAxis = new THREE.Vector3(1, 0, 0);

    function placeBody(body: OrbitingBody, centre: THREE.Vector3) {
        orbitOffset.set(Math.cos(body.angle) * body.radius, 0, Math.sin(body.angle) * body.radius);
        orbitOffset.applyAxisAngle(xAxis, body.tilt);
        body.sprite.position.copy(centre).add(orbitOffset);
    }

    function animateSystem(now: number) {
        systemRaf = requestAnimationFrame(animateSystem);
        if (!system) return;
        if (now - lastSystemPaint < SYSTEM_FRAME_MS) return;
        const elapsed = now - lastSystemPaint;
        lastSystemPaint = now;

        const root = nodeById.get(system.rootId);
        if (!root || root.x === undefined) {
            systemGroup.visible = false;
            return;
        }
        systemGroup.visible = true;
        systemGroup.position.set(root.x, root.y ?? 0, root.z ?? 0);

        const step = elapsed / 16;
        const origin = new THREE.Vector3(0, 0, 0);
        for (const planet of system.bodies) {
            planet.angle += planet.speed * step;
            placeBody(planet, origin);
            for (const moon of planet.moons) {
                moon.angle += moon.speed * step;
                placeBody(moon, planet.sprite.position);
            }
        }
    }
    systemRaf = requestAnimationFrame(animateSystem);

    function pickBody(event: PointerEvent | MouseEvent): OrbitingBody | null {
        if (!system) return null;
        const rect = element.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, graph.camera() as THREE.Camera);

        const all = system.bodies.flatMap((planet) => [planet, ...planet.moons]);
        const hits = raycaster.intersectObjects(all.map((b) => b.sprite), false);
        if (hits.length === 0) return null;
        return all.find((b) => b.sprite === hits[0].object) ?? null;
    }

    function setHoveredBody(body: OrbitingBody | null) {
        if (hoveredBody === body) return;
        if (hoveredBody) (hoveredBody.sprite.material as THREE.SpriteMaterial).opacity = 1;
        hoveredBody = body;
        if (body) (body.sprite.material as THREE.SpriteMaterial).opacity = 0.72;
    }

    const onSystemPointerMove = (event: PointerEvent) => {
        const body = pickBody(event);
        setHoveredBody(body);
        if (body) element.style.cursor = "pointer";
        // The graph's own hover handler will not fire when leaving a planet, so the
        // pointer cursor would otherwise stick.
        else if (!view.hover) element.style.cursor = "default";
    };
    // Capture phase: a hit must not also reach the graph, which would read it as a
    // background click and clear the selection.
    const onSystemClick = (event: MouseEvent) => {
        const body = pickBody(event);
        if (!body) return;
        event.stopPropagation();
        event.preventDefault();
        handlers.onSectionClick(body.sectionId, body.title);
    };
    element.addEventListener("pointermove", onSystemPointerMove);
    element.addEventListener("click", onSystemClick, true);

    function applyStarStyle(node: GNode, sprite: THREE.Sprite) {
        const material = sprite.material as THREE.SpriteMaterial;
        const isSelected = view.selectedNode === node.id;
        let color = lensColor(node, view.lens);
        let opacity = 0.92;
        let scale = 1;

        if (view.pathActive) {
            if (view.pathNodes.has(node.id)) {
                opacity = 1;
                scale = 1.16;
            } else {
                color = COSMOS.dust;
                opacity = 0.12;
            }
        } else if (view.searchActive) {
            const score = view.searchScores.get(node.id);
            if (score === undefined) {
                color = COSMOS.dust;
                opacity = 0.1;
            } else {
                opacity = 0.5 + score * 0.5;
                scale = 1 + score * 0.3;
            }
        } else if (view.hover) {
            if (view.highlightNodes.has(node.id)) {
                opacity = 1;
                scale = view.hover === node.id ? 1.18 : 1.06;
            } else {
                color = COSMOS.dust;
                opacity = 0.22;
            }
        } else {
            // Health and trust push the ordinary case back so the pages that need
            // attention carry the eye.
            opacity *= lensOpacity(node, view.lens);
        }

        if (isSelected) {
            opacity = 1;
            scale = Math.max(scale, 1.2);
        }

        material.color.set(color);
        material.opacity = opacity;
        material.map = getTexture(classifyStar(node));
        sprite.scale.setScalar(starSize(node) * scale);
    }

    function applyNodeStyles() {
        for (const [id, sprite] of starById) {
            const node = nodeById.get(id);
            if (node) applyStarStyle(node, sprite);
        }
    }

    function updateSelectionRing() {
        const id = view.selectedNode;
        const node = id ? nodeById.get(id) : null;
        if (!node || node.x === undefined) {
            selectionRing.visible = false;
            return;
        }
        selectionRing.visible = true;
        selectionRing.position.set(node.x, node.y ?? 0, node.z ?? 0);
        selectionRing.scale.setScalar(starSize(node) * 2.3);
    }

    function updateNebulae() {
        if (view.lens !== "cluster" || quality === "plain") {
            for (const sprite of nebulaById.values()) sprite.visible = false;
            return;
        }

        const groups = new Map<number, GNode[]>();
        for (const node of nodeById.values()) {
            if (node.cluster < 0 || node.x === undefined) continue;
            const members = groups.get(node.cluster);
            if (members) members.push(node);
            else groups.set(node.cluster, [node]);
        }

        for (const sprite of nebulaById.values()) sprite.visible = false;

        for (const [cluster, members] of groups) {
            if (members.length < 3) continue;
            let cx = 0, cy = 0, cz = 0;
            for (const member of members) {
                cx += member.x ?? 0;
                cy += member.y ?? 0;
                cz += member.z ?? 0;
            }
            cx /= members.length;
            cy /= members.length;
            cz /= members.length;

            let spread = 0;
            for (const member of members) {
                spread = Math.max(spread, Math.hypot((member.x ?? 0) - cx, (member.y ?? 0) - cy, (member.z ?? 0) - cz));
            }

            let sprite = nebulaById.get(cluster);
            if (!sprite) {
                sprite = createNebulaSprite(clusterColor(cluster), 1);
                nebulaById.set(cluster, sprite);
                scene.add(sprite);
            }
            sprite.visible = true;
            sprite.position.set(cx, cy, cz);
            sprite.scale.setScalar(Math.max(90, spread * 2.6));
            (sprite.material as THREE.SpriteMaterial).color.set(clusterColor(cluster));
        }
    }

    graph.onEngineTick(() => {
        tickCount++;
        if (styleDirty) {
            applyNodeStyles();
            styleDirty = false;
        }
        updateSelectionRing();
        if (tickCount % NEBULA_EVERY_TICKS === 0) updateNebulae();
    });

    async function ensureBloom(width: number, height: number) {
        const nodeCount = nodeById.size;
        const renderer = graph.renderer();
        const wanted = quality === "auto" && nodeCount <= BLOOM_NODE_LIMIT && !isSoftwareRenderer(renderer);

        if (!wanted) {
            if (bloom?.enabled) {
                try {
                    const composer = graph.postProcessingComposer() as unknown as { removePass(pass: unknown): void };
                    composer.removePass(bloom.pass);
                } catch { /* composer may already be torn down */ }
                bloom.enabled = false;
            }
            return;
        }
        if (bloom?.enabled) return;

        try {
            const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
            const pass = bloom?.pass ?? new UnrealBloomPass(new THREE.Vector2(width, height), 0.72, 0.85, 0.12);
            const composer = graph.postProcessingComposer() as unknown as { addPass(pass: unknown): void };
            composer.addPass(pass);
            bloom = { pass, enabled: true };
        } catch (error) {
            console.warn("[Cosmos] Bloom unavailable; falling back to plain rendering.", error);
            bloom = null;
        }
    }

    return {
        graph,

        setData(nodes, links) {
            starById.clear();
            nodeById.clear();
            for (const node of nodes) nodeById.set(node.id, node);
            graph.graphData({ nodes, links });
            styleDirty = true;
            void ensureBloom(graph.width(), graph.height());
        },

        restyle() {
            styleDirty = true;
            applyNodeStyles();
            updateSelectionRing();
            // Link accessors are re-read only when reassigned.
            graph.linkColor(graph.linkColor());
            graph.linkWidth(graph.linkWidth());
        },

        setClusters(next) {
            clusters = next;
            void clusters;
            updateNebulae();
        },

        setSystem(spec) {
            if (!spec) clearSystem();
            else buildSystem(spec);
        },

        flyTo(node, distance = 150) {
            if (node.x === undefined) return;
            const length = Math.hypot(node.x, node.y ?? 0, node.z ?? 0) || 1;
            const factor = 1 + distance / length;
            graph.cameraPosition(
                { x: node.x * factor, y: (node.y ?? 0) * factor, z: (node.z ?? 0) * factor },
                { x: node.x, y: node.y ?? 0, z: node.z ?? 0 },
                900,
            );
        },

        frameAll() {
            graph.zoomToFit(800, 90);
        },

        frameNodes(ids) {
            if (ids.size === 0) return;
            graph.zoomToFit(800, 100, (node) => ids.has(node.id));
        },

        applyPhysics(settings) {
            physics = { ...settings };
            (graph.d3Force("charge") as { strength?: (v: number) => void } | undefined)?.strength?.(-settings.repel);
            (graph.d3Force("link") as { distance?: (v: number) => void } | undefined)?.distance?.(settings.linkDist);
            (graph.d3Force("center") as { strength?: (v: number) => void } | undefined)?.strength?.(settings.center);
            // Reheating before the first graphData() crashes tickFrame (state.layout is undefined).
            if (graph.graphData().nodes.length > 0) graph.d3ReheatSimulation();
        },

        setQuality(next) {
            quality = next;
            starfield.visible = next === "auto";
            void ensureBloom(graph.width(), graph.height());
            updateNebulae();
        },

        bloomActive() {
            return bloom?.enabled === true;
        },

        resize(width, height) {
            graph.width(width).height(height);
        },

        dispose() {
            if (systemRaf) cancelAnimationFrame(systemRaf);
            systemRaf = 0;
            element.removeEventListener("pointermove", onSystemPointerMove);
            element.removeEventListener("click", onSystemClick, true);
            clearSystem();
            scene.remove(systemGroup);
            for (const sprite of nebulaById.values()) {
                scene.remove(sprite);
                (sprite.material as THREE.SpriteMaterial).dispose();
            }
            nebulaById.clear();
            scene.remove(starfield);
            starfield.geometry.dispose();
            (starfield.material as THREE.PointsMaterial).dispose();
            scene.remove(selectionRing);
            (selectionRing.material as THREE.SpriteMaterial).dispose();
            starById.clear();
            nodeById.clear();
            graph._destructor();
        },
    };
}
