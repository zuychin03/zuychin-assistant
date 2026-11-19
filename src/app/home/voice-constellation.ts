// The voice stage's star chart: a slowly turning field of stars around a red core. Phase changes and
// loudness ease every value toward a target, so the field never jumps between states.

export type VoicePhase = "idle" | "listening" | "transcribing" | "thinking" | "tools" | "speaking";

type Rgb = readonly [number, number, number];
export type ConstellationPalette = { ink: Rgb; accent: Rgb; dark: boolean };

const TAU = Math.PI * 2;
const MIN_STARS = 22;
const MAX_STARS = 64;
const TILT = 0.3;
const PERSPECTIVE = 0.12;
// Furthest a star sits from the screen plane after the tilt.
const DEPTH_MAX = Math.sin(TILT) + Math.cos(TILT);
// Widest a rim star is drawn, as a share of the x radius: perspective enlarges the near side of the rim.
const EDGE_SCALE = (() => {
    let widest = 1;
    for (let z = 0; z <= 1; z += 0.01) widest = Math.max(widest, Math.sqrt(1 - z * z) / (1 - PERSPECTIVE * (Math.sin(TILT) + Math.cos(TILT) * z)));
    return widest;
})();
// Radians per second.
const SPIN: Record<VoicePhase, number> = { idle: 0.08, listening: 0.06, transcribing: 0.16, thinking: 0.3, tools: 0.2, speaking: 0.1 };

// radial: distance from the core on screen, in shares of the stage's width and height.
type Star = { x: number; y: number; z: number; size: number; sx: number; sy: number; depth: number; heat: number; mark: number; radial: number };
// Faint background specks across the whole stage; x and y are fractions of its size.
type Dust = { x: number; y: number; size: number; alpha: number; drift: number; phase: number };
const DUST_COUNT = 48;
type Link = { a: number; b: number; glow: number; hold: boolean };
// thought: thinking's train of thought. tool: a plotted route. burst: a tap.
type PulseKind = "thought" | "tool" | "burst";
type Pulse = { link: number; from: number; t: number; duration: number; kind: PulseKind };
// A tap's ripple.
type Ring = { origin: number; age: number; life: number; strength: number };
// Listening: a front that sweeps out from the core through every star and link at once.
type Wave = { age: number; strength: number };
const PULSE_SECONDS: Record<PulseKind, number> = { thought: 0.85, tool: 1.15, burst: 0.6 };
const WAVE_SECONDS = 1.25;
// The front reaches the stage's corners, in the same units as Star.radial.
const WAVE_REACH = 0.62;
const WAVE_WIDTH = 0.075;
const MAX_WAVES = 4;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Frame-rate independent share of the remaining distance to cover this frame.
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const smoothstep = (from: number, to: number, v: number) => {
    const t = clamp01((v - from) / (to - from));
    return t * t * (3 - 2 * t);
};
const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rgba = (c: Rgb, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp01(a).toFixed(3)})`;

// mulberry32: the same field on every visit.
function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let x = Math.imul(s ^ (s >>> 15), 1 | s);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

export function parseColour(value: string): Rgb | null {
    const v = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex) {
        const digits = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
        const n = parseInt(digits, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

// One soft glow per colour, drawn scaled: far cheaper than a gradient per star per frame.
function glowSprite(colour: Rgb): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, rgba(colour, 1));
        gradient.addColorStop(0.22, rgba(colour, 0.5));
        gradient.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
    }
    return canvas;
}

export class VoiceConstellation {
    // Every star the widest stage uses; narrower stages take a prefix, which is just as evenly spread.
    private readonly pool: Star[] = [];
    private readonly dust: Dust[] = [];
    private stars: Star[] = [];
    private links: Link[] = [];
    private adjacency: number[][] = [];
    private order: number[] = [];
    private laidOut = "";
    private readonly random = seeded(0x2f6b);
    private pulses: Pulse[] = [];
    private rings: Ring[] = [];
    private waves: Wave[] = [];
    private palette: ConstellationPalette | null = null;
    private hot: Rgb = [255, 255, 255];
    private sprites: { accent: HTMLCanvasElement; hot: HTMLCanvasElement } | null = null;
    private phase: VoicePhase = "idle";
    private width = 0;
    private height = 0;
    private time = 0;
    private spin = 0.6;
    private spinRate = SPIN.idle;
    private scale = 1;
    private flatten = 0;
    private level = 0;
    private onset = 0;
    private lastOnset = -1;
    // Speaking: the whole field swells and brightens in unison. beat jumps on each syllable and fades.
    private beat = 0;
    private throb = 0;
    private spawnWait = 0;
    private readonly pointer = { x: 0, y: 0, targetX: 0, targetY: 0, inside: false, presence: 0 };

    constructor() {
        const r = seeded(7);
        this.pool.push({ x: 0, y: 0, z: 0, size: 0, sx: 0, sy: 0, depth: 1, heat: 0, mark: 0, radial: 0 });
        // A thick disc about the turning axis, weighted toward its rim: seen side on, a uniform disc thins
        // out at both ends, while this spreads the stars evenly across a wide stage.
        while (this.pool.length <= MAX_STARS) {
            const angle = r() * TAU;
            const radius = 0.2 + 0.8 * Math.pow(r(), 0.55);
            this.pool.push({
                x: Math.cos(angle) * radius, y: r() * 2 - 1, z: Math.sin(angle) * radius,
                size: 0.65 + r() * 0.85, sx: 0, sy: 0, depth: 0.5, heat: 0, mark: 0, radial: 0,
            });
            // Unused draw, kept so the seeded field keeps its layout.
            r();
        }
        for (let i = 0; i < DUST_COUNT; i++) {
            this.dust.push({ x: r(), y: 0.08 + r() * 0.84, size: 0.35 + r() * 0.55, alpha: 0.1 + r() * 0.22, drift: 0.2 + r() * 0.8, phase: r() * TAU });
        }
    }

    // Star count follows the stage width, and links join stars that are near on screen. The field is
    // drawn stretched (rx >> ry), so the distance weighs x and z by that stretch; turning about y keeps
    // x^2 + z^2, so links stay short at every angle.
    private layout(w: number, h: number): void {
        const key = `${Math.round(w)}x${Math.round(h)}`;
        if (key === this.laidOut) return;
        this.laidOut = key;
        const count = Math.round(Math.min(MAX_STARS, Math.max(MIN_STARS, w / 12)));
        const stretch = Math.max(1, this.radiusX(w, h) / this.radiusY(h));
        this.stars = this.pool.slice(0, count + 1);
        this.links = [];
        this.adjacency = this.stars.map(() => []);
        this.order = this.stars.map((_, i) => i);
        this.pulses = [];
        this.rings = [];
        const seen = new Set<string>();
        const connect = (a: number, b: number) => {
            const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (seen.has(pair)) return;
            seen.add(pair);
            this.adjacency[a].push(this.links.length);
            this.adjacency[b].push(this.links.length);
            this.links.push({ a, b, glow: 0, hold: false });
        };
        const nearest = (i: number, n: number) => {
            const from = this.stars[i];
            return this.stars
                .map((s, j) => [j, ((s.x - from.x) ** 2 + (s.z - from.z) ** 2) * stretch * stretch + (s.y - from.y) ** 2] as const)
                .filter(([j]) => j !== i && j !== 0)
                .sort((p, q) => p[1] - q[1])
                .slice(0, n)
                .map(([j]) => j);
        };
        for (let i = 1; i < this.stars.length; i++) for (const j of nearest(i, 2)) connect(i, j);
        for (const j of nearest(0, 4)) connect(0, j);
    }

    private radiusX(w: number, h: number): number {
        return Math.max(0, w / 2 - h * 0.12) / EDGE_SCALE;
    }

    private radiusY(h: number): number {
        return h * 0.32;
    }

    setPalette(palette: ConstellationPalette): void {
        this.palette = palette;
        this.hot = mix(palette.accent, [255, 238, 232], palette.dark ? 0.5 : 0.3);
        this.sprites = { accent: glowSprite(palette.accent), hot: glowSprite(this.hot) };
    }

    setPointer(x: number, y: number): void {
        const p = this.pointer;
        if (!p.inside && p.presence < 0.05) {
            p.x = x;
            p.y = y;
        }
        p.targetX = x;
        p.targetY = y;
        p.inside = true;
    }

    clearPointer(): void {
        this.pointer.inside = false;
    }

    /** A burst from the star nearest the tap. */
    tap(x: number, y: number): void {
        if (!this.stars.length) return;
        let best = 0;
        let bestDistance = Infinity;
        this.stars.forEach((s, i) => {
            const d = (s.sx - x) ** 2 + (s.sy - y) ** 2;
            if (d < bestDistance) {
                bestDistance = d;
                best = i;
            }
        });
        this.stars[best].heat = 1;
        this.rings.push({ origin: best, age: 0, life: 1.1, strength: 0.8 });
        for (let i = 0; i < 3; i++) this.fire(best, "burst");
    }

    /** still: reduced motion, a settled frame per phase where only the core shows loudness. */
    update(dt: number, width: number, height: number, phase: VoicePhase, rawLevel: number, still: boolean): void {
        this.width = width;
        this.height = height;
        this.phase = phase;
        this.layout(width, height);
        const target = smoothstep(0.08, 0.9, rawLevel);
        this.level += (target - this.level) * approach(target > this.level ? 16 : 4.5, dt);
        if (still) {
            this.settle(phase);
            this.project();
            return;
        }
        this.time += dt;
        this.spinRate += (SPIN[phase] - this.spinRate) * approach(1.2, dt);
        this.spin += this.spinRate * dt;
        this.advanceOnsets(dt, phase);
        const throb = phase === "speaking" ? clamp01(0.45 * this.level + 0.75 * this.beat) : 0;
        this.throb += (throb - this.throb) * approach(throb > this.throb ? 22 : 7, dt);
        const gather = phase === "listening" ? 0.03 + 0.12 * this.level : phase === "speaking" ? -0.07 * this.throb : phase === "transcribing" ? 0.03 : 0;
        this.scale += (1 - gather - this.scale) * approach(phase === "speaking" ? 14 : 6, dt);
        this.flatten += ((phase === "transcribing" ? 1 : 0) - this.flatten) * approach(3.2, dt);

        const p = this.pointer;
        p.presence += ((p.inside ? 1 : 0) - p.presence) * approach(6, dt);
        p.x += (p.targetX - p.x) * approach(12, dt);
        p.y += (p.targetY - p.y) * approach(12, dt);

        this.project();
        this.advancePulses(dt, phase);
        for (const link of this.links) {
            link.glow *= Math.exp(-dt * (link.hold ? 0.7 : 2.2));
            if (link.glow < 0.01) {
                link.glow = 0;
                link.hold = false;
            }
        }
        for (const star of this.stars) {
            star.heat *= Math.exp(-dt * 1.5);
            star.mark = Math.max(0, star.mark - dt / 1.2);
        }
    }

    draw(ctx: CanvasRenderingContext2D): void {
        const { palette, sprites, width: w, height: h } = this;
        ctx.clearRect(0, 0, w, h);
        if (!palette || !sprites || w <= 0 || h <= 0 || !this.stars.length) return;
        const unit = Math.min(1.35, Math.max(0.8, h / 100));
        // Additive glow reads as light on the dark theme; on white it would vanish.
        const glowMode: GlobalCompositeOperation = palette.dark ? "lighter" : "source-over";
        const { level, throb } = this;
        const p = this.pointer;

        // Dust drifts with the field's turn, nearer specks faster, so the sky has depth.
        ctx.fillStyle = rgba(palette.ink, 1);
        for (const d of this.dust) {
            const x = (((d.x - this.spin * d.drift * 0.025) % 1) + 1) % 1;
            ctx.globalAlpha = d.alpha * (0.75 + 0.25 * Math.sin(this.time * 0.7 + d.phase) + throb * 0.9) * (palette.dark ? 1 : 0.8) * (1 - this.flatten * 0.5);
            ctx.beginPath();
            ctx.arc(x * w, d.y * h, d.size * unit, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        ctx.lineWidth = 0.8 * unit;
        for (const ring of this.rings) {
            const progress = ring.age / ring.life;
            const origin = this.stars[ring.origin];
            const radius = 4 * unit + h * 0.3 * (1 - (1 - progress) ** 3);
            ctx.strokeStyle = rgba(palette.accent, ring.strength * (1 - progress) ** 2 * (palette.dark ? 0.34 : 0.3));
            ctx.beginPath();
            ctx.arc(origin.sx, origin.sy, radius, 0, TAU);
            ctx.stroke();
        }

        const base = palette.dark ? 0.2 : 0.15;
        const listen = this.phase === "listening" ? level * 0.16 : 0;
        ctx.lineCap = "round";
        for (const link of this.links) {
            const a = this.stars[link.a];
            const b = this.stars[link.b];
            const depth = (a.depth + b.depth) / 2;
            const glow = Math.max(link.glow, this.waveAt((a.radial + b.radial) / 2));
            // Long links fade so the field reads as clusters rather than a mesh.
            const reach = 1 - 0.75 * smoothstep(h * 0.45, h * 1.3, Math.hypot(b.sx - a.sx, b.sy - a.sy));
            const alpha = (base * (0.35 + 0.65 * depth) + listen * depth + throb * 0.32 * (0.4 + 0.6 * depth)) * reach + glow * 0.55;
            ctx.strokeStyle = rgba(mix(palette.ink, palette.accent, Math.min(1, glow * 1.2 + throb * 0.6)), alpha * (1 - this.flatten * 0.55));
            ctx.lineWidth = (0.6 + glow * 0.7 + throb * 0.5) * unit;
            ctx.beginPath();
            ctx.moveTo(a.sx, a.sy);
            ctx.lineTo(b.sx, b.sy);
            ctx.stroke();
        }

        for (const pulse of this.pulses) {
            const link = this.links[pulse.link];
            const from = this.stars[pulse.from];
            const to = this.stars[link.a === pulse.from ? link.b : link.a];
            const head = easeInOut(pulse.t);
            const tail = easeInOut(pulse.t - 0.32);
            const hx = from.sx + (to.sx - from.sx) * head;
            const hy = from.sy + (to.sy - from.sy) * head;
            const tx = from.sx + (to.sx - from.sx) * tail;
            const ty = from.sy + (to.sy - from.sy) * tail;
            const thought = pulse.kind === "thought";
            const colour = thought ? this.hot : palette.accent;
            const strength = thought ? 0.75 : 1;
            const trail = ctx.createLinearGradient(tx, ty, hx, hy);
            trail.addColorStop(0, rgba(colour, 0));
            trail.addColorStop(1, rgba(colour, strength));
            ctx.strokeStyle = trail;
            ctx.lineWidth = 1.5 * unit;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            const size = (thought ? 12 : 16) * unit;
            ctx.globalCompositeOperation = glowMode;
            ctx.globalAlpha = strength * 0.9;
            ctx.drawImage(thought ? sprites.hot : sprites.accent, hx - size / 2, hy - size / 2, size, size);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
        }

        this.order.sort((a, b) => this.stars[a].depth - this.stars[b].depth);
        for (const i of this.order) {
            if (i === 0) continue;
            const s = this.stars[i];
            const near = this.phase === "listening" ? level * (1 - Math.min(1, Math.hypot(s.x, s.y, s.z))) : 0;
            const heat = Math.max(s.heat, s.mark * 0.8, this.waveAt(s.radial));
            const radius = s.size * unit * (0.7 + 0.65 * s.depth) * (1 + heat * 0.6 + throb * 0.55 + near * 0.6);
            const halo = heat * 0.55 + throb * 0.4;
            if (halo > 0.06) {
                const size = radius * 8;
                ctx.globalCompositeOperation = glowMode;
                ctx.globalAlpha = clamp01(halo * (palette.dark ? 1 : 0.7));
                ctx.drawImage(sprites.accent, s.sx - size / 2, s.sy - size / 2, size, size);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "source-over";
            }
            ctx.fillStyle = rgba(mix(palette.ink, palette.accent, Math.max(heat, throb * 0.55)), 0.3 + 0.62 * s.depth + heat * 0.4 + throb * 0.3 + near * 0.3);
            ctx.beginPath();
            ctx.arc(s.sx, s.sy, radius, 0, TAU);
            ctx.fill();
            if (s.mark > 0.01) {
                ctx.strokeStyle = rgba(palette.accent, s.mark * 0.55);
                ctx.lineWidth = 0.8 * unit;
                ctx.beginPath();
                ctx.arc(s.sx, s.sy, radius + (2 + (1 - s.mark) * 7) * unit, 0, TAU);
                ctx.stroke();
            }
        }

        const core = this.stars[0];
        const breath = this.phase === "thinking" ? 0.06 * Math.sin(this.time * 2.6) : 0;
        const coreRadius = 3 * unit * (1 + level * 0.5 + throb * 0.35 + breath);
        const haloSize = (26 + 30 * level + 34 * throb) * unit * (1 + breath);
        ctx.globalCompositeOperation = glowMode;
        ctx.globalAlpha = clamp01((palette.dark ? 0.55 : 0.35) + level * 0.35);
        ctx.drawImage(sprites.accent, core.sx - haloSize / 2, core.sy - haloSize / 2, haloSize, haloSize);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = rgba(palette.accent, 1);
        ctx.beginPath();
        ctx.arc(core.sx, core.sy, coreRadius, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba(this.hot, 0.95);
        ctx.beginPath();
        ctx.arc(core.sx, core.sy, coreRadius * 0.45, 0, TAU);
        ctx.fill();

        if (p.presence > 0.02) {
            const reach = h * 0.9;
            const near = this.stars
                .map((s) => [s, Math.hypot(s.sx - p.x, s.sy - p.y)] as const)
                .sort((a, b) => a[1] - b[1])
                .slice(0, 2);
            ctx.setLineDash([2 * unit, 3 * unit]);
            ctx.lineWidth = 0.8 * unit;
            for (const [s, d] of near) {
                if (d > reach) continue;
                ctx.strokeStyle = rgba(palette.accent, 0.45 * p.presence * (1 - d / reach));
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(s.sx, s.sy);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.fillStyle = rgba(palette.accent, 0.55 * p.presence);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.6 * unit, 0, TAU);
            ctx.fill();
        }
    }

    private settle(phase: VoicePhase): void {
        this.pulses = [];
        this.rings = [];
        this.waves = [];
        this.beat = 0;
        this.throb = 0;
        this.scale = 1;
        this.flatten = phase === "transcribing" ? 1 : 0;
        this.pointer.presence = 0;
        for (const star of this.stars) {
            star.heat = 0;
            star.mark = 0;
        }
        // A still hint of the work: the core's links lit, brighter for tools.
        const lit = phase === "tools" ? 0.9 : phase === "thinking" ? 0.4 : 0;
        for (const link of this.links) link.glow = link.a === 0 ? lit : 0;
    }

    private project(): void {
        const { width: w, height: h, pointer: p } = this;
        const cx = w / 2;
        const cy = h / 2;
        const rx = this.radiusX(w, h) * this.scale;
        const ry = this.radiusY(h) * this.scale;
        const ca = Math.cos(this.spin);
        const sa = Math.sin(this.spin);
        const ct = Math.cos(TILT);
        const st = Math.sin(TILT);
        const breathe = 1 + 0.012 * Math.sin(this.time * 1.1);
        const reach = h * 0.7;
        for (const s of this.stars) {
            const x1 = s.x * ca + s.z * sa;
            const z1 = s.z * ca - s.x * sa;
            const y2 = s.y * ct - z1 * st;
            const z2 = s.y * st + z1 * ct;
            const perspective = 1 / (1 + z2 * PERSPECTIVE);
            let sx = cx + x1 * rx * perspective * breathe;
            let sy = cy + y2 * ry * perspective * breathe;
            // Transcribing lays the field along one shimmering line, like text being set.
            const line = cy + Math.sin(x1 * 5.5 - this.time * 4.2) * h * 0.05;
            sy += (line - sy) * this.flatten;
            s.depth = clamp01(0.5 - z2 / (2 * DEPTH_MAX)) * (1 - this.flatten) + 0.75 * this.flatten;
            if (p.presence > 0.01) {
                const dx = p.x - sx;
                const dy = p.y - sy;
                const pull = p.presence * smoothstep(reach, 0, Math.hypot(dx, dy)) * 0.18;
                sx += dx * pull;
                sy += dy * pull;
            }
            s.sx = sx;
            s.sy = sy;
        }
        const core = this.stars[0];
        for (const s of this.stars) s.radial = Math.hypot((s.sx - core.sx) / Math.max(1, w), (s.sy - core.sy) / Math.max(1, h));
    }

    private fire(from: number, kind: PulseKind, avoid = -1): void {
        const onward = this.adjacency[from].filter((l) => l !== avoid);
        const pool = onward.length ? onward : this.adjacency[from];
        if (!pool.length) return;
        const link = pool[Math.floor(this.random() * pool.length)];
        this.pulses.push({ link, from, t: 0, duration: PULSE_SECONDS[kind], kind });
    }

    /** How strongly the listening waves light a point this far from the core, 0 to 1. */
    private waveAt(radial: number): number {
        let light = 0;
        for (const wave of this.waves) {
            const progress = wave.age / WAVE_SECONDS;
            const front = WAVE_REACH * (1 - (1 - progress) ** 3);
            const fade = (1 - progress) ** 1.3;
            light += wave.strength * fade * Math.exp(-(((radial - front) / WAVE_WIDTH) ** 2));
        }
        return Math.min(1, light);
    }

    private advancePulses(dt: number, phase: VoicePhase): void {
        const want = phase === "thinking" ? Math.max(2, Math.round(this.stars.length / 14)) : phase === "tools" ? Math.max(2, Math.round(this.stars.length / 24)) : 0;
        const kind: PulseKind = phase === "tools" ? "tool" : "thought";
        const working = () => this.pulses.filter((pulse) => pulse.kind === "thought" || pulse.kind === "tool").length;
        this.spawnWait -= dt;
        if (working() < want && this.spawnWait <= 0) {
            this.fire(this.random() < 0.35 ? 0 : 1 + Math.floor(this.random() * (this.stars.length - 1)), kind);
            this.spawnWait = 0.35;
        }
        for (let i = this.pulses.length - 1; i >= 0; i--) {
            const pulse = this.pulses[i];
            pulse.t += dt / pulse.duration;
            const link = this.links[pulse.link];
            link.glow = Math.max(link.glow, (pulse.kind === "thought" ? 0.45 : 0.9) * easeInOut(pulse.t * 1.4));
            if (pulse.kind === "tool") link.hold = true;
            if (pulse.t < 1) continue;
            const to = link.a === pulse.from ? link.b : link.a;
            this.stars[to].heat = Math.max(this.stars[to].heat, pulse.kind === "thought" ? 0.7 : 1);
            if (pulse.kind === "tool") this.stars[to].mark = 1;
            this.pulses.splice(i, 1);
            // Thoughts hop on from where they land, so thinking reads as one train of thought.
            if (pulse.kind === kind && working() < want) this.fire(to, kind, pulse.link);
        }
    }

    private advanceOnsets(dt: number, phase: VoicePhase): void {
        this.onset += (this.level - this.onset) * approach(3, dt);
        this.beat *= Math.exp(-dt * 4.5);
        // A syllable onset: loudness rising quickly above its recent average. Listening sends a wave out
        // through the whole field; speaking makes the whole field beat at once.
        const onset = this.level > 0.22 && this.level - this.onset > 0.1 && this.time - this.lastOnset > 0.22;
        if (onset && phase === "listening" && this.waves.length < MAX_WAVES) {
            this.waves.push({ age: 0, strength: 0.55 + 0.45 * this.level });
            this.lastOnset = this.time;
        } else if (onset && phase === "speaking") {
            this.beat = Math.max(this.beat, 0.55 + 0.45 * this.level);
            this.lastOnset = this.time;
        }
        for (let i = this.rings.length - 1; i >= 0; i--) {
            this.rings[i].age += dt;
            if (this.rings[i].age >= this.rings[i].life) this.rings.splice(i, 1);
        }
        for (let i = this.waves.length - 1; i >= 0; i--) {
            this.waves[i].age += dt;
            if (this.waves[i].age >= WAVE_SECONDS) this.waves.splice(i, 1);
        }
    }
}
