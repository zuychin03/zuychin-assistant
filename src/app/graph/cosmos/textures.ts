import * as THREE from "three";
import type { StarClass } from "./palette";

// One canvas texture per star class, drawn once and shared by every sprite. The
// previous implementation allocated a SpriteText canvas per node, which is what
// made a few hundred pages crawl.

type TextureKind = StarClass | "nebula" | "ring";

const cache = new Map<string, THREE.Texture>();

// Surface families for section bodies. A page's sections are arbitrary, so the type
// is picked from a hash of the section id: stable across renders, and varied enough
// that a system reads as a collection of worlds rather than a row of identical discs.
export const BODY_TYPES = ["rocky", "banded", "icy", "molten", "terran"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

const SURFACE_VARIANTS = 3;

/** Deterministic, so a section keeps the same world between reloads. */
function hashString(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface BodyLook {
    type: BodyType;
    variant: number;
    /** Rings are rare enough to stay special, and never on the smallest bodies. */
    ringed: boolean;
}

export function bodyLook(sectionId: string, chars: number): BodyLook {
    const hash = hashString(sectionId);
    const type = BODY_TYPES[hash % BODY_TYPES.length];
    const variant = (hash >>> 8) % SURFACE_VARIANTS;
    // Banded worlds are the ones that carry rings convincingly, and only if the
    // section has enough body to be drawn large.
    const ringed = (type === "banded" || type === "icy") && chars > 400 && ((hash >>> 16) & 3) !== 0;
    return { type, variant, ringed };
}

const SURFACE: Record<BodyType, { base: string; shade: string; detail: string; accent: string }> = {
    rocky:  { base: "#9a8f81", shade: "#4e463d", detail: "#6f6559", accent: "#c4b9a8" },
    banded: { base: "#d8a463", shade: "#7d4f28", detail: "#b87a3e", accent: "#f0d3a4" },
    icy:    { base: "#cfe4f4", shade: "#5d7d99", detail: "#9dc0da", accent: "#ffffff" },
    molten: { base: "#4a2a22", shade: "#1d100d", detail: "#2e1913", accent: "#ff7133" },
    terran: { base: "#2f6fb5", shade: "#173a63", detail: "#4d8f4c", accent: "#eaf4ff" },
};

type Stop = [offset: number, alpha: number];

// Cores are deliberately wide. The previous falloff was down to 0.34 alpha by 0.26 of
// the radius, so a star's readable disc was a quarter of its sprite: it rendered as a
// pinprick inside a large halo, and its own planets measured four times its size.
const GRADIENTS: Record<Exclude<TextureKind, "ring">, Stop[]> = {
    // Resolved photosphere with a tight corona: a healthy main-sequence page.
    star: [[0, 1], [0.24, 0.98], [0.36, 0.72], [0.47, 0.24], [0.74, 0.06], [1, 0]],
    // No resolved core, wide haze: never finished collapsing (unreviewed).
    protostar: [[0, 0.46], [0.34, 0.28], [0.68, 0.08], [1, 0]],
    // Large, dim, swollen: cooling after a long time untouched.
    giant: [[0, 0.82], [0.28, 0.62], [0.46, 0.3], [0.7, 0.1], [1, 0]],
    // Small and tight: retired, still there but spent.
    dwarf: [[0, 1], [0.15, 0.9], [0.25, 0.42], [0.46, 0.07], [1, 0]],
    nebula: [[0, 0.17], [0.4, 0.085], [0.76, 0.02], [1, 0]],
};

/**
 * Fraction of a star sprite's half-extent that reads as its disc, from the gradients
 * above. Anything sizing itself against a star has to use this rather than the sprite
 * scale, or it compares against the corona and comes out far too large.
 */
export const STAR_CORE_FRACTION = 0.4;

// Diffraction spikes per class: [reach as a fraction of the radius, peak alpha,
// core thickness]. This is the cue that separates a star from a round dot, and a
// protostar gets none because an unresolved haze has no airy pattern to spike.
const SPIKES: Partial<Record<Exclude<TextureKind, "ring">, [number, number, number]>> = {
    star: [0.96, 0.5, 0.02],
    giant: [0.72, 0.26, 0.032],
    dwarf: [0.66, 0.34, 0.014],
};

/** One arm of the diffraction cross, tapering to nothing at its tip. */
function drawSpike(
    ctx: CanvasRenderingContext2D,
    centre: number,
    angle: number,
    reach: number,
    alpha: number,
    thickness: number,
) {
    ctx.save();
    ctx.translate(centre, centre);
    ctx.rotate(angle);
    const gradient = ctx.createLinearGradient(0, 0, reach, 0);
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(0.12, `rgba(255,255,255,${alpha * 0.5})`);
    gradient.addColorStop(0.45, `rgba(255,255,255,${alpha * 0.14})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    // A triangle, not a rectangle: a spike of constant width reads as a plus sign.
    ctx.beginPath();
    ctx.moveTo(0, -thickness);
    ctx.lineTo(reach, 0);
    ctx.lineTo(0, thickness);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function radialTexture(kind: Exclude<TextureKind, "ring">, size: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;

    const spike = SPIKES[kind];
    if (spike) {
        const [reachFactor, alpha, thicknessFactor] = spike;
        const reach = centre * reachFactor;
        const thickness = centre * thicknessFactor;
        // Long vertical and horizontal arms, shorter and fainter diagonals.
        for (let i = 0; i < 4; i++) {
            drawSpike(ctx, centre, (Math.PI / 2) * i, reach, alpha, thickness);
        }
        for (let i = 0; i < 4; i++) {
            drawSpike(ctx, centre, Math.PI / 4 + (Math.PI / 2) * i, reach * 0.42, alpha * 0.36, thickness * 0.8);
        }
    }

    // Core last so it sits over the spikes' origin instead of being crossed by them.
    const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);
    for (const [offset, alpha] of GRADIENTS[kind]) {
        gradient.addColorStop(offset, `rgba(255,255,255,${alpha})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

// Worlds with an atmosphere get a limb glow: a dim halo just outside the disc. It is
// the cheapest realism cue there is, and it is what stops a textured circle from
// still reading as a sticker.
const ATMOSPHERE: Partial<Record<BodyType, string>> = {
    terran: "150,196,255",
    icy: "186,222,246",
    banded: "244,206,152",
    molten: "255,122,64",
};

function atmosphereTexture(size: number, rgb: string): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;

    // Hollow: the inner stop is transparent so the halo never washes out the surface
    // it is wrapped around.
    const gradient = ctx.createRadialGradient(centre, centre, centre * 0.52, centre, centre, centre);
    gradient.addColorStop(0, `rgba(${rgb},0)`);
    gradient.addColorStop(0.58, `rgba(${rgb},0.30)`);
    gradient.addColorStop(0.72, `rgba(${rgb},0.16)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

export function createAtmosphere(type: BodyType, scale: number): THREE.Sprite | null {
    const rgb = ATMOSPHERE[type];
    if (!rgb) return null;
    const key = `atmosphere:${type}`;
    let texture = cache.get(key);
    if (!texture) {
        texture = atmosphereTexture(128, rgb);
        cache.set(key, texture);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    }));
    sprite.scale.setScalar(scale * 1.5);
    return sprite;
}

/**
 * Surface detail for one world, drawn inside the disc before it is lit. Painted in
 * full colour rather than greyscale: tinting one grey disc per page category is what
 * made every section the same shade of green.
 */
function paintSurface(
    ctx: CanvasRenderingContext2D,
    type: BodyType,
    random: () => number,
    centre: number,
    radius: number,
) {
    const skin = SURFACE[type];
    ctx.fillStyle = skin.base;
    ctx.fillRect(0, 0, centre * 2, centre * 2);

    if (type === "banded") {
        // Bands wander rather than running straight, so a gas giant does not read as
        // a set of stacked rectangles.
        const bands = 9 + Math.floor(random() * 5);
        for (let i = 0; i < bands; i++) {
            const y = centre - radius + ((i + random() * 0.5) / bands) * radius * 2;
            const thickness = (radius * 2 / bands) * (0.55 + random() * 0.8);
            ctx.fillStyle = i % 2 === 0 ? skin.detail : skin.accent;
            ctx.globalAlpha = 0.35 + random() * 0.35;
            ctx.beginPath();
            ctx.ellipse(centre, y, radius * 1.2, thickness / 2, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = skin.shade;
        ctx.beginPath();
        ctx.ellipse(centre + radius * 0.2, centre - radius * 0.3, radius * 0.26, radius * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
    }

    if (type === "rocky") {
        for (let i = 0; i < 34; i++) {
            const angle = random() * Math.PI * 2;
            const dist = Math.sqrt(random()) * radius * 0.94;
            const x = centre + Math.cos(angle) * dist;
            const y = centre + Math.sin(angle) * dist;
            const r = radius * (0.05 + random() * 0.13);
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = skin.detail;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            // Lit crater rim on the upper left, matching the light direction below.
            ctx.globalAlpha = 0.4;
            ctx.strokeStyle = skin.accent;
            ctx.lineWidth = r * 0.28;
            ctx.beginPath();
            ctx.arc(x, y, r, Math.PI * 0.85, Math.PI * 1.75);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return;
    }

    if (type === "icy") {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = skin.detail;
        for (let i = 0; i < 16; i++) {
            ctx.lineWidth = radius * (0.012 + random() * 0.02);
            ctx.beginPath();
            let x = centre + (random() - 0.5) * radius * 1.8;
            let y = centre + (random() - 0.5) * radius * 1.8;
            ctx.moveTo(x, y);
            for (let step = 0; step < 4; step++) {
                x += (random() - 0.5) * radius * 0.7;
                y += (random() - 0.5) * radius * 0.7;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = skin.accent;
        for (const capY of [centre - radius * 0.88, centre + radius * 0.88]) {
            ctx.beginPath();
            ctx.ellipse(centre, capY, radius * 0.62, radius * 0.2, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        return;
    }

    if (type === "molten") {
        ctx.fillStyle = skin.detail;
        for (let i = 0; i < 20; i++) {
            const angle = random() * Math.PI * 2;
            const dist = Math.sqrt(random()) * radius;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(centre + Math.cos(angle) * dist, centre + Math.sin(angle) * dist,
                radius * (0.1 + random() * 0.22), 0, Math.PI * 2);
            ctx.fill();
        }
        // Fissures are the one place a body is allowed to be bright: they read as
        // emission, and clearing the bloom threshold here is the point.
        ctx.strokeStyle = skin.accent;
        ctx.globalAlpha = 0.9;
        for (let i = 0; i < 11; i++) {
            ctx.lineWidth = radius * (0.02 + random() * 0.035);
            ctx.beginPath();
            let x = centre + (random() - 0.5) * radius * 1.6;
            let y = centre + (random() - 0.5) * radius * 1.6;
            ctx.moveTo(x, y);
            for (let step = 0; step < 3; step++) {
                x += (random() - 0.5) * radius * 0.8;
                y += (random() - 0.5) * radius * 0.8;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return;
    }

    // terran
    ctx.fillStyle = skin.detail;
    for (let i = 0; i < 9; i++) {
        const angle = random() * Math.PI * 2;
        const dist = Math.sqrt(random()) * radius * 0.8;
        const cx = centre + Math.cos(angle) * dist;
        const cy = centre + Math.sin(angle) * dist;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        // A blob of overlapping circles reads as a landmass; one ellipse reads as a pill.
        for (let lobe = 0; lobe < 6; lobe++) {
            const lx = cx + (random() - 0.5) * radius * 0.5;
            const ly = cy + (random() - 0.5) * radius * 0.4;
            ctx.moveTo(lx, ly);
            ctx.arc(lx, ly, radius * (0.09 + random() * 0.16), 0, Math.PI * 2);
        }
        ctx.fill();
    }
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = skin.accent;
    for (const capY of [centre - radius * 0.9, centre + radius * 0.9]) {
        ctx.beginPath();
        ctx.ellipse(centre, capY, radius * 0.5, radius * 0.17, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.ellipse(centre + (random() - 0.5) * radius * 1.5, centre + (random() - 0.5) * radius * 1.5,
            radius * (0.2 + random() * 0.3), radius * 0.07, random() * 0.6, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

/**
 * A world that reflects light rather than emitting it: surface detail, then a
 * terminator falling away from the upper left, then a rim light on the dark limb.
 * Normal-blended unlike the additive stars, and kept under the bloom threshold, so
 * a planet never reads as another star.
 */
function bodyTexture(size: number, type: BodyType | "moon", variant: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;
    const radius = centre * 0.9;
    const random = mulberry32(hashString(`${type}:${variant}`));

    ctx.save();
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.clip();

    if (type === "moon") {
        ctx.fillStyle = "#b3b7c0";
        ctx.fillRect(0, 0, size, size);
        for (let i = 0; i < 26; i++) {
            const angle = random() * Math.PI * 2;
            const dist = Math.sqrt(random()) * radius * 0.95;
            ctx.globalAlpha = 0.45;
            ctx.fillStyle = "#8b8f99";
            ctx.beginPath();
            ctx.arc(centre + Math.cos(angle) * dist, centre + Math.sin(angle) * dist,
                radius * (0.06 + random() * 0.15), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    } else {
        paintSurface(ctx, type, random, centre, radius);
    }

    // Sphere shading. Multiply so the surface colours survive underneath instead of
    // being washed out by an overlaid white gradient.
    ctx.globalCompositeOperation = "multiply";
    const lit = ctx.createRadialGradient(
        centre - radius * 0.38, centre - radius * 0.42, radius * 0.08,
        centre + radius * 0.15, centre + radius * 0.2, radius * 1.5,
    );
    lit.addColorStop(0, "rgba(255,255,255,1)");
    lit.addColorStop(0.42, "rgba(196,201,214,1)");
    lit.addColorStop(0.74, "rgba(88,94,110,1)");
    lit.addColorStop(1, "rgba(16,18,26,1)");
    ctx.fillStyle = lit;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();

    // Rim light on the dark limb keeps the silhouette readable against the void.
    ctx.strokeStyle = type === "moon" ? "rgba(206,214,232,0.32)" : "rgba(214,226,255,0.42)";
    ctx.lineWidth = size * 0.014;
    ctx.beginPath();
    ctx.arc(centre, centre, radius * 0.99, Math.PI * 0.15, Math.PI * 1.1);
    ctx.stroke();

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

/** Concentric ring bands with gaps. RingGeometry UVs map this on radially. */
function planetRingTexture(size: number, variant: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;
    const random = mulberry32(hashString(`ring:${variant}`));

    let r = centre * 0.42;
    while (r < centre * 0.98) {
        const width = centre * (0.012 + random() * 0.05);
        const alpha = 0.1 + random() * 0.55;
        ctx.strokeStyle = `rgba(226,214,190,${alpha})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(centre, centre, r + width / 2, 0, Math.PI * 2);
        ctx.stroke();
        r += width + centre * (0.004 + random() * 0.03);
    }

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

/**
 * A real tilted mesh rather than a sprite: a ring has to sit in a plane and read as
 * going behind the planet, which a camera-facing sprite cannot do.
 */
export function createPlanetRing(planetScale: number, variant: number): THREE.Mesh {
    const geometry = new THREE.RingGeometry(planetScale * 0.78, planetScale * 1.42, 72);
    const key = `planet-ring:${variant}`;
    let texture = cache.get(key);
    if (!texture) {
        texture = planetRingTexture(256, variant);
        cache.set(key, texture);
    }
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        opacity: 0.85,
    });
    return new THREE.Mesh(geometry, material);
}

function ringTexture(size: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = size * 0.022;
    ctx.beginPath();
    ctx.arc(centre, centre, centre * 0.76, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = size * 0.06;
    ctx.beginPath();
    ctx.arc(centre, centre, centre * 0.76, 0, Math.PI * 2);
    ctx.stroke();

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

export function getTexture(kind: TextureKind): THREE.Texture {
    const existing = cache.get(kind);
    if (existing) return existing;
    const texture = kind === "ring"
        ? ringTexture(256)
        : radialTexture(kind, kind === "nebula" ? 256 : 160);
    cache.set(kind, texture);
    return texture;
}

function getBodyTexture(type: BodyType | "moon", variant: number): THREE.Texture {
    const key = `body:${type}:${variant}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const texture = bodyTexture(type === "moon" ? 128 : 192, type, variant);
    cache.set(key, texture);
    return texture;
}

/**
 * Normal-blended, so a world occludes rather than adding light like a star. The
 * material colour stays white: the surface is painted in colour, and tinting it was
 * what made every section on a page the same shade.
 */
export function createBodySprite(type: BodyType | "moon", variant: number, scale: number): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getBodyTexture(type, variant),
        transparent: true,
        depthWrite: false,
        opacity: type === "moon" ? 0.94 : 1,
    }));
    sprite.scale.setScalar(scale);
    return sprite;
}

/** Thin circle in the XZ plane marking an orbit path. */
export function createOrbitRing(radius: number, color: string, opacity: number): THREE.Line {
    const points: THREE.Vector3[] = [];
    const segments = 96;
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        depthWrite: false,
    });
    return new THREE.Line(geometry, material);
}

/**
 * Per-node material over a shared texture. Sprites are one draw call each either
 * way, so an own material costs nothing extra and lets colour and opacity be set
 * per star without rebuilding anything.
 */
export function createStarMaterial(kind: StarClass): THREE.SpriteMaterial {
    return new THREE.SpriteMaterial({
        map: getTexture(kind),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

// A tight, near-opaque centre. Paired with the class gradient as a corona, this is what
// separates a star from a flat tinted disc: the core burns white while the colour lives
// in the halo around it. One sprite tinted end to end can only ever be a 2D globe.
const CORE_STOPS: Stop[] = [[0, 1], [0.13, 0.98], [0.24, 0.6], [0.4, 0.12], [1, 0]];

function coreTexture(size: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;
    const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);
    for (const [offset, alpha] of CORE_STOPS) {
        gradient.addColorStop(offset, `rgba(255,255,255,${alpha})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
}

/**
 * Multiplier pushing a lone star's core past the bloom threshold. The composer's target
 * is half-float, so values over 1 survive to the bloom pass; without this a single star
 * sat under the cut and only lit up where two of them happened to overlap and sum.
 */
export const CORE_OVERDRIVE = 2.0;

export function createStarCoreMaterial(): THREE.SpriteMaterial {
    const key = "core";
    let texture = cache.get(key);
    if (!texture) {
        texture = coreTexture(96);
        cache.set(key, texture);
    }
    return new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

export function createNebulaSprite(color: string, scale: number): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getTexture("nebula"),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
        color: new THREE.Color(color),
    }));
    sprite.scale.setScalar(scale);
    return sprite;
}

export function createSelectionRing(): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getTexture("ring"),
        transparent: true,
        depthWrite: false,
        color: new THREE.Color("#ffffff"),
        opacity: 0.9,
    }));
    sprite.visible = false;
    return sprite;
}

/** A static shell of faint points, so panning reads as motion through space. */
export function createStarfield(count = 2200, radius = 2600): THREE.Points {
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    // Deterministic scatter: a fixed multiplier keeps the field identical between
    // reloads, so the background never appears to twitch on refresh.
    let seed = 987654321;
    const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };

    for (let i = 0; i < count; i++) {
        const theta = random() * Math.PI * 2;
        const phi = Math.acos(2 * random() - 1);
        const r = radius * (0.72 + random() * 0.28);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
        sizes[i] = 1 + random() * 2.4;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
        color: new THREE.Color("#aab6d8"),
        size: 3.2,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        map: getTexture("star"),
        blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return points;
}

export function disposeTextures(): void {
    for (const texture of cache.values()) texture.dispose();
    cache.clear();
}
