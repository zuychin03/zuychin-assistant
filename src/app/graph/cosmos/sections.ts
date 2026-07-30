// Sections are the one genuine containment relation in the vault: a heading
// belongs to its page, unlike a wikilink, which is symmetric and has no parent.
// That is what makes a planetary system meaningful here: the planets are the
// root page's own contents, while neighbouring pages stay stars.

export interface VaultSection {
    /** Slug, unique within the page. */
    id: string;
    title: string;
    /** Characters of body text under this heading, before the next sibling. */
    chars: number;
    moons: VaultSection[];
}

export interface SectionTree {
    planets: VaultSection[];
}

// Deliberately uncapped. An earlier draft dropped headings past a fixed limit,
// which broke the one promise the feature makes: that every planet is a section
// you can open. Crowding is a layout problem, solved by filling concentric orbits
// rather than by hiding sections.

interface Heading {
    level: number;
    title: string;
    start: number;
    end: number;
}

function slugify(title: string, taken: Set<string>): string {
    const base = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60) || "section";
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${base}-${n++}`;
    taken.add(slug);
    return slug;
}

function stripFrontmatter(markdown: string): string {
    return markdown.startsWith("---")
        ? markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        : markdown;
}

/**
 * Headings outside fenced code blocks. A "# " inside a shell snippet is a
 * comment, not a section, so fences have to be tracked.
 */
function collectHeadings(body: string): Heading[] {
    const lines = body.split("\n");
    const headings: Heading[] = [];
    let offset = 0;
    let inFence = false;

    for (const line of lines) {
        const lineLength = line.length + 1;
        if (/^\s*```/.test(line)) inFence = !inFence;
        else if (!inFence) {
            const match = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
            if (match) {
                headings.push({
                    level: match[1].length,
                    title: match[2].trim(),
                    start: offset,
                    end: body.length,
                });
            }
        }
        offset += lineLength;
    }

    for (let i = 0; i < headings.length; i++) {
        const next = headings.find((h, j) => j > i && h.level <= headings[i].level);
        headings[i].end = next ? next.start : body.length;
    }
    return headings;
}

/**
 * Planets come from the shallowest heading level below the page title, moons from
 * the next level down, so a page written with h1/h2 behaves like one written with
 * h2/h3.
 */
export function parseSections(markdown: string, pageTitle: string): SectionTree {
    const body = stripFrontmatter(markdown);
    const headings = collectHeadings(body);
    if (headings.length === 0) return { planets: [] };

    // The page's own title heading is already represented by the star itself.
    const normalizedTitle = pageTitle.trim().toLowerCase();
    const firstTitleIndex = headings.findIndex(
        (h) => h.level === 1 && h.title.trim().toLowerCase() === normalizedTitle,
    );
    const usable = firstTitleIndex === -1
        ? headings
        : headings.filter((_, index) => index !== firstTitleIndex);
    if (usable.length === 0) return { planets: [] };

    const planetLevel = Math.min(...usable.map((h) => h.level));
    const moonLevel = Math.min(
        ...usable.filter((h) => h.level > planetLevel).map((h) => h.level),
        Infinity,
    );

    const taken = new Set<string>();
    const planets: VaultSection[] = [];

    for (const heading of usable) {
        const section: VaultSection = {
            id: slugify(heading.title, taken),
            title: heading.title,
            chars: Math.max(0, heading.end - heading.start),
            moons: [],
        };
        if (heading.level === planetLevel) planets.push(section);
        else if (heading.level === moonLevel && planets.length > 0) {
            planets[planets.length - 1].moons.push(section);
        }
    }

    return { planets };
}

/** Body of one section, for reading it on its own. */
export function sectionBody(markdown: string, sectionTitle: string): string {
    const body = stripFrontmatter(markdown);
    const headings = collectHeadings(body);
    const match = headings.find((h) => h.title.trim() === sectionTitle.trim());
    if (!match) return "";
    return body.slice(match.start, match.end).trim();
}
