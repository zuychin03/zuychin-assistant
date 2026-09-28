import assert from "node:assert/strict";
import { initialSchedule, nextReview, studyDraft, studyDay } from "../src/lib/study/scheduler";
import { cardInput, reviewInput } from "../src/lib/study/contracts";

const now = new Date("2026-09-28T00:00:00Z");
const empty = initialSchedule(now);
assert.equal(empty.due, now.toISOString());
assert.equal(empty.reps, 0);
for (const rating of [1, 2, 3, 4] as const) {
    const result = nextReview(empty, rating, now);
    assert.equal(result.card.reps, 1);
    assert.ok(Date.parse(result.card.due) > now.getTime());
    assert.equal(result.log.rating, rating);
    assert.deepEqual(result, nextReview(JSON.parse(JSON.stringify(empty)), rating, now));
}
assert.throws(() => nextReview({ ...empty, stability: NaN }, 3, now), /schedule/i);
assert.equal(studyDay(new Date("2026-09-28T15:00:00Z"), "Australia/Sydney"), "2026-09-29");
assert.equal(studyDay(new Date("2026-09-28T15:00:00Z"), "UTC"), "2026-09-28");
for (const kind of ["recall", "exercise", "explain"] as const) {
    const draft = studyDraft(kind, "A source passage", "Example source");
    assert.equal(draft.answer, "A source passage");
    assert.ok(draft.prompt.length > 10);
}
assert.throws(() => cardInput.parse({}), /./);
assert.throws(() => reviewInput.parse({ id: crypto.randomUUID(), cardId: crypto.randomUUID(), version: 1, rating: 3, response: "", reflection: "" }), /./);
assert.throws(() => reviewInput.parse({ id: crypto.randomUUID(), cardId: crypto.randomUUID(), version: 1, rating: 5, response: "answer", reflection: "" }), /./);
console.log("Study scheduler: 30 assertions passed.");
