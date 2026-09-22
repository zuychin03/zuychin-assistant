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
    const ringed = (type === "banded" || type === "icy") && chars > 400 && (hash >>> 16) % 5 < 2;
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

const ATMOSPHERE: Partial<Record<BodyType, string>> = {
    terran: "#86b7ec", icy: "#b7d2df", banded: "#d9bc95", molten: "#cb703c",
};

export function createAtmosphere(type: BodyType, scale: number, sunPosition: THREE.Vector3): THREE.Mesh | null {
    const color = ATMOSPHERE[type];
    if (!color) return null;
    const material = new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(color) }, sunPosition: { value: sunPosition } },
        vertexShader: `
            varying vec3 worldPosition;
            varying vec3 worldNormal;
            void main() {
                vec4 world = modelMatrix * vec4(position, 1.0);
                worldPosition = world.xyz;
                worldNormal = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * viewMatrix * world;
            }
        `,
        fragmentShader: `
            uniform vec3 tint;
            uniform vec3 sunPosition;
            varying vec3 worldPosition;
            varying vec3 worldNormal;
            void main() {
                vec3 normal = normalize(worldNormal);
                float rim = pow(1.0 - abs(dot(normal, normalize(cameraPosition - worldPosition))), 2.5);
                float sunAngle = dot(normal, normalize(sunPosition - worldPosition));
                float daylight = smoothstep(-0.22, 0.55, sunAngle);
                float twilight = exp(-pow(sunAngle * 6.0, 2.0));
                vec3 scattering = mix(tint, vec3(0.68, 0.31, 0.11), twilight * 0.32);
                gl_FragColor = vec4(scattering, rim * (0.018 + daylight * 0.48));
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
    });
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(0.474, 48, 32), material);
    atmosphere.scale.setScalar(scale);
    return atmosphere;
}

function interpolate(a: number, b: number, amount: number): number {
    return a + (b - a) * amount;
}

function smoothstep(low: number, high: number, value: number): number {
    const amount = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return amount * amount * (3 - 2 * amount);
}

function lattice(x: number, y: number, z: number, seed: number): number {
    let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function noise3(x: number, y: number, z: number, seed: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const tx = smoothstep(0, 1, x - ix), ty = smoothstep(0, 1, y - iy), tz = smoothstep(0, 1, z - iz);
    return interpolate(
        interpolate(interpolate(lattice(ix, iy, iz, seed), lattice(ix + 1, iy, iz, seed), tx), interpolate(lattice(ix, iy + 1, iz, seed), lattice(ix + 1, iy + 1, iz, seed), tx), ty),
        interpolate(interpolate(lattice(ix, iy, iz + 1, seed), lattice(ix + 1, iy, iz + 1, seed), tx), interpolate(lattice(ix, iy + 1, iz + 1, seed), lattice(ix + 1, iy + 1, iz + 1, seed), tx), ty), tz,
    );
}

function terrainNoise(x: number, y: number, z: number, seed: number): number {
    let sum = 0, amplitude = 0.57;
    for (let octave = 0; octave < 4; octave++) {
        sum += noise3(x, y, z, seed + octave * 97) * amplitude;
        x *= 2.05; y *= 2.05; z *= 2.05; amplitude *= 0.5;
    }
    return sum;
}

type RGB = readonly [number, number, number];
function rgb(hex: string): RGB {
    return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

interface BodyTextures {
    color: THREE.Texture;
    bump: THREE.Texture;
    roughness: THREE.Texture;
    clouds?: THREE.Texture;
    emission?: THREE.Texture;
}

const GAS_PALETTES = [
    ["#755744", "#bd9773", "#e7d8b8", "#a96c4f"],
    ["#526b79", "#8aa6b2", "#d5dfdd", "#7696a6"],
    ["#948071", "#c7b99a", "#f0e8d0", "#af916e"],
].map((palette) => palette.map(rgb));

// Sampling spherical coordinates keeps terrain, clouds and bump detail seamless.
function bodyTextures(type: BodyType | "moon", variant: number): BodyTextures {
    const key = `body:${type}:${variant}`;
    const existing = cache.get(key), existingBump = cache.get(`${key}:bump`), existingRoughness = cache.get(`${key}:roughness`);
    if (existing && existingBump && existingRoughness) {
        return { color: existing, bump: existingBump, roughness: existingRoughness, clouds: cache.get(`${key}:clouds`), emission: cache.get(`${key}:emission`) };
    }
    const width = type === "moon" ? 256 : 512, height = width / 2;
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(width, height), bumps = ctx.createImageData(width, height), roughnessPixels = ctx.createImageData(width, height);
    const clouds = type === "terran" ? ctx.createImageData(width, height) : null;
    const emission = type === "molten" ? ctx.createImageData(width, height) : null;
    const skin = type === "moon" ? { base: "#b5aea2", shade: "#6c6964", detail: "#89857d", accent: "#e0d9ca" } : SURFACE[type];
    const base = rgb(skin.base), shade = rgb(skin.shade), detail = rgb(skin.detail), accent = rgb(skin.accent);
    const deepOcean = rgb("#092941"), shelf = rgb("#387d8a"), forest = rgb("#415b3d"), grass = rgb("#87946a"), desert = rgb("#b1a07d"), snow = rgb("#e0e9e4");
    const seed = hashString(key), random = mulberry32(seed);
    const seaLevel = 0.54 + variant * 0.007;
    const stormLongitude = random() * Math.PI * 2, stormLatitude = (random() - 0.5) * 0.8;
    const craters = Array.from({ length: type === "moon" ? 64 : type === "rocky" ? 36 : 0 }, () => {
        const longitude = random() * Math.PI * 2, cy = random() * 2 - 1;
        const horizontal = Math.sqrt(1 - cy * cy), radius = 0.024 + Math.pow(random(), 2) * 0.19;
        return { x: Math.cos(longitude) * horizontal, y: cy, z: Math.sin(longitude) * horizontal, radius, outer: radius * radius * 1.7 };
    });
    const cosLongitude = new Float64Array(width), sinLongitude = new Float64Array(width);
    for (let px = 0; px < width; px++) {
        const longitude = px / (width - 1) * Math.PI * 2;
        cosLongitude[px] = Math.cos(longitude); sinLongitude[px] = Math.sin(longitude);
    }
    for (let py = 0; py < height; py++) {
        const latitude = (py / (height - 1) - 0.5) * Math.PI;
        const y = Math.sin(latitude), horizontal = Math.cos(latitude);
        for (let px = 0; px < width; px++) {
            const longitude = px / (width - 1) * Math.PI * 2;
            const x = horizontal * cosLongitude[px], z = horizontal * sinLongitude[px];
            const broad = terrainNoise(x * 1.8, y * 1.8, z * 1.8, seed);
            const terrain = terrainNoise(x * 6.2, y * 6.2, z * 6.2, seed + 173);
            const fine = noise3(x * 73, y * 73, z * 73, seed);
            let low: RGB = shade, high: RGB = base, mix = Math.max(0, Math.min(1, broad * 0.9 + terrain * 0.75 - 0.2));
            let relief = 0.35 + terrain * 0.25 + fine * 0.04;
            let roughness = 0.91, cloudAlpha = 0, ember = 0;
            if (type === "terran") {
                const elevation = broad * 0.8 + terrain * 0.2;
                const coast = smoothstep(seaLevel - 0.009, seaLevel + 0.014, elevation);
                const inland = smoothstep(seaLevel, seaLevel + 0.11, elevation);
                const aridity = terrainNoise(x * 3 + 9, y * 3, z * 3, seed + 57);
                const dry = smoothstep(0.43, 0.64, aridity + Math.cos(latitude * 4) * 0.06);
                const ice = smoothstep(0.81, 0.96, Math.abs(y) + (terrain - 0.5) * 0.12);
                const mountain = smoothstep(0.69, 0.8, elevation + (1 - Math.abs(terrain * 2 - 1)) * 0.08);
                const oceanDepth = smoothstep(seaLevel - 0.15, seaLevel, elevation);
                const land: RGB = [
                    interpolate(interpolate(forest[0], grass[0], inland), desert[0], dry),
                    interpolate(interpolate(forest[1], grass[1], inland), desert[1], dry),
                    interpolate(interpolate(forest[2], grass[2], inland), desert[2], dry),
                ];
                low = [
                    interpolate(deepOcean[0], shelf[0], oceanDepth * 0.65),
                    interpolate(deepOcean[1], shelf[1], oceanDepth * 0.65),
                    interpolate(deepOcean[2], shelf[2], oceanDepth * 0.65),
                ];
                high = land;
                const frozen = Math.max(ice, mountain * coast * 0.65);
                low = [interpolate(low[0], snow[0], frozen), interpolate(low[1], snow[1], frozen), interpolate(low[2], snow[2], frozen)];
                high = [interpolate(high[0], snow[0], frozen), interpolate(high[1], snow[1], frozen), interpolate(high[2], snow[2], frozen)];
                mix = coast;
                roughness = interpolate(0.19, 0.95, coast);
                relief = 0.46 + coast * (0.04 + inland * 0.17 + terrain * 0.05);
                const wind = longitude + 0.22 * Math.sin(latitude * 9 + terrain * 4);
                const cloudNoise = terrainNoise(horizontal * Math.cos(wind) * 5.6 + 12, y * 7, horizontal * Math.sin(wind) * 5.6, seed + 601);
                cloudAlpha = smoothstep(0.53, 0.72, cloudNoise + fine * 0.06) * 0.94;
            } else if (type === "banded") {
                const gas = GAS_PALETTES[variant % GAS_PALETTES.length];
                const flow = latitude * 43 + (terrain - 0.5) * 2.9 + Math.sin(longitude * 3 + latitude * 11) * 0.22;
                const largeBand = Math.sin(flow * 0.51 + broad * 1.3);
                const thinBand = Math.sin(flow * 2.8 + terrain * 2);
                const belt = smoothstep(-0.75, 0.8, largeBand * 0.78 + thinBand * 0.17);
                low = gas[0]; high = gas[2]; mix = 0.2 + belt * 0.71 + (fine - 0.5) * 0.04;
                const dx = Math.atan2(Math.sin(longitude - stormLongitude), Math.cos(longitude - stormLongitude)) * Math.cos(stormLatitude);
                const dy = latitude - stormLatitude;
                const stormRadius = Math.hypot(dx / 0.25, dy / 0.115);
                if (stormRadius < 1.35) {
                    const spiral = Math.sin(Math.atan2(dy * 2.15, dx) * 2 + stormRadius * 12 + terrain * 2);
                    const stormBlend = (1 - smoothstep(0.65, 1.35, stormRadius)) * 0.75;
                    const background: RGB = [interpolate(low[0], high[0], mix), interpolate(low[1], high[1], mix), interpolate(low[2], high[2], mix)];
                    low = background; high = gas[3]; mix = stormBlend * (0.75 + spiral * 0.25);
                }
                roughness = 1;
                relief = 0.5 + thinBand * 0.005;
            } else if (type === "molten") {
                low = rgb("#292827"); high = rgb("#625548"); mix = broad * 0.45 + terrain * 0.25;
                const fault = Math.abs(terrain - 0.51 + (broad - 0.5) * 0.18);
                ember = (1 - smoothstep(0.003, 0.019, fault)) * smoothstep(0.34, 0.53, broad);
                if (ember > 0.05) { low = rgb("#8e361c"); high = rgb("#ffd08a"); mix = ember * 0.75; }
                relief = 0.35 + terrain * 0.26 - ember * 0.04;
            } else if (type === "icy") {
                const fracture = Math.abs(terrain - 0.5 + (broad - 0.5) * 0.2);
                low = detail; high = accent; mix = 0.48 + broad * 0.37 + fine * 0.03;
                if (fracture < 0.011) { low = shade; high = detail; mix = smoothstep(0, 0.011, fracture) * 0.85; }
                relief = 0.5 + terrain * 0.11 - (1 - smoothstep(0, 0.019, fracture)) * 0.08;
                roughness = 0.68 + terrain * 0.2;
            } else {
                const maria = 1 - smoothstep(0.4, 0.54, broad);
                mix = 0.49 + terrain * 0.48 - maria * 0.27 + (fine - 0.5) * 0.07;
                for (const crater of craters) {
                    const squared = Math.max(0, 2 * (1 - (x * crater.x + y * crater.y + z * crater.z)));
                    if (squared > crater.outer) continue;
                    const distance = Math.sqrt(squared) / crater.radius;
                    const basin = 1 - smoothstep(0.55, 1, distance);
                    const rim = Math.exp(-Math.pow((distance - 1.03) / 0.12, 2));
                    relief += rim * 0.095 - basin * 0.12;
                    mix += rim * 0.11 - basin * 0.13;
                }
            }
            const offset = (py * width + px) * 4;
            mix = Math.max(0, Math.min(1, mix));
            for (let channel = 0; channel < 3; channel++) {
                pixels.data[offset + channel] = interpolate(low[channel], high[channel], mix);
                bumps.data[offset + channel] = Math.max(0, Math.min(255, relief * 255));
                roughnessPixels.data[offset + channel] = roughness * 255;
                if (clouds) clouds.data[offset + channel] = channel === 2 ? 251 : 247;
                if (emission) emission.data[offset + channel] = ember * [255, 87, 14][channel];
            }
            pixels.data[offset + 3] = 255; bumps.data[offset + 3] = 255; roughnessPixels.data[offset + 3] = 255;
            if (clouds) clouds.data[offset + 3] = cloudAlpha * 255;
            if (emission) emission.data[offset + 3] = 255;
        }
    }
    const texture = (data: ImageData, suffix: string, color = false) => {
        const surface = canvas.cloneNode() as HTMLCanvasElement;
        surface.getContext("2d")!.putImageData(data, 0, 0);
        const map = new THREE.CanvasTexture(surface);
        map.wrapS = THREE.RepeatWrapping;
        map.anisotropy = 4;
        if (color) map.colorSpace = THREE.SRGBColorSpace;
        cache.set(`${key}${suffix}`, map);
        return map;
    };
    return {
        color: texture(pixels, "", true), bump: texture(bumps, ":bump"), roughness: texture(roughnessPixels, ":roughness"),
        clouds: clouds ? texture(clouds, ":clouds", true) : undefined,
        emission: emission ? texture(emission, ":emission", true) : undefined,
    };
}

export function createBodyMesh(type: BodyType | "moon", variant: number, scale: number): THREE.Mesh {
    const texture = bodyTextures(type, variant);
    const material = new THREE.MeshStandardMaterial({
        map: texture.color,
        bumpMap: texture.bump,
        bumpScale: type === "banded" ? 0.008 : type === "moon" ? 0.045 : 0.032,
        roughnessMap: texture.roughness,
        roughness: 1,
        metalness: 0,
        emissive: type === "molten" ? 0xffffff : 0x000000,
        emissiveMap: texture.emission ?? null,
        emissiveIntensity: 0.75,
    });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, type === "moon" ? 28 : 56, type === "moon" ? 20 : 36), material);
    body.scale.setScalar(scale);
    body.rotation.set(0.06 + variant * 0.12, variant * 2.1, variant * 0.08);
    if (texture.clouds) {
        const clouds = new THREE.Mesh(new THREE.SphereGeometry(0.456, 48, 32), new THREE.MeshStandardMaterial({
            map: texture.clouds, transparent: true, depthWrite: false, roughness: 1, metalness: 0,
            alphaTest: 0.015, opacity: 0.94,
        }));
        body.add(clouds);
    }
    return body;
}

function planetRingTexture(variant: number): THREE.Texture {
    const width = 1024;
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(width, 2);
    const tones = [rgb("#d1b997"), rgb("#bfcbd0"), rgb("#d9cfb7")];
    const tint = tones[variant % tones.length];
    const seed = hashString(`ring:${variant}`);
    for (let x = 0; x < width; x++) {
        const radius = x / (width - 1);
        const fine = noise3(radius * 180, 0, 0, seed);
        const strand = Math.sin(radius * 940 + fine * 2) * 0.5 + 0.5;
        const broad = noise3(radius * 16, 0, 0, seed + 71);
        let opacity = (0.24 + broad * 0.46 + strand * 0.17) * smoothstep(0, 0.035, radius) * (1 - smoothstep(0.94, 1, radius));
        if (radius < 0.2) opacity *= 0.36;
        if (radius > 0.585 && radius < 0.635) opacity *= 0.035;
        if (Math.abs(radius - 0.845) < 0.006) opacity *= 0.12;
        const brightness = 0.65 + broad * 0.25 + strand * 0.1;
        for (let y = 0; y < 2; y++) {
            const offset = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = tint[channel] * brightness;
            pixels.data[offset + 3] = opacity * 255;
        }
    }
    ctx.putImageData(pixels, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
}

export function createPlanetRing(planetScale: number, variant: number): THREE.Mesh {
    const inner = planetScale * 0.67, outer = planetScale * 1.42;
    const geometry = new THREE.RingGeometry(inner, outer, 112);
    const position = geometry.getAttribute("position"), uv = geometry.getAttribute("uv");
    for (let index = 0; index < position.count; index++) {
        uv.setXY(index, (Math.hypot(position.getX(index), position.getY(index)) - inner) / (outer - inner), 0.5);
    }
    const key = `planet-ring:${variant}`;
    let texture = cache.get(key);
    if (!texture) { texture = planetRingTexture(variant); cache.set(key, texture); }
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        map: texture, roughness: 0.96, transparent: true, side: THREE.DoubleSide,
        depthWrite: false, opacity: 0.95,
    }));
}

function ringTexture(size: number): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const centre = size / 2;

    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = size * 0.006;
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
export const CORE_OVERDRIVE = 2.4;

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
        opacity: 0.4,
    }));
    sprite.visible = false;
    return sprite;
}

function starPointTexture(): THREE.Texture {
    const key = "background-point";
    const existing = cache.get(key);
    if (existing) return existing;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,255,255,0.98)");
    gradient.addColorStop(0.62, "rgba(255,255,255,0.38)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    cache.set(key, texture);
    return texture;
}

/** Three size bands keep distant stars varied without a per-point shader. */
export function createStarfield(count = 1250, radius = 2800): THREE.Group {
    const field = new THREE.Group();
    const random = mulberry32(987654321);
    const colors = [new THREE.Color("#c0cedb"), new THREE.Color("#d6c5ad"), new THREE.Color("#96abc4")];
    const bands = [
        { count: Math.floor(count * 0.78), size: 1.4, opacity: 0.62 },
        { count: Math.floor(count * 0.19), size: 2.1, opacity: 0.75 },
        { count: Math.ceil(count * 0.03), size: 3.2, opacity: 0.88 },
    ];
    for (const band of bands) {
        const positions = new Float32Array(band.count * 3), vertexColors = new Float32Array(band.count * 3);
        for (let i = 0; i < band.count; i++) {
            const theta = random() * Math.PI * 2, phi = Math.acos(2 * random() - 1);
            const distance = radius * (0.76 + random() * 0.24);
            positions.set([distance * Math.sin(phi) * Math.cos(theta), distance * Math.cos(phi), distance * Math.sin(phi) * Math.sin(theta)], i * 3);
            const color = colors[Math.floor(random() * colors.length)].clone().multiplyScalar(0.75 + random() * 0.25);
            vertexColors.set([color.r, color.g, color.b], i * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(vertexColors, 3));
        const material = new THREE.PointsMaterial({
            vertexColors: true, size: band.size, sizeAttenuation: false,
            transparent: true, opacity: band.opacity, depthWrite: false,
            map: starPointTexture(), blending: THREE.AdditiveBlending,
        });
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false;
        field.add(points);
    }
    return field;
}

export function disposeTextures(): void {
    for (const texture of cache.values()) texture.dispose();
    cache.clear();
}
