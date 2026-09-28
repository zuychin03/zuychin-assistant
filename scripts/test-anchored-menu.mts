import assert from "node:assert/strict";
import test from "node:test";
import { observeAnchoredMenu } from "../src/components/anchored-menu.ts";

function fixture(t: { after: (callback: () => void) => void }, initial: {
    width?: number; height?: number; left?: number; top?: number;
    menuWidth?: number; menuHeight?: number; scale?: number; visual?: boolean;
} = {}, options: Parameters<typeof observeAnchoredMenu>[2] = {}) {
    const state = { width: 320, height: 568, left: 220, top: 470, menuWidth: 650, menuHeight: 420, scale: .95, ...initial };
    const events = new Map<string, EventListener>();
    const viewportEvents = new Map<string, EventListener>();
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    let disconnected = false;
    let observed = 0;
    class TestNode {}
    const viewport = {
        width: state.width, height: state.height, offsetLeft: 0, offsetTop: 0,
        addEventListener: (name: string, handler: EventListener) => viewportEvents.set(name, handler),
        removeEventListener: (name: string) => viewportEvents.delete(name),
    };
    const globals: Record<string, unknown> = {
        Node: TestNode,
        window: {
            get innerHeight() { return state.height; },
            visualViewport: initial.visual ? viewport : null,
            addEventListener: (name: string, handler: EventListener) => events.set(name, handler),
            removeEventListener: (name: string) => events.delete(name),
        },
        document: { documentElement: { get clientWidth() { return state.width; } } },
        requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        ResizeObserver: class {
            observe() { observed++; }
            disconnect() { disconnected = true; }
        },
    };
    const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const restoreGlobals = () => {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    };
    const trigger = Object.assign(new TestNode(), {
        getBoundingClientRect: () => ({ left: state.left, right: state.left + 90, top: state.top, bottom: state.top + 44, width: 90, height: 44 }),
    });
    const menu = Object.assign(new TestNode(), {
        style: {} as Record<string, string>,
        contains: (node: unknown): boolean => node === menu,
    });
    Object.defineProperties(menu, {
        offsetWidth: { get: () => Math.max(Number.parseFloat(menu.style.minWidth) || 0, Math.min(state.menuWidth, Number.parseFloat(menu.style.maxWidth) || Infinity)) },
        offsetHeight: { get: () => Math.min(state.menuHeight, Number.parseFloat(menu.style.maxHeight) || Infinity) },
    });
    const element = menu as unknown as HTMLElement;
    element.getBoundingClientRect = () => ({
        width: element.offsetWidth * state.scale,
        height: element.offsetHeight * state.scale,
        left: Number.parseFloat(menu.style.left) || 0,
        top: Number.parseFloat(menu.style.top) || 0,
    } as DOMRect);
    const dispose = observeAnchoredMenu(trigger as unknown as HTMLElement, element, { maxHeight: 420, ...options });
    t.after(() => { dispose(); restoreGlobals(); });
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
    const bounds = () => ({
        left: Number.parseFloat(menu.style.left), top: Number.parseFloat(menu.style.top),
        right: Number.parseFloat(menu.style.left) + element.offsetWidth,
        bottom: Number.parseFloat(menu.style.top) + element.offsetHeight,
    });
    const assertInside = () => {
        const area = bounds();
        const left = initial.visual ? viewport.offsetLeft : 0;
        const top = initial.visual ? viewport.offsetTop : 0;
        const width = initial.visual ? viewport.width : state.width;
        const height = initial.visual ? viewport.height : state.height;
        assert.ok(area.left >= left + 8, JSON.stringify(area));
        assert.ok(area.right <= left + width - 8, JSON.stringify(area));
        assert.ok(area.top >= top + 8, JSON.stringify(area));
        assert.ok(area.bottom <= top + height - 8, JSON.stringify(area));
    };
    return { state, menu, element, events, viewport, viewportEvents, frames, flush, bounds, assertInside, dispose, lifecycle: () => ({ disconnected, observed }) };
}

test("long animated menus fit a 320px viewport before and after scale settles", t => {
    const f = fixture(t);
    f.assertInside();
    assert.equal(f.element.offsetHeight, 420);
    const placed = f.bounds();
    f.state.scale = 1;
    f.assertInside();
    assert.deepEqual(f.bounds(), placed);
    assert.equal(placed.left, 8);
});

test("untransformed height is preserved for a short menu opening below", t => {
    const f = fixture(t, { top: 30, left: 20, menuWidth: 180, menuHeight: 100 });
    assert.equal(f.menu.style.top, "78px");
    assert.equal(f.menu.style.maxHeight, "100px");
    f.assertInside();
});

test("end alignment uses full layout width during the opening animation", t => {
    const f = fixture(t, { width: 800, top: 100, left: 500, menuWidth: 250, menuHeight: 180 }, { align: "end" });
    assert.equal(f.bounds().right, 590);
    assert.equal(f.menu.style.left, "340px");
    f.assertInside();
});

test("resize and ancestor scroll recompute both bounds", t => {
    const f = fixture(t);
    f.state.width = 280; f.state.height = 240; f.state.left = 200; f.state.top = 180;
    f.events.get("resize")!({} as Event); f.flush();
    f.assertInside();
    f.state.top = 10; f.state.left = 30;
    f.events.get("scroll")!({ target: null } as Event); f.flush();
    assert.equal(f.menu.style.top, "58px");
    f.assertInside();
});

test("visual viewport offsets and reduced height bound the menu", t => {
    const f = fixture(t, { visual: true, left: 290, top: 330 });
    f.viewport.offsetLeft = 35; f.viewport.offsetTop = 100; f.viewport.width = 280; f.viewport.height = 300;
    f.viewportEvents.get("resize")!({} as Event); f.flush();
    f.assertInside();
    f.viewport.offsetTop = 140;
    f.viewportEvents.get("scroll")!({} as Event); f.flush();
    f.assertInside();
});

test("menu scroll does not reflow and disposal removes pending work", t => {
    const f = fixture(t);
    f.events.get("scroll")!({ target: f.element } as unknown as Event);
    assert.equal(f.frames.size, 0);
    f.events.get("resize")!({} as Event);
    assert.equal(f.frames.size, 1);
    f.dispose();
    assert.equal(f.frames.size, 0);
    assert.equal(f.events.size, 0);
    assert.deepEqual(f.lifecycle(), { disconnected: true, observed: 2 });
});
