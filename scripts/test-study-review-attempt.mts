import assert from "node:assert/strict";
import type { StudyCard } from "../src/lib/study/contracts";
import { studyReviewState } from "../src/app/study/review-attempt";

const now = Date.parse("2026-09-28T00:00:00Z");
const card = (id: string): StudyCard => ({ id, deck: "Examples", kind: "recall", prompt: `Question ${id}`, answer: `Answer ${id}`, active: true, version: 1, updatedAt: "2026-09-27T00:00:00Z", schedule: { due: "2026-09-27T00:00:00Z" }, evidence: { quote: `Source ${id}` } } as StudyCard);
const first = card("A"), second = card("B");
assert.equal(studyReviewState([first, second], null, undefined, "", now).current, first);
for (const refreshed of [[second], [second, { ...first, active: false }], [second, { ...first, version: 2 }], [second, { ...first, schedule: { ...first.schedule, due: "2026-09-29T00:00:00Z" } }]]) {
    const result = studyReviewState(refreshed, first, undefined, "", now);
    assert.equal(result.current, first, "An in-progress answer stays attached to its original displayed card");
    assert.equal(result.changed, true, "A removed or changed card must stop new grading");
    assert.equal(studyReviewState(refreshed, null, undefined, "", now).current, second, "Explicitly clearing the attempt advances to the next due card");
}
const reordered = studyReviewState([second, first], first, undefined, "", now);
assert.equal(reordered.current, first);
assert.equal(reordered.changed, false);
const latest = { ...first, version: 2 };
assert.deepEqual(studyReviewState([second, latest], first, first.id, "", now), { current: latest, changed: false }, "An existing ambiguous request retains its original retry path");
assert.deepEqual(studyReviewState([second], first, first.id, "", now), { current: undefined, changed: false }, "A missing pending card uses request recovery, never a new due card");
assert.equal(studyReviewState([first], null, undefined, "Other deck", now).current, undefined);
console.log("Study attempt: original card pinned across removal, edits, rescheduling and reordering; explicit advance and pending retry preserved.");
