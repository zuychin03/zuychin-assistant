import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { displayMarkdown } from "./model";

export interface VaultSection {
    id: string;
    title: string;
    chars: number;
    moons: VaultSection[];
}

export interface DocumentHeading {
    id: string;
    title: string;
    level: number;
    line: number;
    start: number;
    end: number;
}

export interface SectionTree {
    planets: VaultSection[];
}

interface MarkdownNode {
    type: string;
    depth?: number;
    value?: string;
    alt?: string | null;
    children?: MarkdownNode[];
    position?: { start: { line: number; offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

function plainText(node: MarkdownNode): string {
    if (node.type === "image") return node.alt ?? "";
    if (node.type === "html") return "";
    if (node.type === "break") return " ";
    return node.value ?? node.children?.map(plainText).join("") ?? "";
}

function slugify(title: string, taken: Set<string>): string {
    const base = title.normalize("NFKC").toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim().replace(/\s+/g, "-").slice(0, 60) || "section";
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) slug = `${base}-${suffix++}`;
    taken.add(slug);
    return slug;
}

export function documentHeadings(markdown: string): DocumentHeading[] {
    // Match the reader's parser and transform so source lines identify the same headings.
    const body = displayMarkdown(markdown);
    const tree = parser.parse(body);
    const headings: DocumentHeading[] = [];
    const taken = new Set<string>();
    const walk = (node: MarkdownNode) => {
        if (node.type === "heading" && node.position) {
            const title = plainText(node).trim();
            headings.push({
                id: slugify(title, taken), title, level: node.depth ?? 1,
                line: node.position.start.line, start: node.position.start.offset ?? 0,
                end: body.length,
            });
        }
        node.children?.forEach(walk);
    };
    walk(tree);
    for (let i = 0; i < headings.length; i++) {
        const next = headings.find((heading, j) => j > i && heading.level <= headings[i].level);
        headings[i].end = next?.start ?? body.length;
    }
    return headings;
}

export function parseSections(markdown: string, pageTitle: string): SectionTree {
    const headings = documentHeadings(markdown);
    let titleIndex = headings.findIndex(heading => heading.level === 1
        && heading.title.toLowerCase() === pageTitle.trim().toLowerCase());
    // Vault metadata and a document's sole leading title can use different wording.
    if (titleIndex < 0 && headings[0]?.level === 1 && headings.filter(heading => heading.level === 1).length === 1) titleIndex = 0;
    const usable = headings.filter((_, index) => index !== titleIndex);
    if (!usable.length) return { planets: [] };
    const planetLevel = Math.min(...usable.map(heading => heading.level));
    const planets: VaultSection[] = [];
    for (const heading of usable) {
        const section: VaultSection = {
            id: heading.id, title: heading.title,
            chars: Math.max(0, heading.end - heading.start), moons: [],
        };
        if (heading.level === planetLevel) planets.push(section);
        else if (planets.length) planets[planets.length - 1].moons.push(section);
    }
    return { planets };
}

export function sectionBody(markdown: string, sectionId: string): string {
    const match = documentHeadings(markdown).find(heading => heading.id === sectionId);
    return match ? displayMarkdown(markdown).slice(match.start, match.end).trim() : "";
}
