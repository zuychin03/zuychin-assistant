// V8 F13: personal details become placeholders before a request reaches a route that may train on it, and the
// placeholders become the real details again in the reply and in tool arguments. Pure: no I/O.

export type MaskKind = "EMAIL" | "PHONE" | "ADDRESS" | "CARD" | "PERSON";
export interface MaskPrefs { enabled: boolean; names: string[] }

export const MASK_NAMES_MAX = 40;
export const MASK_NAME_CHARS = 60;
export const DEFAULT_MASK_PREFS: MaskPrefs = { enabled: true, names: [] };

export const MASK_NOTE = "Some personal details here are replaced with placeholders such as [EMAIL_1] or [PERSON_1]. When you refer to one, including in tool calls, write the placeholder exactly as it is; the real detail is put back after you answer.";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function cleanMaskNames(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const value of raw) {
        if (typeof value !== "string") continue;
        const name = value.replace(/\s+/g, " ").trim();
        const key = name.toLocaleLowerCase("en-AU");
        if (name.length < 2 || name.length > MASK_NAME_CHARS || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
        if (names.length === MASK_NAMES_MAX) break;
    }
    return names;
}

/** Saved preferences without the masking keys read as on with no names. */
export function readMaskPrefs(preferences: unknown): MaskPrefs {
    const masking = record(record(preferences).masking);
    return { enabled: masking.enabled !== false, names: cleanMaskNames(masking.names) };
}

const PLACEHOLDER = /\[(EMAIL|PHONE|ADDRESS|CARD|PERSON)_(\d{1,4})\]/g;
/** An unfinished placeholder at the end of streamed text; ADDRESS is the longest kind. */
const PARTIAL = /\[[A-Z]{0,7}(?:_\d{0,4})?$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const PHONE = new RegExp(String.raw`(?<![\w+])(?:` + [
    String.raw`\+\d{1,3}(?:[ .-]?\(?\d{1,5}\)?){2,5}`,
    String.raw`\(0\d\)[ .-]?\d{4}[ .-]?\d{4}`,
    String.raw`04\d{2}[ .-]?\d{3}[ .-]?\d{3}`,
    String.raw`0\d[ .-]?\d{4}[ .-]?\d{4}`,
].join("|") + String.raw`)(?!\w)`, "g");
const STREET_TYPES = ["Street", "St", "Road", "Rd", "Avenue", "Ave", "Drive", "Dr", "Court", "Ct", "Place", "Pl", "Lane", "Ln", "Crescent", "Cres",
    "Boulevard", "Blvd", "Parade", "Pde", "Highway", "Hwy", "Terrace", "Tce", "Way", "Close", "Circuit", "Cct", "Grove", "Square", "Esplanade", "Walk", "Rise", "Mews"]
    .map((type) => `[${type[0]}${type[0].toLowerCase()}]${type.slice(1)}`).join("|");
const ADDRESS = new RegExp(String.raw`(?<![\w/])(?:(?:Unit|Apt|Apartment|Level|Suite)\s+\d{1,4}[A-Za-z]?,?\s+)?\d{1,5}[A-Za-z]?(?:/\d{1,5}[A-Za-z]?)?\s+(?:[A-Z][A-Za-z'-]+\s+){1,3}(?:${STREET_TYPES})\b\.?`, "g");

const digits = (text: string) => text.replace(/\D/g, "");

export function luhn(number: string): boolean {
    if (number.length < 13 || number.length > 19) return false;
    let sum = 0;
    for (let index = 0; index < number.length; index++) {
        let digit = number.charCodeAt(number.length - 1 - index) - 48;
        if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
    }
    return sum % 10 === 0;
}

/** International numbers carry 8 to 15 digits; an Australian number written with its leading 0 carries 10. */
function phoneDigits(match: string): boolean {
    const count = digits(match).length;
    return match.startsWith("+") ? count >= 8 && count <= 15 : count === 10;
}

function namePattern(names: readonly string[]): RegExp | null {
    const parts = [...names].sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, String.raw`\s+`));
    return parts.length ? new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${parts.join("|")})(?![\p{L}\p{N}_])`, "giu") : null;
}

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

function mapStrings(value: unknown, map: (text: string) => string): unknown {
    if (typeof value === "string") return map(value);
    if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
    if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
    return value;
}

/**
 * One request's placeholders. The same detail always gets the same placeholder, numbered in order of first
 * appearance, so masking a growing conversation again gives the earlier messages the same placeholders.
 */
export class Masker {
    private readonly byKey = new Map<string, string>();
    private readonly originals = new Map<string, string>();
    private readonly counts: Record<MaskKind, number> = { EMAIL: 0, PHONE: 0, ADDRESS: 0, CARD: 0, PERSON: 0 };
    private readonly people: RegExp | null;

    constructor(names: readonly string[] = []) {
        this.people = namePattern(cleanMaskNames(names));
    }

    get size(): number { return this.originals.size; }

    /** Counts by kind, for logs that must not hold the details themselves. */
    kinds(): Partial<Record<MaskKind, number>> {
        return Object.fromEntries(Object.entries(this.counts).filter(([, count]) => count > 0));
    }

    private placeholder(kind: MaskKind, original: string, key: string): string {
        const id = `${kind}:${key}`;
        let placeholder = this.byKey.get(id);
        if (!placeholder) {
            placeholder = `[${kind}_${++this.counts[kind]}]`;
            this.byKey.set(id, placeholder);
            this.originals.set(placeholder, original);
        }
        return placeholder;
    }

    mask(text: string): string {
        if (!text) return text;
        const spaced = (value: string) => value.toLowerCase().replace(/\s+/g, " ");
        let out = text.replace(EMAIL, (match) => this.placeholder("EMAIL", match, match.toLowerCase()));
        out = out.replace(CARD, (match) => luhn(digits(match)) ? this.placeholder("CARD", match, digits(match)) : match);
        out = out.replace(PHONE, (match) => phoneDigits(match) ? this.placeholder("PHONE", match, digits(match)) : match);
        out = out.replace(ADDRESS, (match) => this.placeholder("ADDRESS", match, spaced(match)));
        // A name counts when it starts with a capital, so a listed "May" or "Will" leaves the ordinary words alone.
        if (this.people) out = out.replace(this.people, (match) => /^\p{Lu}/u.test(match) ? this.placeholder("PERSON", match, spaced(match)) : match);
        return out;
    }

    unmask(text: string): string {
        return this.originals.size && text ? text.replace(PLACEHOLDER, (match) => this.originals.get(match) ?? match) : text;
    }

    maskDeep<T>(value: T): T { return mapStrings(value, (text) => this.mask(text)) as T; }
    unmaskDeep<T>(value: T): T { return mapStrings(value, (text) => this.unmask(text)) as T; }

    /** JSON tool arguments: restored inside the parsed strings so a restored detail is escaped correctly. */
    unmaskJson(args: string): string {
        if (!this.originals.size || !args) return args;
        try { return JSON.stringify(this.unmaskDeep(JSON.parse(args))); } catch { return this.unmask(args); }
    }
}

/** Where an unfinished placeholder starts at the end of `text`, else its length. */
export function partialStart(text: string): number {
    return PARTIAL.exec(text)?.index ?? text.length;
}

/** Streamed text restored as it arrives; a placeholder split across deltas is held until it closes. */
export function streamRestorer(masker: Masker, emit: (text: string) => void): { push(text: string): void; flush(): void } {
    let held = "";
    return {
        push(text) {
            const joined = held + text;
            const cut = partialStart(joined);
            held = joined.slice(cut);
            if (cut > 0) emit(masker.unmask(joined.slice(0, cut)));
        },
        flush() {
            if (!held) return;
            const rest = held;
            held = "";
            emit(masker.unmask(rest));
        },
    };
}

type TextPart = { type: string; text?: string };
type MaskableMessage = { role: string; content: string | TextPart[] | null; tool_calls?: { function: { name: string; arguments: string } }[] };

/** OpenAI-style messages, masked in a copy; the note goes into the system message once anything was masked. */
export function maskChatMessages<T extends MaskableMessage>(messages: readonly T[], masker: Masker): T[] {
    const masked = messages.map((message) => ({
        ...message,
        content: typeof message.content === "string" ? masker.mask(message.content)
            : Array.isArray(message.content) ? message.content.map((part) => typeof part.text === "string" ? { ...part, text: masker.mask(part.text) } : part)
                : message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: masker.mask(call.function.arguments) } })) } : {}),
    }));
    if (!masker.size) return masked;
    const system = masked.find((message) => message.role === "system" && typeof message.content === "string");
    if (system) system.content = `${system.content}\n\n${MASK_NOTE}`;
    else masked.unshift({ role: "system", content: MASK_NOTE } as T);
    return masked;
}
