import assert from "node:assert/strict";
import { test } from "node:test";
import { placeLabel, type LabelBox } from "../src/app/graph/cosmos/label-layout.ts";

const bounds: LabelBox = { x1: 8, y1: 8, x2: 312, y2: 292 };
const overlaps = (a: LabelBox, b: LabelBox) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

test("long labels at either viewport edge keep their complete box inside the safe area", () => {
    for (const x of [0, 12, 300, 320]) {
        const box = placeLabel({ x, y: 100 }, 190, 19, 16, bounds, []);
        assert(box);
        assert(box.x1 >= bounds.x1 && box.x2 <= bounds.x2);
        assert.equal(box.x2 - box.x1, 190);
    }
});

test("a bottom-edge label stays above the viewport edge", () => {
    const box = placeLabel({ x: 150, y: 290 }, 150, 19, 16, bounds, []);
    assert(box);
    assert(box.y1 >= bounds.y1 && box.y2 <= bounds.y2);
});

test("labels use another position when zoom controls occupy their normal position", () => {
    const controls = { x1: 156, y1: 220, x2: 312, y2: 292 };
    const box = placeLabel({ x: 250, y: 232 }, 190, 19, 16, bounds, [controls]);
    assert(box);
    assert(!overlaps(box, controls));
    assert(box.y2 <= controls.y1);
});

test("claimed priority labels stay clear and a fully blocked viewport suppresses another label", () => {
    const priority = placeLabel({ x: 150, y: 100 }, 190, 19, 16, bounds, []);
    assert(priority);
    const other = placeLabel({ x: 156, y: 104 }, 190, 19, 16, bounds, [priority]);
    if (other) assert(!overlaps(other, priority));
    assert.equal(placeLabel({ x: 150, y: 100 }, 190, 19, 16, bounds, [bounds]), null);
    assert.equal(placeLabel({ x: 5, y: 5 }, 20, 19, 16, { x1: 8, y1: 8, x2: 12, y2: 12 }, []), null);
});
