// The languages /translate and the Capture Translate action offer (V8 F9). Client-safe: no server imports.

export const TRANSLATE_MAX_CHARS = 8000;

export interface Language { code: string; name: string }

// Codes as the model cards list them; a card's regional code ("zh-cn", "pt-br") counts for its base language.
export const LANGUAGES: readonly Language[] = [
    { code: "en", name: "English" }, { code: "vi", name: "Vietnamese" }, { code: "fr", name: "French" }, { code: "de", name: "German" },
    { code: "es", name: "Spanish" }, { code: "it", name: "Italian" }, { code: "pt", name: "Portuguese" }, { code: "nl", name: "Dutch" },
    { code: "sv", name: "Swedish" }, { code: "no", name: "Norwegian" }, { code: "da", name: "Danish" }, { code: "fi", name: "Finnish" },
    { code: "pl", name: "Polish" }, { code: "cs", name: "Czech" }, { code: "ro", name: "Romanian" }, { code: "hu", name: "Hungarian" },
    { code: "el", name: "Greek" }, { code: "ru", name: "Russian" }, { code: "uk", name: "Ukrainian" }, { code: "tr", name: "Turkish" },
    { code: "ar", name: "Arabic" }, { code: "hi", name: "Hindi" }, { code: "id", name: "Indonesian" }, { code: "th", name: "Thai" },
    { code: "zh", name: "Chinese" }, { code: "ja", name: "Japanese" }, { code: "ko", name: "Korean" },
];
const ALIASES: Record<string, string> = {
    viet: "vi", "tieng-viet": "vi", "tiếng-việt": "vi", mandarin: "zh", cantonese: "zh", espanol: "es", "español": "es", "français": "fr",
    francais: "fr", deutsch: "de", italiano: "it", "português": "pt", portugues: "pt", nederlands: "nl", japan: "ja", korea: "ko",
};

export function findLanguage(raw: string): Language | null {
    const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[.,:;!?]+$/, "");
    if (!key) return null;
    const code = ALIASES[key] ?? key;
    return LANGUAGES.find((language) => language.code === code || language.name.toLowerCase() === code) ?? null;
}
