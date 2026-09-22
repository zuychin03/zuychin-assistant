export interface PlanetOrbitSpec {
    bodyRadius: number;
    ringOuterRadius?: number;
    moonRadii: readonly number[];
}

export interface OrbitSpacing {
    innerGap: number;
    planetGap: number;
    moonGap: number;
}

export interface MoonOrbitLayout {
    orbitRadii: number[];
    envelopeRadius: number;
}

export interface PlanetOrbitLayout {
    orbitRadius: number;
    envelopeRadius: number;
    moonOrbitRadii: number[];
}

export interface SystemOrbitLayout {
    planets: PlanetOrbitLayout[];
    outerRadius: number;
}

function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive.`);
    return value;
}

export function defaultOrbitSpacing(sunHaloRadius: number): OrbitSpacing {
    positive(sunHaloRadius, "Sun halo radius");
    return { innerGap: sunHaloRadius * 0.5, planetGap: sunHaloRadius * 0.32, moonGap: sunHaloRadius * 0.075 };
}

/** All radii include visible geometry and are measured in world units. */
export function layoutMoonOrbits(parentRadius: number, moonRadii: readonly number[], gap: number): MoonOrbitLayout {
    positive(parentRadius, "Parent radius");
    positive(gap, "Moon gap");
    let envelopeRadius = parentRadius;
    const orbitRadii = moonRadii.map((radius) => {
        positive(radius, "Moon radius");
        const orbitRadius = positive(envelopeRadius + gap + radius, "Moon orbit radius");
        envelopeRadius = positive(orbitRadius + radius, "Moon envelope radius");
        return orbitRadius;
    });
    return { orbitRadii, envelopeRadius };
}

export function layoutSystemOrbits(
    sunHaloRadius: number,
    planets: readonly PlanetOrbitSpec[],
    spacing: Partial<OrbitSpacing> = {},
): SystemOrbitLayout {
    const gaps = { ...defaultOrbitSpacing(sunHaloRadius), ...spacing };
    positive(gaps.innerGap, "Inner gap");
    positive(gaps.planetGap, "Planet gap");
    positive(gaps.moonGap, "Moon gap");
    let outerRadius = sunHaloRadius;
    const layouts = planets.map((planet, index) => {
        positive(planet.bodyRadius, "Planet radius");
        const ringRadius = planet.ringOuterRadius ?? 0;
        if (!Number.isFinite(ringRadius) || ringRadius < 0) throw new RangeError("Ring radius must be finite and non-negative.");
        const moons = layoutMoonOrbits(Math.max(planet.bodyRadius, ringRadius), planet.moonRadii, gaps.moonGap);
        const gap = index === 0 ? gaps.innerGap : gaps.planetGap;
        const orbitRadius = positive(outerRadius + gap + moons.envelopeRadius, "Planet orbit radius");
        outerRadius = positive(orbitRadius + moons.envelopeRadius, "System outer radius");
        return { orbitRadius, envelopeRadius: moons.envelopeRadius, moonOrbitRadii: moons.orbitRadii };
    });
    return { planets: layouts, outerRadius };
}
