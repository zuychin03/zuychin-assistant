// Converts Nemotron Parse output into Markdown. The model tags each block as
// `<x_..><y_..>content<x_..><y_..><class_Name>` and writes tables as LaTeX `tabular`; neither is trusted as Markdown.

interface Block { x: number; y: number; className: string; content: string }

const BLOCK = /<x_([\d.]+)><y_([\d.]+)>([\s\S]*?)<x_[\d.]+><y_[\d.]+><class_([A-Za-z_-]+)>/g;
const ANY_TAG = /<(?:x|y)_[\d.]+>|<class_[A-Za-z_-]+>/g;
const DROPPED = new Set(["page-header", "page-footer", "picture"]);

// Heading text sometimes arrives as Markdown already ("## What to prepare") or wrapped in bold.
function headingText(text: string): string {
    const trimmed = text.trim().replace(/^#{1,6}\s+/, "");
    const match = /^\*\*([\s\S]+)\*\*$/.exec(trimmed);
    return match && !match[1].includes("**") ? match[1].trim() : trimmed;
}

/** `\thead{A}`, `\textbf{A}` and similar one-argument commands become their text; escaped characters lose the backslash. */
function latexText(raw: string): string {
    let text = raw;
    for (let pass = 0; pass < 5 && /\\[a-zA-Z]+\*?\{/.test(text); pass++) {
        text = text.replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1").replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, "$1");
    }
    return text.replace(/\\([&%_$#{}])/g, "$1").replace(/\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, "").replace(/~/g, " ").replace(/\s+/g, " ").trim();
}

function span(cell: string): number {
    const match = /\\multicolumn\{(\d+)\}/.exec(cell);
    return match ? Math.max(1, Math.min(20, Number(match[1]))) : 1;
}

const tableCell = (text: string) => text.replace(/\|/g, "\\|") || " ";

/** A LaTeX `tabular` as a Markdown table, the first row as the header. Null when the text holds no rows. */
export function tabularToMarkdown(latex: string): string | null {
    const body = latex.replace(/\\begin\{tabular\}\{[^}]*\}/, "").replace(/\\end\{tabular\}[\s\S]*$/, "");
    const rows = body.split(/\\\\/).map((row) => row.replace(/\\(?:hline|toprule|midrule|bottomrule)|\\cline\{[^}]*\}/g, "").trim()).filter(Boolean).map((row) =>
        row.split(/(?<!\\)&/).flatMap((cell) => {
            const text = latexText(cell);
            return [text, ...Array.from({ length: span(cell) - 1 }, () => "")];
        }));
    if (!rows.length || rows.every((row) => row.every((cell) => !cell))) return null;
    const width = Math.max(...rows.map((row) => row.length));
    const line = (row: string[]) => `| ${[...row, ...Array.from({ length: width - row.length }, () => "")].map(tableCell).join(" | ")} |`;
    return [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function blockMarkdown(block: Block): string | null {
    const kind = block.className.toLowerCase();
    if (DROPPED.has(kind)) return null;
    const content = block.content.trim();
    if (!content) return null;
    if (kind === "table") return content.includes("\\begin{tabular}") ? tabularToMarkdown(content) ?? content : content;
    if (kind === "title") return `# ${headingText(content)}`;
    if (kind === "section-header") return `## ${headingText(content)}`;
    if (kind === "list-item") return /^([-*•]|\d+[.)])\s/.test(content) ? content.replace(/^•\s/, "- ") : `- ${content}`;
    if (kind === "formula") return `$$\n${content.replace(/^\$+|\$+$/g, "").trim()}\n$$`;
    return content;
}

/** Blocks in reading order (top to bottom, then left to right), joined as Markdown. Untagged text passes through. */
export function parseOutputToMarkdown(raw: string): string {
    const blocks: Block[] = [];
    for (const match of raw.matchAll(BLOCK)) {
        blocks.push({ x: Number(match[1]), y: Number(match[2]), content: match[3], className: match[4] });
    }
    if (!blocks.length) return raw.replace(ANY_TAG, "").replace(/\n{3,}/g, "\n\n").trim();
    blocks.sort((a, b) => a.y - b.y || a.x - b.x);
    const parts = blocks.flatMap((block) => {
        const text = blockMarkdown(block);
        return text === null ? [] : [{ text, list: block.className.toLowerCase() === "list-item" }];
    });
    // Consecutive list items stay one list.
    return parts.reduce((out, part, index) => index ? `${out}${part.list && parts[index - 1].list ? "\n" : "\n\n"}${part.text}` : part.text, "").trim();
}
