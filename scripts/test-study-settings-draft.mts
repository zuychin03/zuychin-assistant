import assert from "node:assert/strict";
import { refreshStudySettings, studySettingsChanged } from "../src/app/study/settings-draft";
const saved = { dailyLimit: 20, timezone: "Australia/Sydney", version: 1 };
const latest = { dailyLimit: 30, timezone: "Australia/Perth", version: 2 };
assert.equal(refreshStudySettings(saved, saved, latest), latest);
for (const draft of [{ ...saved, dailyLimit: 5 }, { ...saved, timezone: "Asia/Ho_Chi_Minh" }]) {
    assert.equal(studySettingsChanged(draft, saved), true);
    assert.equal(refreshStudySettings(draft, saved, latest), draft, "A focus refresh must retain the authored setting");
    assert.equal(refreshStudySettings(draft, latest, latest), draft, "Repeated refresh must retain the stale version until an explicit conflict choice");
    const accepted = { ...draft, version: latest.version };
    assert.equal(studySettingsChanged(accepted, latest), true);
    assert.equal(refreshStudySettings(accepted, accepted, { ...accepted, version: 3 }).version, 3, "Confirmed save can accept its returned version");
}
assert.equal(studySettingsChanged(latest, latest), false);
console.log("Study settings: clean refresh updates, dirty daily limit/timezone survive repeated refresh, and accepted saves advance versions.");
