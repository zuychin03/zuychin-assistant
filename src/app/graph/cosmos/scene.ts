import * as THREE from "three";
import type { ForceGraph3DInstance } from "3d-force-graph";
import {
    bodyLook, CORE_OVERDRIVE, createAtmosphere, createBodySprite, createNebulaSprite,
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
    sprite: THREE.Sprite;
    /** Limb glow, on worlds that have an atmosphere. Moves with the sprite. */
    atmosphere: THREE.Sprite | null;
    ring: THREE.Mesh | null;
    /** Scale before any hover growth, so the highlight is reversible. */
    baseScale: number;
    sectionId: string;
    title: string;
    kind: "planet" | "moon";
    radius: number;
    angle: number;
    speed: number;
    /** Tilt of this orbit, so the system does not read as one flat disc. */
    tilt: number;
    moons: OrbitingBody[];
}

// The size hierarchy is expressed as ratios of the parent body, never as independent
// constants. Fixed values had inverted it: on a page with few links the star's disc
// measured 0.25x its own largest planet, so a system read as planets orbiting a speck.
// Ratios cannot invert.
// System view magnifies EVERY star by the same factor, so the size relationships
// between pages read exactly as they do in the full view. Boosting only the root made
// its neighbours look shrunken next to it and too small to aim at.
const SYSTEM_ZOOM = 2.6;
// Neighbours sit slightly under their true proportion, which is what marks them as
// context without touching their glow.
const SYSTEM_NEIGHBOUR_SHRINK = 0.78;
const PLANET_OF_SUN_MAX = 0.42;
const PLANET_OF_SUN_MIN = 0.2;
const MOON_OF_PLANET_MAX = 0.4;
const MOON_OF_PLANET_MIN = 0.22;
// A world's sprite is filled by its disc, unlike a star's, so any comparison between
// the two goes through STAR_CORE_FRACTION on one side and this on the other.
const BODY_FILL = 0.9;
const SYSTEM_FRAME_MS = 33;
// Generous, with the nearest body inside it winning. Sprite raycasting demanded a
// direct hit on a shape a few pixels across, which is unusable with a fingertip.
const PICK_RADIUS_FLOOR = 17;
// Orbits were drawn in COSMOS.filament at 0.18, which is all but invisible against the
// background. They are the structure that makes a system read as a system.
const ORBIT_COLOR = "#8ea3d2";
const ORBIT_OPACITY = 0.42;
// Gap held between the outermost orbit and the nearest neighbouring star. Wide on
// purpose: a neighbour is the exit from this system, so it has to sit clear of the
// orbits and stay big enough to aim at from a zoomed-out view.
// Room for the outermost orbit AND a magnified neighbour's own corona beyond it.
const SYSTEM_CLEARANCE = 430;
// Extra repulsion between everything rendered while a system is open. Clearance alone
// only pushes neighbours off the ROOT: without this they settle at that distance but
// bunch together on one side of it.
const SYSTEM_REPEL_BOOST = 2.4;

// Core size as a fraction of the corona, matching STAR_CORE_FRACTION's readable disc.
const CORE_RELATIVE_SIZE = 0.46;
const WHITE = new THREE.Color("#ffffff");

function bodyScale(chars: number, min: number, max: number): number {
    const t = Math.min(1, Math.sqrt(chars) / 55);
    return min + (max - min) * t;
}

// One orbit per planet, never a shared ring. An earlier draft packed six planets onto
// ring 1, and since most vault pages have six or fewer sections that made nearly every
// system a single flat circle of identical bodies.
//
// Every distance is a multiple of the sun's HALO radius, not its core. Measuring from
// the core put the inner orbits inside the corona and the bloom, where a planet is a
// speck against a wall of light. Scaling off the star also means a big hub gets a big
// system and a small page a small one, instead of one fixed envelope for both.
const ORBIT_BASE_OF_HALO = 1.75;
const ORBIT_SPAN_OF_HALO = 4.3;
const ORBIT_GAP_MAX_OF_HALO = 0.64;
// Floor is set by the widest planet, so neighbouring orbits can never let their bodies
// touch however many sections a page has.
const ORBIT_GAP_MIN_OF_PLANET = 1.55;
// Successive planets sit ~137.5 degrees apart, so no two line up radially and the
// system never resolves into spokes.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function orbitGap(count: number, halo: number, planetMax: number): number {
    const gapMax = halo * ORBIT_GAP_MAX_OF_HALO;
    const gapMin = planetMax * ORBIT_GAP_MIN_OF_PLANET;
    if (count <= 1) return gapMax;
    return Math.max(gapMin, Math.min(gapMax, (halo * ORBIT_SPAN_OF_HALO) / count));
}

/** Kepler's third law, so outer bodies visibly lag rather than turning in lockstep. */
function orbitSpeed(base: number, radius: number, k: number): number {
    return k / Math.pow(Math.max(1, radius / base), 1.5);
}

/**
 * Inclination per planet. Cycling three offsets with an alternating sign keeps
 * neighbouring orbits crossing at a visible angle instead of nesting into a disc.
 */
function orbitTilt(index: number): number {
    return 0.3 + (index % 3) * 0.17 + (index % 2 === 0 ? 0.11 : -0.13);
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
    releaseFocus(): void;
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

    // Each star is two additive sprites in a group: a coloured corona and a white-hot
    // core. Scaling the group scales both, so sizing stays one number.
    interface StarObject { group: THREE.Group; corona: THREE.Sprite; core: THREE.Sprite; }
    const starById = new Map<string, StarObject>();
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
            const corona = new THREE.Sprite(createStarMaterial(classifyStar(node)));
            corona.scale.setScalar(1);
            const core = new THREE.Sprite(createStarCoreMaterial());
            core.scale.setScalar(CORE_RELATIVE_SIZE);
            const group = new THREE.Group();
            // Corona first: additive, so ordering only matters for the depth-sorted pass.
            group.add(corona, core);
            group.scale.setScalar(starSize(node));
            starById.set(node.id, { group, corona, core });
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
            return Math.max(physics.linkDist, systemOuterRadius + SYSTEM_CLEARANCE);
        });
    }

    // ---- Section system overlay ----
    // These bodies are NOT graph nodes. Injecting them into the simulation would
    // make a page's own sections repel its neighbours and tear the neighbourhood
    // apart, so they live in their own group with their own picking.

    const systemGroup = new THREE.Group();
    systemGroup.visible = false;
    scene.add(systemGroup);

    let system: { rootId: string; bodies: OrbitingBody[] } | null = null;
    // Outermost orbit of the open system, so the layout can hold neighbouring stars
    // outside it. At the default linkDist a neighbour settles at 115 while a system
    // with several sections reaches past 130, which put other stars inside the orbits.
    let systemOuterRadius = 0;
    let systemSunHalo = 0;
    let hoveredBody: OrbitingBody | null = null;
    let systemRaf = 0;
    let lastSystemPaint = 0;
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
        for (const child of [...systemGroup.children]) {
            systemGroup.remove(child);
            if (child instanceof THREE.Sprite) (child.material as THREE.SpriteMaterial).dispose();
            if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
            }
        }
        system = null;
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

        // Every size below is measured against the sun's visible DISC, not its sprite
        // box, and divided back through BODY_FILL because a world fills its own sprite
        // while a star does not.
        const sunSprite = starSize(root) * SYSTEM_ZOOM;
        const sunDisc = sunSprite * STAR_CORE_FRACTION;
        // Half the sprite: where the corona actually fades out, which is what a planet
        // has to clear to be visible at all.
        const sunHalo = sunSprite * 0.5;
        const planetMax = (sunDisc * PLANET_OF_SUN_MAX) / BODY_FILL;
        const planetMin = (sunDisc * PLANET_OF_SUN_MIN) / BODY_FILL;
        const base = sunHalo * ORBIT_BASE_OF_HALO + planetMax + 12;
        const gap = orbitGap(spec.planets.length, sunHalo, planetMax);
        systemSunHalo = sunHalo;
        const bodies: OrbitingBody[] = [];

        spec.planets.forEach((planet, index) => {
            const radius = base + index * gap;
            const tilt = orbitTilt(index);

            const orbit = createOrbitRing(radius, ORBIT_COLOR, ORBIT_OPACITY);
            orbit.rotation.x = tilt;
            systemGroup.add(orbit);

            const look = bodyLook(planet.id, planet.chars);
            const scale = bodyScale(planet.chars, planetMin, planetMax);

            // Glow first, then the ring, then the body. Sprites carry depthWrite false,
            // so draw order is what puts the limb glow behind the surface.
            const atmosphere = createAtmosphere(look.type, scale);
            if (atmosphere) systemGroup.add(atmosphere);

            let ring: THREE.Mesh | null = null;
            if (look.ringed) {
                const mesh = createPlanetRing(scale, look.variant);
                // Tipped well off the orbital plane, or it presents edge-on and vanishes.
                mesh.rotation.set(Math.PI / 2 + tilt * 0.5 + 0.38, 0, 0.24);
                systemGroup.add(mesh);
                ring = mesh;
            }

            const sprite = createBodySprite(look.type, look.variant, scale);
            systemGroup.add(sprite);

            const moonMax = scale * MOON_OF_PLANET_MAX;
            const moonMin = scale * MOON_OF_PLANET_MIN;
            const moonBase = scale * BODY_FILL * 0.8 + moonMax + 3.4;
            // Budgeted from this planet's lane so a moon family does not wander into the
            // next orbit. The floor wins for a section with many subsections, and there
            // the tilt spread below is what separates them.
            const moonSpan = Math.min(gap * 0.42, 20);
            const moonGap = planet.moons.length > 1
                ? Math.max(moonMax * 1.55, moonSpan / (planet.moons.length - 1))
                : 0;

            const moons: OrbitingBody[] = planet.moons.map((moon, moonIndex) => {
                const moonScale = bodyScale(moon.chars, moonMin, moonMax);
                const moonSprite = createBodySprite("moon", (moonIndex + look.variant) % 3, moonScale);
                systemGroup.add(moonSprite);
                const moonRadius = moonBase + moonIndex * moonGap;
                return {
                    sprite: moonSprite,
                    atmosphere: null,
                    ring: null,
                    baseScale: moonScale,
                    sectionId: moon.id,
                    title: moon.title,
                    kind: "moon" as const,
                    radius: moonRadius,
                    angle: moonIndex * GOLDEN_ANGLE,
                    speed: orbitSpeed(moonBase, moonRadius, 0.0135),
                    tilt: tilt + 0.32 + moonIndex * 0.15,
                    moons: [],
                };
            });

            bodies.push({
                sprite,
                atmosphere,
                ring,
                baseScale: scale,
                sectionId: planet.id,
                title: planet.title,
                kind: "planet",
                radius,
                angle: index * GOLDEN_ANGLE,
                speed: orbitSpeed(base, radius, 0.0032),
                tilt,
                moons,
            });
        });

        system = { rootId: spec.rootId, bodies };
        systemOuterRadius = bodies.length > 0 ? bodies[bodies.length - 1].radius + planetMax : 0;
        systemGroup.visible = true;
    }

    const orbitOffset = new THREE.Vector3();
    const xAxis = new THREE.Vector3(1, 0, 0);

    function placeBody(body: OrbitingBody, centre: THREE.Vector3) {
        orbitOffset.set(Math.cos(body.angle) * body.radius, 0, Math.sin(body.angle) * body.radius);
        orbitOffset.applyAxisAngle(xAxis, body.tilt);
        body.sprite.position.copy(centre).add(orbitOffset);
        body.atmosphere?.position.copy(body.sprite.position);
        body.ring?.position.copy(body.sprite.position);
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
        // The label has to track the body it names while that body is still moving.
        if (hoveredBody) showBodyTooltip(hoveredBody);
    }
    systemRaf = requestAnimationFrame(animateSystem);

    function allBodies(): OrbitingBody[] {
        if (!system) return [];
        return system.bodies.flatMap((planet) => [planet, ...planet.moons]);
    }

    /** Canvas-space centre and radius of a body, in CSS pixels. */
    function projectBody(body: OrbitingBody, rect: DOMRect) {
        const camera = graph.camera() as THREE.PerspectiveCamera;
        body.sprite.getWorldPosition(bodyWorld);
        const distance = camera.position.distanceTo(bodyWorld);
        projected.copy(bodyWorld).project(camera);
        if (projected.z < -1 || projected.z > 1) return null;
        const pxPerUnit = rect.height
            / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(distance, 0.001));
        return {
            x: (projected.x * 0.5 + 0.5) * rect.width,
            y: (-projected.y * 0.5 + 0.5) * rect.height,
            radius: body.sprite.scale.x * 0.5 * BODY_FILL * pxPerUnit,
        };
    }

    /**
     * Nearest body within a generous screen-space radius, rather than a raycast against
     * the sprite quad. A planet is a handful of pixels across at normal zoom, so an
     * exact hit test is unusable with a fingertip and barely usable with a mouse.
     */
    function pickBody(clientX: number, clientY: number): OrbitingBody | null {
        if (!system) return null;
        const rect = element.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        let best: OrbitingBody | null = null;
        let bestDistance = Infinity;
        for (const body of allBodies()) {
            const point = projectBody(body, rect);
            if (!point) continue;
            const distance = Math.hypot(point.x - px, point.y - py);
            if (distance > Math.max(point.radius, PICK_RADIUS_FLOOR)) continue;
            if (distance < bestDistance) {
                bestDistance = distance;
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
            hoveredBody.sprite.scale.setScalar(hoveredBody.baseScale);
            hoveredBody.atmosphere?.scale.setScalar(hoveredBody.baseScale * 1.5);
        }
        hoveredBody = body;
        if (!body) {
            tooltip.style.opacity = "0";
            return;
        }
        // Grow, do not dim. The previous handler dropped the hovered body's opacity to
        // 0.72, which reads as pushing it away rather than picking it out.
        body.sprite.scale.setScalar(body.baseScale * 1.2);
        body.atmosphere?.scale.setScalar(body.baseScale * 1.8);
        showBodyTooltip(body);
    }

    const onSystemPointerMove = (event: PointerEvent) => {
        // Touch has no hover, and picking on every move of a drag would both cost frames
        // and leave a planet stuck enlarged after the finger lifts.
        if (event.pointerType === "touch") return;
        const body = pickBody(event.clientX, event.clientY);
        setHoveredBody(body);
        if (body) element.style.cursor = "pointer";
        // The graph's own hover handler will not fire when leaving a planet, so the
        // pointer cursor would otherwise stick.
        else if (!view.hover) element.style.cursor = "default";
    };
    // Capture phase: a hit must not also reach the graph, which would read it as a
    // background click and clear the selection.
    const onSystemClick = (event: MouseEvent) => {
        const body = pickBody(event.clientX, event.clientY);
        if (!body) return;
        event.stopPropagation();
        event.preventDefault();
        setHoveredBody(body);
        handlers.onSectionClick(body.sectionId, body.title);
    };
    element.addEventListener("pointermove", onSystemPointerMove);
    element.addEventListener("click", onSystemClick, true);

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

        // Neighbours are set apart by SIZE, not by brightness: they keep close to their
        // normal glow and sit a little under their true proportion. Dimming them to a
        // third looked washed out, and because the treatment used to live only in the
        // resting branch, hovering removed it altogether and threw a neighbour plus all
        // of ITS neighbours from a third to near-full at 2.6x size, which is what blew
        // them into one white glob. Applying it in every branch keeps hover a nudge.
        if (view.systemFocus !== null && node.id !== view.systemFocus) {
            opacity *= SYSTEM_BACKGROUND_OPACITY;
            scale *= SYSTEM_NEIGHBOUR_SHRINK;
        }

        // Every star in system view, after the selection override which would clamp it.
        if (view.systemFocus !== null) scale *= SYSTEM_ZOOM;

        material.color.set(color);
        material.opacity = opacity;
        material.map = getTexture(classifyStar(node));

        // The core is driven past 1 so a lone star clears the bloom threshold on its
        // own, and is mixed toward white so the colour reads as corona rather than as a
        // flat tint over the whole disc. A protostar has no resolved core to burn.
        const resolved = classifyStar(node) !== "protostar";
        coreMaterial.visible = resolved && opacity > 0.25;
        coreMaterial.color.set(color).lerp(WHITE, 0.72).multiplyScalar(CORE_OVERDRIVE);
        coreMaterial.opacity = opacity;

        star.group.scale.setScalar(starSize(node) * scale);
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

    function flyToNode(node: GNode, distance: number) {
        if (node.x === undefined) return;
        const length = Math.hypot(node.x, node.y ?? 0, node.z ?? 0) || 1;
        const factor = 1 + distance / length;
        graph.cameraPosition(
            { x: node.x * factor, y: (node.y ?? 0) * factor, z: (node.z ?? 0) * factor },
            { x: node.x, y: node.y ?? 0, z: node.z ?? 0 },
            900,
        );
    }

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
            // Threshold has to clear the planets: they are normal-blended lit discs, so
            // a low threshold haloes them into stars. Stars are additive and their cores
            // stack well past this, so strength carries the glow instead.
            const pass = bloom?.pass ?? new UnrealBloomPass(new THREE.Vector2(width, height), 1.18, 0.82, 0.62);
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
        },

        setClusters(next) {
            clusters = next;
            void clusters;
            updateNebulae();
        },

        setSystem(spec) {
            if (!spec) clearSystem();
            else buildSystem(spec);
            // Link lengths and repulsion both depend on the system, so they have to be
            // recomputed and the layout reheated whenever it changes.
            applyLinkDistance();
            applyChargeStrength();
            if (graph.graphData().nodes.length > 0) graph.d3ReheatSimulation();
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
            flyToNode(root, Math.max(extent * 2.4, physics.linkDist * FLY_STANDOFF));
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
                700,
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
            applyChargeStrength();
            applyLinkDistance();
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
            tooltip.remove();
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
