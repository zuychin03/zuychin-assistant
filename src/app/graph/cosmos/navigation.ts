export interface Point3 { x: number; y: number; z: number; }

export function cameraStandOff(position: Point3, target: Point3, destination: Point3, distance: number): Point3 {
    let x = position.x - target.x;
    let y = position.y - target.y;
    let z = position.z - target.z;
    const length = Math.hypot(x, y, z);
    if (length < 0.001) { x = 0; y = 0.3; z = 1; }
    const scale = distance / Math.hypot(x, y, z);
    return { x: destination.x + x * scale, y: destination.y + y * scale, z: destination.z + z * scale };
}

export function systemFrameDistance(radius: number, verticalFov: number, aspect: number): number {
    const halfVertical = verticalFov * Math.PI / 360;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.1, aspect));
    return radius * 1.18 / Math.sin(Math.min(halfVertical, halfHorizontal));
}

export function resizeSystemView(position: Point3, target: Point3, verticalFov: number, previousAspect: number, nextAspect: number): Point3 {
    const ratio = systemFrameDistance(1, verticalFov, nextAspect) / systemFrameDistance(1, verticalFov, previousAspect);
    return {
        x: target.x + (position.x - target.x) * ratio,
        y: target.y + (position.y - target.y) * ratio,
        z: target.z + (position.z - target.z) * ratio,
    };
}

export function orbitalDelta(now: number, previous: number | null): number {
    return previous === null ? 0 : Math.max(0, Math.min((now - previous) / 1000, 0.05));
}

export interface PointerSample { pointerId: number; clientX: number; clientY: number; }

export class BodyGesture {
    private down: PointerSample | null = null;
    private moved = false;

    begin(point: PointerSample): void {
        if (this.down) { this.moved = true; return; }
        this.down = { pointerId: point.pointerId, clientX: point.clientX, clientY: point.clientY };
        this.moved = false;
    }

    move(point: PointerSample): void {
        if (!this.down || point.pointerId !== this.down.pointerId) return;
        if (Math.hypot(point.clientX - this.down.clientX, point.clientY - this.down.clientY) > 4) this.moved = true;
    }

    finish(point: PointerSample): "click" | "drag" | null {
        if (!this.down || point.pointerId !== this.down.pointerId) return null;
        this.move(point);
        const result = this.moved ? "drag" : "click";
        this.cancel();
        return result;
    }

    cancel(): void { this.down = null; this.moved = false; }
}
