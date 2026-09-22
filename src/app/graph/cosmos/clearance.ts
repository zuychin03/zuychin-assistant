export interface ClearanceNode {
    id: string;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
}

export interface SystemClearance {
    rootId: string;
    radius: number;
}

function fixed(node: ClearanceNode): boolean {
    return node.fx != null || node.fy != null || node.fz != null;
}

function positioned(node: ClearanceNode): node is ClearanceNode & { x: number; y: number; z: number } {
    return Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z);
}

function velocity(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) ? value : 0;
}

function fallbackDirection(id: string): [number, number, number] {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    const angle = ((hash >>> 0) / 4294967296) * Math.PI * 2;
    const vertical = (((Math.imul(hash, 1664525) + 1013904223) >>> 0) / 4294967296) * 1.6 - 0.8;
    const horizontal = Math.sqrt(1 - vertical * vertical);
    return [Math.cos(angle) * horizontal, vertical, Math.sin(angle) * horizontal];
}

export function createSystemClearance<N extends ClearanceNode>(
    getSystem: () => SystemClearance | null,
    getBodyRadius: (node: N) => number = () => 0,
) {
    let nodes: N[] = [];

    function visit(callback: (node: N, root: N, direction: [number, number, number], distance: number, boundary: number) => void) {
        const system = getSystem();
        if (!system || !Number.isFinite(system.radius) || system.radius <= 0) return;
        const root = nodes.find((node) => node.id === system.rootId);
        if (!root || !positioned(root)) return;
        for (const node of nodes) {
            if (node === root || fixed(node) || !positioned(node)) continue;
            const x = node.x - root.x, y = node.y - root.y, z = node.z - root.z;
            const distance = Math.hypot(x, y, z);
            const direction: [number, number, number] = distance > 0.0001
                ? [x / distance, y / distance, z / distance]
                : fallbackDirection(node.id);
            const bodyRadius = getBodyRadius(node);
            callback(node, root, direction, distance, system.radius + (Number.isFinite(bodyRadius) ? Math.max(0, bodyRadius) : 0));
        }
    }

    const force = (alpha: number) => {
        visit((node, _root, direction, distance, boundary) => {
            const buffer = Math.max(20, boundary * 0.15);
            const penetration = boundary + buffer - distance;
            if (penetration <= 0) return;
            const impulse = Math.min(24, penetration * 0.24) * Math.max(0.12, Math.min(1, velocity(alpha)));
            node.vx = velocity(node.vx) + direction[0] * impulse;
            node.vy = velocity(node.vy) + direction[1] * impulse;
            node.vz = velocity(node.vz) + direction[2] * impulse;
        });
    };

    force.initialize = (input: N[]) => { nodes = input; };
    // Run after integration: link and centre forces are not distance constraints.
    force.constrain = () => {
        visit((node, root, direction, distance, boundary) => {
            if (distance > boundary) return;
            node.x = root.x! + direction[0] * boundary;
            node.y = root.y! + direction[1] * boundary;
            node.z = root.z! + direction[2] * boundary;
            const radialVelocity = (velocity(node.vx) - velocity(root.vx)) * direction[0]
                + (velocity(node.vy) - velocity(root.vy)) * direction[1]
                + (velocity(node.vz) - velocity(root.vz)) * direction[2];
            if (radialVelocity >= 0) return;
            node.vx = velocity(node.vx) - radialVelocity * direction[0];
            node.vy = velocity(node.vy) - radialVelocity * direction[1];
            node.vz = velocity(node.vz) - radialVelocity * direction[2];
        });
    };
    return force;
}
