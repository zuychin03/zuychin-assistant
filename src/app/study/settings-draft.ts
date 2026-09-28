import type { StudySettings } from "@/lib/study/contracts";

export function studySettingsChanged(draft: StudySettings, saved: StudySettings) {
    return draft.dailyLimit !== saved.dailyLimit || draft.timezone !== saved.timezone || draft.version !== saved.version;
}
export function refreshStudySettings(draft: StudySettings, previous: StudySettings, latest: StudySettings) {
    return studySettingsChanged(draft, previous) ? draft : latest;
}
