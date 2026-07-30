import * as THREE from "three";
import type { StarClass } from "./palette";

// One canvas texture per star class, drawn once and shared by every sprite. The
// previous implementation allocated a SpriteText canvas per node, which is what
// made a few hundred pages crawl.

type TextureKind = StarClass | "nebula" | "ring" | "planet" | "moon";

const cache = new Map<TextureKind, THREE.Texture>();

type Stop = [offset: number, alpha: number];

const GRADIENTS: Record<Exclude<TextureKind, "ring" | "planet" | "moon">, Stop[]> = {
    // Crisp core, tight falloff: a healthy main-sequence page.
    star: [[0, 1], [0.11, 0.94], [0.26, 0.34], [0.58, 0.075], [1, 0]],
    // No resolved core, wide haze: never finished collapsing (unreviewed).
    protostar: [[0, 0.44], [0.33, 0.26], [0.68, 0.075], [1, 0]],
    // Large, dim, swollen: cooling after a long time untouched.
    giant: [[0, 0.72], [0.2, 0.44], [0.52, 0.16], [1, 0]],
    // Small and tight: retired, still there but spent.
    dwarf: [[0, 1], [0.08, 0.86], [0.17, 0.2], [0.42, 0.03], [1, 0]],
    nebula: [[0, 0.17], [0.4, 0.085], [0.76, 0.02], [1, 0]],
};

function radialTexture(kind: Exclude<TextureKind, "ring" | "planet" | "moon">, size: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;

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

/**
 * A body that reflects light rather than emitting it: a solid disc with a
 * terminator falling away from the upper-left, plus a faint rim. Drawn in
 * greyscale so the sprite's material colour tints it. Rendered with normal
 * blending, unlike the additive stars. That contrast is what makes a planet read
 * as a planet next to a glowing star.
 */
function bodyTexture(size: number, moon: boolean): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;
    const radius = centre * 0.86;

    ctx.save();
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.clip();

    const lit = ctx.createRadialGradient(
        centre - radius * 0.42, centre - radius * 0.45, radius * 0.05,
        centre, centre, radius * 1.35,
    );
    const peak = moon ? 0.74 : 1;
    lit.addColorStop(0, `rgba(255,255,255,${peak})`);
    lit.addColorStop(0.45, `rgba(255,255,255,${peak * 0.62})`);
    lit.addColorStop(0.78, `rgba(255,255,255,${peak * 0.24})`);
    lit.addColorStop(1, "rgba(255,255,255,0.06)");
    ctx.fillStyle = lit;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // Rim light on the dark limb keeps the silhouette readable against the void.
    ctx.strokeStyle = `rgba(255,255,255,${moon ? 0.22 : 0.34})`;
    ctx.lineWidth = size * 0.016;
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.stroke();

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
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
    let texture: THREE.Texture;
    if (kind === "ring") texture = ringTexture(256);
    else if (kind === "planet") texture = bodyTexture(128, false);
    else if (kind === "moon") texture = bodyTexture(96, true);
    else texture = radialTexture(kind, kind === "nebula" ? 256 : 128);
    cache.set(kind, texture);
    return texture;
}

/** Normal-blended, so a planet occludes rather than adding light like a star. */
export function createBodySprite(kind: "planet" | "moon", color: string, scale: number): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getTexture(kind),
        transparent: true,
        depthWrite: false,
        color: new THREE.Color(color),
        opacity: kind === "moon" ? 0.9 : 1,
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
