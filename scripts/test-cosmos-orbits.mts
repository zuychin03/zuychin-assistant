import assert from "node:assert/strict";
import { test } from "node:test";
import {
    defaultOrbitSpacing, layoutMoonOrbits, layoutSystemOrbits,
    type OrbitSpacing, type PlanetOrbitSpec,
} from "../src/app/graph/cosmos/orbits.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function verify(sun: number, specs: readonly PlanetOrbitSpec[], spacing: Partial<OrbitSpacing> = {}) {
    const gaps = { ...defaultOrbitSpacing(sun), ...spacing };
    const result = layoutSystemOrbits(sun, specs, spacing);
    assert.equal(result.planets.length, specs.length);
    let previousOuter = sun;
    for (let index = 0; index < specs.length; index++) {
        const spec = specs[index], layout = result.planets[index];
        assert.equal(layout.moonOrbitRadii.length, spec.moonRadii.length);
        const inner = layout.orbitRadius - layout.envelopeRadius;
        close(inner - previousOuter, index === 0 ? gaps.innerGap : gaps.planetGap);
        assert.ok(inner > previousOuter);
        let moonOuter = Math.max(spec.bodyRadius, spec.ringOuterRadius ?? 0);
        for (let moon = 0; moon < spec.moonRadii.length; moon++) {
            const radius = layout.moonOrbitRadii[moon];
            close(radius - spec.moonRadii[moon] - moonOuter, gaps.moonGap);
            assert.ok(radius - spec.moonRadii[moon] > moonOuter);
            moonOuter = radius + spec.moonRadii[moon];
        }
        close(layout.envelopeRadius, moonOuter);
        previousOuter = layout.orbitRadius + layout.envelopeRadius;
        for (const value of [layout.orbitRadius, layout.envelopeRadius, ...layout.moonOrbitRadii]) {
            assert.ok(Number.isFinite(value) && value > 0);
        }
    }
    close(result.outerRadius, previousOuter);
    return result;
}

test("empty systems and moonless planets retain finite bounds", () => {
    assert.deepEqual(layoutSystemOrbits(40, []), { planets: [], outerRadius: 40 });
    assert.deepEqual(layoutMoonOrbits(12, [], 3), { orbitRadii: [], envelopeRadius: 12 });
    verify(40, [{ bodyRadius: 12, moonRadii: [] }]);
});

test("planet annuli clear the photosphere halo and each other", () => {
    verify(45, [
        { bodyRadius: 9, moonRadii: [] },
        { bodyRadius: 18, moonRadii: [3, 5, 2] },
        { bodyRadius: 11, moonRadii: [6] },
        { bodyRadius: 6, moonRadii: [] },
    ]);
});

test("large rings and every moon contribute to orbital clearance", () => {
    const result = verify(30, [
        { bodyRadius: 10, ringOuterRadius: 42, moonRadii: [4, 7, 2] },
        { bodyRadius: 12, ringOuterRadius: 50, moonRadii: [3, 8] },
    ], { innerGap: 20, planetGap: 15, moonGap: 4 });
    assert.deepEqual(result.planets[0].moonOrbitRadii, [50, 65, 78]);
    assert.equal(result.planets[0].envelopeRadius, 80);
    assert.equal(result.planets[0].orbitRadius, 130);
});

test("all section counts through 100 preserve every body with disjoint envelopes", () => {
    for (let count = 0; count <= 100; count++) {
        const specs = Array.from({ length: count }, (_, index) => ({
            bodyRadius: 4 + index % 13,
            ringOuterRadius: index % 4 === 0 ? 30 + index % 19 : undefined,
            moonRadii: Array.from({ length: index % 11 }, (_, moon) => 1.5 + (index + moon) % 7),
        }));
        verify(40, specs);
    }
    verify(40, [{ bodyRadius: 14, ringOuterRadius: 45, moonRadii: Array.from({ length: 100 }, (_, index) => 2 + index % 5) }]);
});

test("system layout scales uniformly and never mutates the input", () => {
    const specs = Object.freeze([
        Object.freeze({ bodyRadius: 12, ringOuterRadius: 35, moonRadii: Object.freeze([4, 6]) }),
        Object.freeze({ bodyRadius: 8, moonRadii: Object.freeze([2]) }),
    ]);
    const original = verify(40, specs);
    const multiplier = 2.75;
    const scaled = verify(40 * multiplier, specs.map((spec) => ({
        bodyRadius: spec.bodyRadius * multiplier,
        ringOuterRadius: "ringOuterRadius" in spec ? spec.ringOuterRadius * multiplier : undefined,
        moonRadii: spec.moonRadii.map((radius) => radius * multiplier),
    })));
    close(scaled.outerRadius, original.outerRadius * multiplier);
    original.planets.forEach((planet, index) => {
        close(scaled.planets[index].orbitRadius, planet.orbitRadius * multiplier);
        close(scaled.planets[index].envelopeRadius, planet.envelopeRadius * multiplier);
    });
});

test("adding moons enlarges clearance without changing earlier moon orbits", () => {
    const first = layoutMoonOrbits(20, [3, 5], 3);
    const next = layoutMoonOrbits(20, [3, 5, 8, 2], 3);
    assert.deepEqual(next.orbitRadii.slice(0, 2), first.orbitRadii);
    assert.ok(next.envelopeRadius > first.envelopeRadius);
    const fewer = layoutSystemOrbits(40, [{ bodyRadius: 12, moonRadii: [] }, { bodyRadius: 15, moonRadii: [] }]);
    const more = layoutSystemOrbits(40, [{ bodyRadius: 12, moonRadii: [3, 5, 8] }, { bodyRadius: 15, moonRadii: [] }]);
    assert.ok(more.planets[1].orbitRadius > fewer.planets[1].orbitRadius);
});

test("invalid radii, spacing and overflowing extents fail before producing geometry", () => {
    const planet = { bodyRadius: 10, moonRadii: [3] };
    for (const radius of [0, -1, NaN, Infinity]) {
        assert.throws(() => layoutSystemOrbits(radius, [planet]), RangeError);
        assert.throws(() => layoutSystemOrbits(40, [{ ...planet, bodyRadius: radius }]), RangeError);
        assert.throws(() => layoutSystemOrbits(40, [{ ...planet, moonRadii: [radius] }]), RangeError);
        for (const key of ["innerGap", "planetGap", "moonGap"] as const) {
            assert.throws(() => layoutSystemOrbits(40, [planet], { [key]: radius }), RangeError);
        }
    }
    for (const ringOuterRadius of [-1, NaN, Infinity]) {
        assert.throws(() => layoutSystemOrbits(40, [{ ...planet, ringOuterRadius }]), RangeError);
    }
    assert.throws(() => layoutSystemOrbits(1e308, [{ bodyRadius: 1e308, moonRadii: [] }]), RangeError);
});
