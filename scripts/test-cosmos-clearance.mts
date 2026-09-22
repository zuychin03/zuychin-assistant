import assert from "node:assert/strict";
import { createSystemClearance, type ClearanceNode, type SystemClearance } from "../src/app/graph/cosmos/clearance.ts";

let spec: SystemClearance | null = { rootId: "root", radius: 100 };
const root: ClearanceNode = { id: "root", x: 10, y: 20, z: 30, fx: 10, fy: 20, fz: 30 };
const near: ClearanceNode = { id: "near", x: 20, y: 20, z: 30, vx: -5, vy: 3, vz: 2 };
const coincident: ClearanceNode = { id: "coincident", x: 10, y: 20, z: 30 };
const pinned: ClearanceNode = { id: "dragged", x: 15, y: 20, z: 30, fx: 15 };
const uninitialised: ClearanceNode = { id: "pending" };
const far: ClearanceNode = { id: "far", x: 500, y: 20, z: 30, vx: 1 };
const nodes = [root, near, coincident, pinned, uninitialised, far];
const originalRoot = { ...root }, originalPinned = { ...pinned }, originalFar = { ...far };
const force = createSystemClearance(() => spec, () => 10);
force.initialize(nodes);
force.constrain();
assert.deepEqual(root, originalRoot);
assert.deepEqual(pinned, originalPinned);
assert.deepEqual(far, originalFar);
assert.deepEqual(uninitialised, { id: "pending" });
assert.equal(near.x, 120);
assert.equal(near.vx, 0);
assert.equal(near.vy, 3);
assert.equal(near.vz, 2);
assert.ok(Math.abs(Math.hypot(coincident.x! - 10, coincident.y! - 20, coincident.z! - 30) - 110) < 1e-8);
const firstDirection = { x: coincident.x, y: coincident.y, z: coincident.z };
Object.assign(coincident, { x: 10, y: 20, z: 30 });
force.constrain();
assert.deepEqual({ x: coincident.x, y: coincident.y, z: coincident.z }, firstDirection);
spec = null;
near.x = 11;
force(1);
force.constrain();
assert.equal(near.x, 11);

// The installed force engine runs this hook before copying positions to meshes.
if (typeof window === "undefined") Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
const { default: ForceGraph } = await import("three-forcegraph");
const simulated: ClearanceNode[] = [
    { id: "root", x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 },
    { id: "a", x: 1, y: 0, z: 0 },
    { id: "b", x: 0, y: 1, z: 0 },
    { id: "c", x: 0, y: 0, z: 1 },
];
spec = { rootId: "root", radius: 120 };
const constraint = createSystemClearance<ClearanceNode>(() => spec, () => 12);
const graph = new ForceGraph<ClearanceNode>();
graph.d3Force("clearance", constraint);
graph.d3Force("link")?.distance(8).strength(1);
graph.d3Force("center")?.strength(0.9);
graph.d3Force("charge")?.strength(-1);
graph.onEngineTick(() => constraint.constrain());
graph.graphData({ nodes: simulated, links: simulated.slice(1).map((node) => ({ source: "root", target: node.id })) });
await new Promise((resolve) => setTimeout(resolve, 30));
for (let tick = 0; tick < 180; tick++) {
    graph.tickFrame();
    for (const node of simulated.slice(1)) assert.ok(Math.hypot(node.x!, node.y!, node.z!) >= 132 - 1e-7);
    assert.deepEqual([simulated[0].x, simulated[0].y, simulated[0].z], [0, 0, 0]);
}
spec = null;
graph.d3ReheatSimulation();
for (let tick = 0; tick < 90; tick++) graph.tickFrame();
assert.ok(simulated.slice(1).some((node) => Math.hypot(node.x!, node.y!, node.z!) < 120));
console.log("Cosmos clearance: root and drag pins preserved, coincident/invalid nodes safe, inward velocity removed, 180 actual engine ticks resist short links and centre pull, exit releases constraint.");
