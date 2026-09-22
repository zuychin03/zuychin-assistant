import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BodyGesture, cameraStandOff, orbitalDelta, resizeSystemView, systemFrameDistance } from "./navigation";
import type { ForceGraph3DInstance } from "3d-force-graph";
import { createPhotosphere } from "./stellar";
import { layoutSystemOrbits } from "./orbits";
import { createSystemClearance } from "./clearance";
import {
    bodyLook, CORE_OVERDRIVE, createAtmosphere, createBodyMesh, createNebulaSprite,
    createOrbitRing, createPlanetRing, createSelectionRing, createStarCoreMaterial,
    createStarfield, createStarMaterial, getTexture, STAR_CORE_FRACTION,
} from "./textures";
import type { VaultSection } from "./sections";
import {
    classifyStar, COSMOS, clusterColor, lensColor, lensOpacity, starSize,
} from "./palette";
import {
    endpoints, linkKey, pairKey, SYSTEM_BACKGROUND_OPACITY,
    type CosmosView, type GLink, type GNode, type GraphCluster,
} from "./model";

export type Graph = ForceGraph3DInstance<GNode, GLink>;
export type Quality = "auto" | "plain";

export interface PhysicsSettings {
    repel: number;
    linkDist: number;
    center: number;
    cluster: number;
}

// Roomy by default: at 62 the filaments were short enough that neighbouring stars
// overlapped and a page's orbiting sections reached into the next system. center is
// eased off at the same time, since a strong core pull just undoes the extra spread.
export const DEFAULT_PHYSICS: PhysicsSettings = { repel: 265, linkDist: 115, center: 0.6, cluster: 0.07 };

const BLOOM_NODE_LIMIT = 600;
const NEBULA_EVERY_TICKS = 12;
// Multiple of linkDist to stand off when flying to a star, so a click frames the
// neighbourhood rather than filling the viewport with one star.
const FLY_STANDOFF = 2.4;
// How far to pull back when the pivot is released. Enough to read as letting go,
// short of a full reframe, which would throw away where the user was looking.
const PIVOT_RELEASE_PULLBACK = 1.45;

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
    mesh: THREE.Mesh;
    atmosphere: THREE.Mesh | null;
    ring: THREE.Mesh | null;
    /** Scale before any hover growth, so the highlight is reversible. */
    baseScale: number;
    sectionId: string;
    title: string;
    kind: "planet" | "moon";
    radius: number;
    angle: number;
    speed: number;
    tilt: number;
    moons: OrbitingBody[];
}

const SYSTEM_ZOOM = 2.6;
const SYSTEM_NEIGHBOUR_SHRINK = 0.85;
const PLANET_OF_SUN_MAX = 0.52;
const PLANET_OF_SUN_MIN = 0.28;
const MOON_OF_PLANET_MAX = 0.34;
const MOON_OF_PLANET_MIN = 0.2;
const BODY_FILL = 0.9;
const BODY_DETAIL_SCALE = 1.5;
const SYSTEM_FRAME_MS = 33;
const PICK_RADIUS_FLOOR = 17;
const ORBIT_COLOR = "#81909f";
const ORBIT_OPACITY = 0.095;
const SYSTEM_REPEL_BOOST = 1.6;

// Core size as a fraction of the corona, matching STAR_CORE_FRACTION's readable disc.
const CORE_RELATIVE_SIZE = 0.46;
const WHITE = new THREE.Color("#ffffff");

function bodyScale(chars: number, min: number, max: number): number {
    const t = Math.min(1, Math.sqrt(chars) / 55);
    return min + (max - min) * t;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Kepler's third law, so outer bodies visibly lag rather than turning in lockstep. */
function orbitSpeed(base: number, radius: number, k: number): number {
    return k / Math.pow(Math.max(1, radius / base), 1.5);
}

function orbitTilt(index: number): number {
    return 0.7 + Math.sin(index * GOLDEN_ANGLE) * 0.06;
}

export interface Cosmos {
    graph: Graph;
    setData(nodes: GNode[], links: GLink[]): void;
    restyle(): void;
    setClusters(clusters: GraphCluster[]): void;
    setSystem(spec: SystemSpec | null): void;
    flyTo(node: GNode, distance?: number): void;
    /** Frame the open system, sized from its own extent. */
    frameSystem(): void;
    zoom(factor: number): void;
    releaseFocus(): void;
    frameAll(): void;
    frameNodes(ids: Set<string>): void;
    applyPhysics(settings: PhysicsSettings): void;
    setQuality(quality: Quality): void;
    setMotionPaused(paused: boolean): void;
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

    // Each star is two additive sprites in a group: a coloured corona and a white-hot
    // core. Scaling the group scales both, so sizing stays one number.
    interface StarObject { group: THREE.Group; corona: THREE.Sprite; core: THREE.Sprite; baseSize: number; }
    const starById = new Map<string, StarObject>();
    const nodeById = new Map<string, GNode>();
    const nebulaById = new Map<number, THREE.Sprite>();
    let clusters: GraphCluster[] = [];
    let physics = { ...DEFAULT_PHYSICS };
    let quality: Quality = "auto";
    let motionPaused = false;
    let bloom: { pass: UnrealBloomPass; enabled: boolean } | null = null;
    let bloomPending = false;
    let bloomRevision = 0;
    let disposed = false;
    const consumedPointers = new WeakSet<MouseEvent>();
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionPreference.matches;
    let styleDirty = true;
    let simulationReady = false;
    let tickCount = 0;
    let lastClick = { id: "", at: 0 };

    graph
        .backgroundColor(COSMOS.background)
        .showNavInfo(false)
        .nodeVal((node) => 1 + node.links)
        .nodeRelSize(1)
        .nodeThreeObjectExtend(false)
        .nodeThreeObject((node) => {
            const corona = new THREE.Sprite(createStarMaterial(classifyStar(node)));
            corona.scale.setScalar(1);
            const core = new THREE.Sprite(createStarCoreMaterial());
            core.scale.setScalar(CORE_RELATIVE_SIZE);
            const group = new THREE.Group();
            // Corona first: additive, so ordering only matters for the depth-sorted pass.
            group.add(corona, core);
            group.scale.setScalar(starSize(node));
            starById.set(node.id, { group, corona, core, baseSize: starSize(node) });
            styleDirty = true;
            return group;
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
            // Only the root's own filaments stay lit inside a focused system.
            if (view.systemFocus !== null) {
                const { s, t } = endpoints(link);
                if (s !== view.systemFocus && t !== view.systemFocus) return COSMOS.dust;
            }
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
            if (view.systemFocus !== null) {
                const { s, t } = endpoints(link);
                if (s !== view.systemFocus && t !== view.systemFocus) return 0.3;
            }
            return link.kind === "suggestion" ? 0.4 : 0.7;
        })
        // Suggestions arc rather than run straight, so a proposed connection never
        // reads as an existing one even at a glance.
        .linkCurvature((link) => (link.kind === "suggestion" ? 0.26 : 0))
        .linkOpacity(0.24)
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
        .onNodeClick((node, event) => {
            if (consumedPointers.has(event)) return;
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
        .onLinkClick((link, event) => { if (!consumedPointers.has(event)) handlers.onLinkClick(link); })
        .onBackgroundClick((event) => { if (!consumedPointers.has(event)) handlers.onBackgroundClick(); });

    const scene = graph.scene();
    // Clear in the active render target's colour space before the output pass.
    scene.background = new THREE.Color(COSMOS.background);
    const renderer = graph.renderer();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const outputPass = new OutputPass();
    graph.postProcessingComposer().addPass(outputPass);
    const starfield = createStarfield();
    scene.add(starfield);

    const selectionRing = createSelectionRing();
    scene.add(selectionRing);

    graph.lights([
        new THREE.AmbientLight(0xc4d1e4, 0.45),
        new THREE.HemisphereLight(0xc8dcf5, 0x414854, 0.7),
    ]);

    graph.d3Force("cluster", createClusterForce(() => physics.cluster));

    /**
     * Repulsion, boosted while a system is open so its neighbours spread around it
     * rather than clumping on one side of the clearance radius.
     */
    function applyChargeStrength() {
        const force = graph.d3Force("charge") as
            { strength?: (accessor: number | ((node: GNode) => number)) => void } | undefined;
        force?.strength?.(() => (
            view.systemFocus === null ? -physics.repel : -physics.repel * SYSTEM_REPEL_BOOST
        ));
    }

    /**
     * Link length, per link. A link touching the open system's root is stretched past
     * that system's outermost orbit, so entering a system pushes the neighbouring stars
     * clear of it instead of leaving them sitting among its planets.
     */
    function applyLinkDistance() {
        const force = graph.d3Force("link") as
            { distance?: (accessor: (link: GLink) => number) => void } | undefined;
        force?.distance?.((link) => {
            const focus = view.systemFocus;
            if (focus === null || systemOuterRadius <= 0) return physics.linkDist;
            const { s: source, t: target } = endpoints(link);
            if (source !== focus && target !== focus) return physics.linkDist;
            return Math.max(physics.linkDist, systemOuterRadius * 1.3 + 72);
        });
    }

    // ---- Section system overlay ----
    // These bodies are NOT graph nodes. Injecting them into the simulation would
    // make a page's own sections repel its neighbours and tear the neighbourhood
    // apart, so they live in their own group with their own picking.

    const systemGroup = new THREE.Group();
    systemGroup.visible = false;
    scene.add(systemGroup);
    const systemLight = new THREE.PointLight(0xffedcc, 3.2, 0, 0);
    scene.add(systemLight);
    systemLight.visible = false;

    let system: { rootId: string; bodies: OrbitingBody[] } | null = null;
    let photosphere: ReturnType<typeof createPhotosphere> | null = null;
    let fixedRoot: { node: GNode & { fx?: number; fy?: number; fz?: number }; fx?: number; fy?: number; fz?: number } | null = null;
    // Outermost orbit of the open system, so the layout can hold neighbouring stars
    // outside it. At the default linkDist a neighbour settles at 115 while a system
    // with several sections reaches past 130, which put other stars inside the orbits.
    let systemOuterRadius = 0;
    let systemSunHalo = 0;
    let hoveredBody: OrbitingBody | null = null;
    let systemRaf = 0;
    let lastSystemPaint: number | null = null;
    const sectionLabels = new Map<string, HTMLButtonElement>();
    const clearance = createSystemClearance<GNode>(
        () => system ? { rootId: system.rootId, radius: systemOuterRadius + Math.max(60, systemOuterRadius * 0.15) } : null,
        node => starSize(node) * 0.5,
    );
    graph.d3Force("system-clearance", clearance);
    const bodyWorld = new THREE.Vector3();
    const projected = new THREE.Vector3();

    // Hover label for orbiting bodies. Its own element rather than part of the star
    // label layer: it tracks a body that keeps moving, and it names a section rather
    // than a page, so it must not compete for the star labels' collision budget.
    const tooltip = document.createElement("div");
    tooltip.style.cssText =
        "position:absolute;left:0;top:0;z-index:6;pointer-events:none;opacity:0;"
        + "padding:4px 9px;border-radius:9px;white-space:nowrap;font-size:11.5px;"
        + "font-weight:650;color:#eaf0ff;background:rgba(9,12,20,0.93);"
        + "border:1px solid rgba(126,141,184,0.34);box-shadow:0 10px 26px rgba(0,0,0,0.55);"
        + "transform:translate(-50%,-100%);transition:opacity 0.12s ease;";
    element.appendChild(tooltip);

    function clearSystem() {
        if (fixedRoot) {
            const { node, fx, fy, fz } = fixedRoot;
            Object.assign(node, { fx, fy, fz });
            fixedRoot = null;
        }
        for (const label of sectionLabels.values()) label.remove();
        sectionLabels.clear();
        for (const child of [...systemGroup.children]) {
            systemGroup.remove(child);
            child.traverse((part) => {
                if (part instanceof THREE.Line || part instanceof THREE.Mesh) part.geometry.dispose();
                if (part instanceof THREE.Sprite || part instanceof THREE.Line || part instanceof THREE.Mesh) {
                    const materials = Array.isArray(part.material) ? part.material : [part.material];
                    materials.forEach(material => material.dispose());
                }
            });
        }
        system = null;
        photosphere = null;
        lastSystemPaint = null;
        systemLight.visible = false;
        systemOuterRadius = 0;
        systemSunHalo = 0;
        hoveredBody = null;
        tooltip.style.opacity = "0";
        systemGroup.visible = false;
    }

    function buildSystem(spec: SystemSpec) {
        clearSystem();
        const root = nodeById.get(spec.rootId);
        if (!root || spec.planets.length === 0) return;
        // Keep the reading target still while neighbouring stars settle.
        const anchor = root as GNode & { fx?: number; fy?: number; fz?: number };
        fixedRoot = { node: anchor, fx: anchor.fx, fy: anchor.fy, fz: anchor.fz };
        anchor.fx = root.x ?? 0;
        anchor.fy = root.y ?? 0;
        anchor.fz = root.z ?? 0;

        // Compare body diameters to the photosphere, excluding the corona.
        const sunSprite = starSize(root) * SYSTEM_ZOOM;
        const sunDisc = sunSprite * STAR_CORE_FRACTION;
        const sunHalo = sunSprite * 0.5;
        const planetMax = (sunDisc * PLANET_OF_SUN_MAX) / BODY_FILL;
        const planetMin = (sunDisc * PLANET_OF_SUN_MIN) / BODY_FILL;
        const appearances = spec.planets.map(planet => {
            const look = bodyLook(planet.id, planet.chars);
            const scale = bodyScale(planet.chars, planetMin, planetMax) * BODY_DETAIL_SCALE;
            const moonScales = planet.moons.map(moon => bodyScale(moon.chars, scale * MOON_OF_PLANET_MIN, scale * MOON_OF_PLANET_MAX));
            return { look, scale, moonScales };
        });
        const layout = layoutSystemOrbits(sunHalo, appearances.map(({ look, scale, moonScales }) => ({
            bodyRadius: scale * 0.49 * 1.12,
            ringOuterRadius: look.ringed ? scale * 1.42 * 1.12 : undefined,
            moonRadii: moonScales.map(moonScale => moonScale * 0.45 * 1.12),
        })));
        const base = layout.planets[0].orbitRadius;
        systemSunHalo = sunHalo;
        const bodies: OrbitingBody[] = [];
        photosphere = createPhotosphere(sunDisc * 0.5, lensColor(root, view.lens));
        systemGroup.add(photosphere);

        spec.planets.forEach((planet, index) => {
            const { orbitRadius: radius, moonOrbitRadii } = layout.planets[index];
            const tilt = orbitTilt(index);

            const orbit = createOrbitRing(radius, ORBIT_COLOR, ORBIT_OPACITY);
            orbit.rotation.x = tilt;
            systemGroup.add(orbit);

            const { look, scale, moonScales } = appearances[index];

            const atmosphere = createAtmosphere(look.type, scale, systemGroup.position);
            if (atmosphere) systemGroup.add(atmosphere);

            let ring: THREE.Mesh | null = null;
            if (look.ringed) {
                const mesh = createPlanetRing(scale, look.variant);
                // Tipped well off the orbital plane, or it presents edge-on and vanishes.
                mesh.rotation.set(Math.PI / 2 + tilt * 0.5 + 0.38, 0, 0.24);
                systemGroup.add(mesh);
                ring = mesh;
            }

            const mesh = createBodyMesh(look.type, look.variant, scale);
            systemGroup.add(mesh);

            const moons: OrbitingBody[] = planet.moons.map((moon, moonIndex) => {
                const moonScale = moonScales[moonIndex];
                const moonMesh = createBodyMesh("moon", (moonIndex + look.variant) % 3, moonScale);
                systemGroup.add(moonMesh);
                const moonRadius = moonOrbitRadii[moonIndex];
                return {
                    mesh: moonMesh,
                    atmosphere: null,
                    ring: null,
                    baseScale: moonScale,
                    sectionId: moon.id,
                    title: moon.title,
                    kind: "moon" as const,
                    radius: moonRadius,
                    angle: moonIndex * GOLDEN_ANGLE,
                    speed: orbitSpeed(moonOrbitRadii[0], moonRadius, 0.2),
                    tilt: tilt + 0.1 + Math.sin(moonIndex * GOLDEN_ANGLE) * 0.08,
                    moons: [],
                };
            });

            bodies.push({
                mesh,
                atmosphere,
                ring,
                baseScale: scale,
                sectionId: planet.id,
                title: planet.title,
                kind: "planet",
                radius,
                angle: index * GOLDEN_ANGLE,
                speed: orbitSpeed(base, radius, 0.055),
                tilt,
                moons,
            });
            if (index < 16) {
                const label = document.createElement("button");
                label.dataset.cosmosSection = planet.id;
                label.setAttribute("aria-label", `Read section: ${planet.title}`);
                label.title = planet.title;
                label.style.cssText = "position:absolute;z-index:3;max-width:168px;padding:4px 5px;"
                    + "color:#aab8cc;background:rgba(5,6,10,.5);border:0;border-radius:3px;"
                    + "font:500 11px/1.4 var(--font-family,system-ui);white-space:nowrap;"
                    + "overflow:hidden;text-overflow:ellipsis;cursor:pointer;text-align:left;";
                label.textContent = `${String(index + 1).padStart(2, "0")}  ${planet.title}`;
                label.addEventListener("pointerdown", event => event.stopPropagation());
                label.addEventListener("pointerup", event => event.stopPropagation());
                label.addEventListener("click", event => {
                    event.stopPropagation();
                    handlers.onSectionClick(planet.id, planet.title);
                });
                label.addEventListener("pointerenter", () => setHoveredBody(bodies[index]));
                label.addEventListener("pointerleave", () => setHoveredBody(null));
                label.addEventListener("focus", () => setHoveredBody(bodies[index]));
                label.addEventListener("blur", () => setHoveredBody(null));
                element.appendChild(label);
                sectionLabels.set(planet.id, label);
            }
        });

        system = { rootId: spec.rootId, bodies };
        systemOuterRadius = layout.outerRadius;
        clearance.constrain();
        lastSystemPaint = null;
        systemLight.visible = true;
        systemGroup.visible = true;
        systemGroup.position.set(root.x ?? 0, root.y ?? 0, root.z ?? 0);
        systemLight.position.copy(systemGroup.position);
        for (const body of bodies) {
            placeBody(body, origin);
            for (const moon of body.moons) placeBody(moon, body.mesh.position);
        }
        systemGroup.updateMatrixWorld(true);
    }

    const orbitOffset = new THREE.Vector3();
    const xAxis = new THREE.Vector3(1, 0, 0);

    function placeBody(body: OrbitingBody, centre: THREE.Vector3) {
        orbitOffset.set(Math.cos(body.angle) * body.radius, 0, Math.sin(body.angle) * body.radius);
        orbitOffset.applyAxisAngle(xAxis, body.tilt);
        body.mesh.position.copy(centre).add(orbitOffset);
        body.atmosphere?.position.copy(body.mesh.position);
        body.ring?.position.copy(body.mesh.position);
    }

    const origin = new THREE.Vector3();
    const onMotionPreference = () => { reducedMotion = motionPreference.matches; lastSystemPaint = null; };
    const onVisibilityChange = () => { lastSystemPaint = null; };
    motionPreference.addEventListener("change", onMotionPreference);
    document.addEventListener("visibilitychange", onVisibilityChange);

    function animateSystem(now: number) {
        systemRaf = requestAnimationFrame(animateSystem);
        if (!system || document.hidden) { lastSystemPaint = null; return; }
        if (lastSystemPaint !== null && now - lastSystemPaint < SYSTEM_FRAME_MS) return;
        const elapsed = reducedMotion || motionPaused || hoveredBody ? 0 : orbitalDelta(now, lastSystemPaint);
        lastSystemPaint = now;
        const root = nodeById.get(system.rootId);
        if (!root || root.x === undefined) {
            systemGroup.visible = false;
            systemLight.visible = false;
            return;
        }
        systemGroup.visible = true;
        systemLight.visible = true;
        systemGroup.position.set(root.x, root.y ?? 0, root.z ?? 0);
        systemLight.position.copy(systemGroup.position);
        if (photosphere) photosphere.material.uniforms.time.value += elapsed;
        for (const planet of system.bodies) {
            planet.angle += planet.speed * elapsed;
            planet.mesh.rotation.y += elapsed * 0.045;
            placeBody(planet, origin);
            for (const moon of planet.moons) {
                moon.angle += moon.speed * elapsed;
                placeBody(moon, planet.mesh.position);
            }
        }
        systemGroup.updateMatrixWorld(true);
        for (const [id, star] of starById) updateStarSize(id, star);
        updateSectionLabels();
        if (hoveredBody) showBodyTooltip(hoveredBody);
    }
    systemRaf = requestAnimationFrame(animateSystem);

    function allBodies(): OrbitingBody[] {
        if (!system) return [];
        return system.bodies.flatMap((planet) => [planet, ...planet.moons]);
    }

    function updateSectionLabels() {
        if (!system) return;
        const rect = element.getBoundingClientRect();
        const occupied: { left: number; top: number; right: number; bottom: number }[] = [];
        for (const body of system.bodies) {
            const label = sectionLabels.get(body.sectionId);
            if (!label) continue;
            const point = projectBody(body, rect);
            if (!view.labelsOn || rect.height < 240 || !point || point.radius < 1.5) {
                label.style.display = "none";
                continue;
            }
            const width = Math.min(168, body.title.length * 5.8 + 28, rect.width - 24);
            const left = Math.max(12, Math.min(rect.width - width - 12, point.x - width / 2));
            const top = point.y + point.radius + 7;
            const height = rect.width < 760 ? 40 : 24;
            const box = { left, top, right: left + width, bottom: top + height };
            const hidden = point.x < 0 || point.x > rect.width || top < 0 || box.bottom > rect.height
                || occupied.some(other => box.left < other.right && box.right > other.left
                    && box.top < other.bottom && box.bottom > other.top);
            label.style.display = hidden ? "none" : "block";
            if (hidden) continue;
            occupied.push(box);
            label.style.left = `${left}px`;
            label.style.top = `${top}px`;
            label.style.width = `${width}px`;
        }
    }

    /** Canvas-space centre and radius of a body, in CSS pixels. */
    function projectBody(body: OrbitingBody, rect: DOMRect) {
        const camera = graph.camera() as THREE.PerspectiveCamera;
        body.mesh.getWorldPosition(bodyWorld);
        const depth = -bodyWorld.clone().applyMatrix4(camera.matrixWorldInverse).z;
        projected.copy(bodyWorld).project(camera);
        if (projected.z < -1 || projected.z > 1) return null;
        const pxPerUnit = rect.height
            / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(depth, 0.001));
        return {
            x: (projected.x * 0.5 + 0.5) * rect.width,
            y: (-projected.y * 0.5 + 0.5) * rect.height,
            radius: body.mesh.scale.x * 0.5 * BODY_FILL * pxPerUnit,
            depth,
        };
    }

    /** Prefer visible discs, then their forgiving screen-space hit targets. */
    function pickBody(clientX: number, clientY: number): OrbitingBody | null {
        if (!system || !systemGroup.visible) return null;
        systemGroup.updateMatrixWorld(true);
        const rect = element.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        let best: OrbitingBody | null = null;
        let bestDistance = Infinity;
        let bestDepth = Infinity;
        for (const body of allBodies()) {
            const point = projectBody(body, rect);
            if (!point) continue;
            const distance = Math.hypot(point.x - px, point.y - py);
            if (distance > Math.max(point.radius, PICK_RADIUS_FLOOR)) continue;
            const score = Math.max(0, distance - point.radius);
            if (score < bestDistance || (score === bestDistance && point.depth < bestDepth)) {
                bestDistance = score;
                bestDepth = point.depth;
                best = body;
            }
        }
        return best;
    }

    function showBodyTooltip(body: OrbitingBody) {
        const point = projectBody(body, element.getBoundingClientRect());
        if (!point) {
            tooltip.style.opacity = "0";
            return;
        }
        tooltip.textContent = body.title;
        tooltip.style.left = point.x + "px";
        tooltip.style.top = (point.y - Math.max(point.radius, 9) - 7) + "px";
        tooltip.style.opacity = "1";
    }

    function setHoveredBody(body: OrbitingBody | null) {
        if (hoveredBody === body) return;
        if (hoveredBody) {
            hoveredBody.mesh.scale.setScalar(hoveredBody.baseScale);
            hoveredBody.atmosphere?.scale.setScalar(hoveredBody.baseScale);
            hoveredBody.ring?.scale.setScalar(1);
        }
        hoveredBody = body;
        if (!body) {
            tooltip.style.opacity = "0";
            return;
        }
        // Grow, do not dim. The previous handler dropped the hovered body's opacity to
        // 0.72, which reads as pushing it away rather than picking it out.
        body.mesh.scale.setScalar(body.baseScale * 1.12);
        body.atmosphere?.scale.setScalar(body.baseScale * 1.12);
        body.ring?.scale.setScalar(1.12);
        showBodyTooltip(body);
    }

    const gesture = new BodyGesture();
    const onSystemPointerDown = (event: PointerEvent) => {
        if ((event.target as HTMLElement).closest("[data-cosmos-section]")) return;
        if (event.button === 0) gesture.begin(event);
    };
    const onSystemPointerMove = (event: PointerEvent) => {
        gesture.move(event);
        if (event.pointerType === "touch" || event.buttons !== 0) { setHoveredBody(null); return; }
        const body = pickBody(event.clientX, event.clientY);
        setHoveredBody(body);
        if (body) element.style.cursor = "pointer";
        else if (!view.hover) element.style.cursor = "default";
    };
    const onSystemPointerUp = (event: PointerEvent) => {
        if ((event.target as HTMLElement).closest("[data-cosmos-section]")) return;
        const action = gesture.finish(event);
        if (!action || event.button !== 0) return;
        if (action === "drag") { consumedPointers.add(event); return; }
        const body = pickBody(event.clientX, event.clientY);
        if (!body) return;
        // ForceGraph dispatches from this pointerup on its next frame, not from click.
        consumedPointers.add(event);
        lastClick = { id: "", at: 0 };
        setHoveredBody(event.pointerType === "touch" ? null : body);
        handlers.onSectionClick(body.sectionId, body.title);
    };
    const onSystemPointerCancel = () => { gesture.cancel(); setHoveredBody(null); };
    const onSystemPointerLeave = () => { setHoveredBody(null); };
    element.addEventListener("pointerdown", onSystemPointerDown, true);
    element.addEventListener("pointermove", onSystemPointerMove, true);
    element.addEventListener("pointerup", onSystemPointerUp, true);
    element.addEventListener("pointercancel", onSystemPointerCancel, true);
    element.addEventListener("pointerleave", onSystemPointerLeave);

    function applyStarStyle(node: GNode, star: StarObject) {
        const material = star.corona.material as THREE.SpriteMaterial;
        const coreMaterial = star.core.material as THREE.SpriteMaterial;
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
                // Barely above the resting state. Stars already sit at the bloom
                // threshold, so a real brightness jump blows the hovered star and its
                // whole neighbourhood into overlapping white discs. Hover is signalled
                // by dimming everything else, not by lighting these up further.
                opacity = 0.96;
                scale = view.hover === node.id ? 1.05 : 1;
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

        if (view.systemFocus !== null) {
            if (node.id === view.systemFocus) scale *= SYSTEM_ZOOM;
            else {
                opacity *= SYSTEM_BACKGROUND_OPACITY;
                scale *= SYSTEM_NEIGHBOUR_SHRINK;
            }
        }

        material.color.set(color);
        material.opacity = node.id === system?.rootId ? opacity * 0.55 : opacity;
        material.map = getTexture(classifyStar(node));

        // The core is driven past 1 so a lone star clears the bloom threshold on its
        // own, and is mixed toward white so the colour reads as corona rather than as a
        // flat tint over the whole disc. A protostar has no resolved core to burn.
        const resolved = classifyStar(node) !== "protostar";
        coreMaterial.visible = resolved && opacity > 0.25 && node.id !== system?.rootId;
        coreMaterial.color.set(color).lerp(WHITE, 0.72).multiplyScalar(CORE_OVERDRIVE);
        coreMaterial.opacity = opacity;

        star.baseSize = starSize(node) * scale;
        updateStarSize(node.id, star);
    }

    const starDepth = new THREE.Vector3();
    function updateStarSize(id: string, star: StarObject) {
        let size = star.baseSize;
        if (view.systemFocus && id !== view.systemFocus) {
            const camera = graph.camera() as THREE.PerspectiveCamera;
            const depth = -star.group.getWorldPosition(starDepth).applyMatrix4(camera.matrixWorldInverse).z;
            const pixels = graph.width() < 760 ? 22 : 28;
            const minimum = pixels * 2 * Math.tan(camera.fov * Math.PI / 360) * Math.max(0, depth) / Math.max(1, graph.height());
            size = Math.max(size, minimum);
        }
        star.group.scale.setScalar(size);
    }

    function applyNodeStyles() {
        for (const [id, star] of starById) {
            const node = nodeById.get(id);
            if (node) applyStarStyle(node, star);
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
        selectionRing.scale.setScalar((starById.get(node.id)?.group.scale.x ?? starSize(node)) * 0.82);
        (selectionRing.material as THREE.SpriteMaterial).color.set(lensColor(node, view.lens));
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
        simulationReady = true;
        clearance.constrain();
        tickCount++;
        if (styleDirty) {
            applyNodeStyles();
            styleDirty = false;
        }
        updateSelectionRing();
        if (tickCount % NEBULA_EVERY_TICKS === 0) updateNebulae();
    });

    function flyToNode(node: GNode, distance: number) {
        if (node.x === undefined) return;
        const camera = graph.camera();
        const controls = graph.controls() as { target?: THREE.Vector3 };
        const target = controls.target ?? new THREE.Vector3();
        const destination = { x: node.x, y: node.y ?? 0, z: node.z ?? 0 };
        graph.cameraPosition(cameraStandOff(camera.position, target, destination, distance), destination, reducedMotion ? 0 : 900);
    }

    function bloomWanted() {
        return !disposed && quality === "auto" && nodeById.size <= BLOOM_NODE_LIMIT && !isSoftwareRenderer(renderer);
    }

    async function ensureBloom(width: number, height: number) {
        const revision = ++bloomRevision;
        const composer = graph.postProcessingComposer();
        if (!bloomWanted()) {
            if (bloom?.enabled) { composer.removePass(bloom.pass); bloom.enabled = false; }
            return;
        }
        if (bloom?.enabled || bloomPending) return;
        if (bloom) {
            composer.insertPass(bloom.pass, composer.passes.indexOf(outputPass));
            bloom.enabled = true;
            return;
        }
        bloomPending = true;
        try {
            const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
            if (!bloomWanted()) return;
            const pass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.45, 1.12);
            composer.insertPass(pass, composer.passes.indexOf(outputPass));
            bloom = { pass, enabled: true };
        } catch (error) {
            if (!disposed) console.warn("[Cosmos] Bloom unavailable; falling back to plain rendering.", error);
        } finally {
            bloomPending = false;
            if (!disposed && revision !== bloomRevision && bloomWanted() && !bloom) void ensureBloom(graph.width(), graph.height());
        }
    }

    return {
        graph,

        setData(nodes, links) {
            nodeById.clear();
            for (const node of nodes) nodeById.set(node.id, node);
            graph.graphData({ nodes, links });

            // Never clear starById wholesale. data-bind-mapper's digest calls
            // nodeThreeObject only for ids ENTERING the set, so a surviving star keeps
            // the sprite it already has and would never be re-registered. Clearing
            // dropped every survivor out of applyNodeStyles, freezing its colour,
            // opacity and scale for good: filter twice with nothing new entering and
            // the whole graph became permanently un-restylable.
            for (const id of [...starById.keys()]) {
                if (!nodeById.has(id)) starById.delete(id);
            }

            styleDirty = true;
            applyNodeStyles();
            void ensureBloom(graph.width(), graph.height());
        },

        restyle() {
            styleDirty = true;
            applyNodeStyles();
            updateSelectionRing();
            // Link accessors are re-read only when reassigned.
            graph.linkColor(graph.linkColor());
            graph.linkWidth(graph.linkWidth());
            updateNebulae();
            const root = system ? nodeById.get(system.rootId) : undefined;
            if (photosphere && root) photosphere.material.uniforms.surfaceColor.value.set(lensColor(root, view.lens));
        },

        setClusters(next) {
            clusters = next;
            void clusters;
            updateNebulae();
        },

        setSystem(spec) {
            view.systemFocus = spec?.rootId ?? null;
            graph.enableNodeDrag(!spec);
            if (!spec) clearSystem();
            else buildSystem(spec);
            applyNodeStyles();
            updateSelectionRing();
            graph.linkColor(graph.linkColor());
            graph.linkWidth(graph.linkWidth());
            applyLinkDistance();
            applyChargeStrength();
            if (simulationReady && nodeById.size > 0) graph.d3ReheatSimulation();
        },

        // Standoff is derived from filament length, not fixed: at a hard 150 the camera
        // sat proportionally much closer once linkDist went 62 -> 115, so clicking a
        // star pushed its whole neighbourhood off-screen and read as a lock-on.
        flyTo(node, distance = physics.linkDist * FLY_STANDOFF) {
            flyToNode(node, distance);
        },

        frameSystem() {
            if (!system) return;
            const root = nodeById.get(system.rootId);
            if (!root) return;
            // Sized from the system's own extent. Entering a system widens the layout to
            // hold neighbours clear of the orbits, which otherwise leaves the sun off
            // frame at whatever zoom the previous view happened to be at.
            // Floored against the sun's own halo so a one-planet system is not framed so
            // close that the star fills the viewport.
            const extent = Math.max(systemOuterRadius, systemSunHalo * 3.4);
            const camera = graph.camera() as THREE.PerspectiveCamera;
            const safeWidth = Math.max(graph.width() * 0.35, graph.width() - view.labelSafeArea.left - view.labelSafeArea.right);
            flyToNode(root, systemFrameDistance(extent, camera.fov, safeWidth / Math.max(1, graph.height())));
        },

        zoom(factor) {
            const camera = graph.camera();
            const controls = graph.controls() as { target?: THREE.Vector3; minDistance?: number; maxDistance?: number };
            const target = controls.target ?? new THREE.Vector3();
            const distance = Math.max(controls.minDistance ?? 1, Math.min(controls.maxDistance ?? Infinity, camera.position.distanceTo(target) * factor));
            graph.cameraPosition(cameraStandOff(camera.position, target, target, distance), target, reducedMotion ? 0 : 260);
        },

        // flyTo parks the trackball pivot on the star it framed, and nothing else ever
        // moves it back, so after closing a page a drag still swung the whole graph
        // around a page nobody had open. Pull back along the current view axis and hand
        // the pivot to the centre of what is rendered.
        releaseFocus() {
            let cx = 0, cy = 0, cz = 0, count = 0;
            for (const node of nodeById.values()) {
                if (node.x === undefined) continue;
                cx += node.x;
                cy += node.y ?? 0;
                cz += node.z ?? 0;
                count++;
            }
            if (count === 0) return;

            const target = new THREE.Vector3(cx / count, cy / count, cz / count);
            const camera = graph.camera() as THREE.Camera;
            const offset = camera.position.clone().sub(target);
            const length = offset.length();
            // Degenerate only if the camera sits exactly on the centroid; there is no
            // view axis to pull back along, so leave it alone.
            if (length < 1e-3) return;

            offset.setLength(length * PIVOT_RELEASE_PULLBACK);
            const next = target.clone().add(offset);
            graph.cameraPosition(
                { x: next.x, y: next.y, z: next.z },
                { x: target.x, y: target.y, z: target.z },
                reducedMotion ? 0 : 700,
            );
        },

        frameAll() {
            graph.zoomToFit(reducedMotion ? 0 : 800, 90);
        },

        frameNodes(ids) {
            if (ids.size === 0) return;
            graph.zoomToFit(reducedMotion ? 0 : 800, 100, (node) => ids.has(node.id));
        },

        applyPhysics(settings) {
            physics = { ...settings };
            applyChargeStrength();
            applyLinkDistance();
            (graph.d3Force("center") as { strength?: (v: number) => void } | undefined)?.strength?.(settings.center);
            // graphData is synchronous; its first simulation layout is installed later.
            if (simulationReady && nodeById.size > 0) graph.d3ReheatSimulation();
        },

        setQuality(next) {
            quality = next;
            starfield.visible = next === "auto";
            void ensureBloom(graph.width(), graph.height());
            updateNebulae();
        },

        setMotionPaused(paused) {
            motionPaused = paused;
            lastSystemPaint = null;
        },

        bloomActive() {
            return bloom?.enabled === true;
        },

        resize(width, height) {
            const previousWidth = graph.width(), previousHeight = graph.height();
            const camera = graph.camera() as THREE.PerspectiveCamera;
            const controls = graph.controls() as { target?: THREE.Vector3 };
            const target = controls.target?.clone();
            const nextPosition = system && target && previousWidth > 0 && previousHeight > 0 && width > 0 && height > 0
                ? resizeSystemView(camera.position, target, camera.fov, previousWidth / previousHeight, width / height)
                : null;
            graph.width(width).height(height);
            if (nextPosition && target && Math.hypot(
                nextPosition.x - camera.position.x, nextPosition.y - camera.position.y, nextPosition.z - camera.position.z,
            ) > 0.001) graph.cameraPosition(nextPosition, target, 0);
        },

        dispose() {
            disposed = true;
            bloomRevision++;
            if (systemRaf) cancelAnimationFrame(systemRaf);
            systemRaf = 0;
            element.removeEventListener("pointerdown", onSystemPointerDown, true);
            element.removeEventListener("pointermove", onSystemPointerMove, true);
            element.removeEventListener("pointerup", onSystemPointerUp, true);
            element.removeEventListener("pointercancel", onSystemPointerCancel, true);
            element.removeEventListener("pointerleave", onSystemPointerLeave);
            motionPreference.removeEventListener("change", onMotionPreference);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            if (bloom) { graph.postProcessingComposer().removePass(bloom.pass); bloom.pass.dispose(); }
            graph.postProcessingComposer().removePass(outputPass);
            outputPass.dispose();
            clearSystem();
            tooltip.remove();
            scene.remove(systemGroup, systemLight);
            systemLight.dispose();
            for (const sprite of nebulaById.values()) {
                scene.remove(sprite);
                (sprite.material as THREE.SpriteMaterial).dispose();
            }
            nebulaById.clear();
            scene.remove(starfield);
            starfield.traverse((child) => {
                if (child instanceof THREE.Points) { child.geometry.dispose(); (child.material as THREE.PointsMaterial).dispose(); }
            });
            scene.remove(selectionRing);
            (selectionRing.material as THREE.SpriteMaterial).dispose();
            starById.clear();
            nodeById.clear();
            graph._destructor();
        },
    };
}
