import { NextRequest, NextResponse } from "next/server";
import {
    Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel,
    AlignmentType, BorderStyle, ShadingType,
    Table, TableRow, TableCell, WidthType, VerticalAlign,
} from "docx";
import PDFDocument from "pdfkit";


type BlockType = "h1" | "h2" | "h3" | "bullet" | "numbered" | "code" | "paragraph" | "hr" | "table" | "quote";

interface Block {
    type: BlockType;
    text: string;
    items?: string[];       // code lines
    tableRows?: string[][];
    ordinal?: number;       // numbered list index
    level?: number;         // list nesting depth
    lang?: string;          // code fence language
}

interface InlineToken {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    link?: string;
}

// Shared palette (GitHub-ish) so the DOCX and PDF renderers stay in sync.
const COLORS = {
    heading: "111827",
    text: "1F2937",
    muted: "6B7280",
    link: "2563EB",
    codeText: "24292E",
    inlineCode: "C7254E",
    codeBg: "F6F8FA",
    border: "D0D7DE",
    rule: "E5E7EB",
    tableHeaderBg: "F3F4F6",
};
const hex = (c: string) => `#${c}`;


function parseMarkdown(content: string): Block[] {
    const lines = content.split("\n");
    const blocks: Block[] = [];
    let inCodeBlock = false;
    let codeLines: string[] = [];
    let codeLang = "";
    let tableBuffer: string[] = [];

    const flushTable = () => {
        if (tableBuffer.length === 0) return;
        const rows: string[][] = [];
        for (const tLine of tableBuffer) {
            // Skip separator rows
            if (/^\|[\s\-:|]+\|$/.test(tLine.trim())) continue;
            const cells = tLine
                .trim()
                .replace(/^\|/, "")
                .replace(/\|$/, "")
                .split("|")
                .map(c => c.trim());
            if (cells.length > 0) rows.push(cells);
        }
        if (rows.length > 0) {
            blocks.push({ type: "table", text: "", tableRows: rows });
        }
        tableBuffer = [];
    };

    for (const line of lines) {

        const fence = line.trimStart().match(/^```+\s*([a-zA-Z0-9+#._-]*)/);
        if (fence) {
            flushTable();
            if (inCodeBlock) {
                blocks.push({ type: "code", text: "", items: codeLines, lang: codeLang });
                codeLines = [];
                codeLang = "";
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
                codeLang = fence[1] || "";
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        const trimmed = line.trim();

        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            tableBuffer.push(trimmed);
            continue;
        } else {
            flushTable();
        }

        if (!trimmed) continue;

        const indentSpaces = line.length - line.trimStart().length;
        const level = Math.min(Math.floor(indentSpaces / 2), 4);

        const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);

        if (trimmed.startsWith("### ")) {
            blocks.push({ type: "h3", text: trimmed.slice(4) });
        } else if (trimmed.startsWith("## ")) {
            blocks.push({ type: "h2", text: trimmed.slice(3) });
        } else if (trimmed.startsWith("# ")) {
            blocks.push({ type: "h1", text: trimmed.slice(2) });
        } else if (trimmed.startsWith("#### ")) {
            blocks.push({ type: "h3", text: trimmed.slice(5) });
        }

        else if (/^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ""))) {
            blocks.push({ type: "hr", text: "" });
        }

        else if (trimmed.startsWith(">")) {
            blocks.push({ type: "quote", text: trimmed.replace(/^>+\s?/, "") });
        }

        else if (/^[-*+]\s/.test(trimmed)) {
            blocks.push({ type: "bullet", text: trimmed.replace(/^[-*+]\s+/, ""), level });
        }

        else if (numMatch) {
            blocks.push({ type: "numbered", text: numMatch[2], ordinal: parseInt(numMatch[1], 10), level });
        }

        else {
            blocks.push({ type: "paragraph", text: trimmed });
        }
    }

    flushTable();
    if (inCodeBlock && codeLines.length > 0) {
        blocks.push({ type: "code", text: "", items: codeLines, lang: codeLang });
    }

    return blocks;
}


/** Split a line into styled inline tokens (bold / italic / code / link). */
function parseInline(text: string): InlineToken[] {
    const tokens: InlineToken[] = [];
    const pattern = /(\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|`([^`]+?)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIdx) {
            tokens.push({ text: text.slice(lastIdx, match.index) });
        }
        if (match[2] !== undefined) tokens.push({ text: match[2], bold: true });
        else if (match[3] !== undefined) tokens.push({ text: match[3], bold: true });
        else if (match[4] !== undefined) tokens.push({ text: match[4], italic: true });
        else if (match[5] !== undefined) tokens.push({ text: match[5], code: true });
        else if (match[6] !== undefined) tokens.push({ text: match[6], link: match[7] });
        lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) {
        tokens.push({ text: text.slice(lastIdx) });
    }
    if (tokens.length === 0) tokens.push({ text });
    return tokens;
}

function stripInlineMarkdown(text: string): string {
    return parseInline(text).map(t => t.text).join("");
}


// ---------- DOCX ----------

function buildTextRuns(text: string, opts: { bold?: boolean; italic?: boolean; color?: string } = {}): (TextRun | ExternalHyperlink)[] {
    const tokens = parseInline(text);
    const runs: (TextRun | ExternalHyperlink)[] = [];

    for (const t of tokens) {
        if (t.link) {
            runs.push(new ExternalHyperlink({
                link: t.link,
                children: [new TextRun({ text: t.text, style: "Hyperlink", size: 22 })],
            }));
        } else if (t.code) {
            runs.push(new TextRun({
                text: t.text, font: "Consolas", size: 20, color: COLORS.inlineCode,
                shading: { type: ShadingType.CLEAR, fill: "F1F1F4", color: "auto" },
            }));
        } else {
            runs.push(new TextRun({
                text: t.text,
                bold: opts.bold || t.bold,
                italics: opts.italic || t.italic,
                color: opts.color,
                size: 22,
            }));
        }
    }
    if (runs.length === 0) runs.push(new TextRun({ text, size: 22, color: opts.color }));
    return runs;
}

function buildDocxCodeBlock(lines: string[], lang: string): Paragraph[] {
    const rendered = lang ? [`# ${lang}`, ...lines] : lines;
    const last = rendered.length - 1;
    return rendered.map((codeLine, idx) => new Paragraph({
        children: [new TextRun({
            text: codeLine || " ",
            font: "Consolas",
            size: 18,
            color: idx === 0 && lang ? COLORS.muted : COLORS.codeText,
        })],
        shading: { type: ShadingType.CLEAR, fill: COLORS.codeBg, color: "auto" },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: COLORS.border, space: 12 } },
        indent: { left: 360, right: 360 },
        spacing: { before: idx === 0 ? 120 : 0, after: idx === last ? 120 : 0, line: 250 },
    }));
}

function buildDocxTable(rows: string[][]): Table {
    const colCount = Math.max(...rows.map(r => r.length));
    const colWidth = Math.floor(9020 / colCount);
    const thin = { style: BorderStyle.SINGLE, size: 4, color: COLORS.border };

    const tableRows = rows.map((row, rowIdx) => {
        const isHeader = rowIdx === 0;
        const cells = [];
        for (let i = 0; i < colCount; i++) {
            const cellText = row[i] ?? "";
            cells.push(new TableCell({
                children: [new Paragraph({
                    children: buildTextRuns(cellText, { bold: isHeader }),
                    spacing: { before: 40, after: 40 },
                })],
                width: { size: colWidth, type: WidthType.DXA },
                verticalAlign: VerticalAlign.CENTER,
                margins: { top: 30, bottom: 30, left: 100, right: 100 },
                shading: isHeader ? { type: ShadingType.CLEAR, fill: COLORS.tableHeaderBg, color: "auto" } : undefined,
            }));
        }
        return new TableRow({ children: cells, tableHeader: isHeader });
    });

    return new Table({
        rows: tableRows,
        width: { size: 9020, type: WidthType.DXA },
        borders: {
            top: thin, bottom: thin, left: thin, right: thin,
            insideHorizontal: thin, insideVertical: thin,
        },
    });
}

async function generateDocx(content: string, title: string): Promise<Buffer> {
    const blocks = parseMarkdown(content);
    const children: (Paragraph | Table)[] = [];

    children.push(new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 40, color: COLORS.heading, font: "Calibri" })],
        heading: HeadingLevel.TITLE,
        spacing: { after: 60 },
    }));
    children.push(new Paragraph({
        children: [new TextRun({ text: "Exported from Zuychin Assistant", size: 18, color: COLORS.muted, italics: true })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.rule, space: 6 } },
        spacing: { after: 240 },
    }));

    for (const block of blocks) {
        switch (block.type) {
            case "h1":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { bold: true, color: COLORS.heading }),
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 280, after: 120 },
                    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule, space: 4 } },
                }));
                break;
            case "h2":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { bold: true, color: COLORS.heading }),
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 220, after: 100 },
                }));
                break;
            case "h3":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { bold: true, color: COLORS.heading }),
                    heading: HeadingLevel.HEADING_3,
                    spacing: { before: 180, after: 80 },
                }));
                break;
            case "bullet":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { color: COLORS.text }),
                    bullet: { level: block.level ?? 0 },
                    spacing: { after: 60, line: 264 },
                }));
                break;
            case "numbered":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { color: COLORS.text }),
                    numbering: { reference: "default-numbering", level: block.level ?? 0 },
                    spacing: { after: 60, line: 264 },
                }));
                break;
            case "code":
                children.push(...buildDocxCodeBlock(block.items ?? [], block.lang ?? ""));
                break;
            case "quote":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { italic: true, color: COLORS.muted }),
                    border: { left: { style: BorderStyle.SINGLE, size: 24, color: COLORS.border, space: 12 } },
                    indent: { left: 360 },
                    spacing: { before: 80, after: 80, line: 276 },
                }));
                break;
            case "hr":
                children.push(new Paragraph({
                    children: [new TextRun({ text: "" })],
                    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.rule } },
                    spacing: { before: 160, after: 160 },
                }));
                break;
            case "table":
                if (block.tableRows && block.tableRows.length > 0) {
                    children.push(buildDocxTable(block.tableRows));
                    children.push(new Paragraph({ children: [], spacing: { after: 160 } }));
                }
                break;
            case "paragraph":
            default:
                children.push(new Paragraph({
                    children: buildTextRuns(block.text, { color: COLORS.text }),
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 140, line: 276 },
                }));
                break;
        }
    }

    const doc = new Document({
        styles: {
            default: { document: { run: { font: "Calibri", size: 22, color: COLORS.text } } },
        },
        numbering: {
            config: [{
                reference: "default-numbering",
                levels: [0, 1, 2, 3].map(level => ({
                    level,
                    format: "decimal" as const,
                    text: `%${level + 1}.`,
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
                })),
            }],
        },
        sections: [{
            properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
            children,
        }],
    });

    return Buffer.from(await Packer.toBuffer(doc));
}


// ---------- PDF ----------

const PAGE = { left: 60, right: 535, bottom: 782 };

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
    if (doc.y + needed > PAGE.bottom) doc.addPage();
}

/** Render a line of inline markdown as a sequence of continued styled runs. */
function renderInline(doc: PDFKit.PDFDocument, text: string, o: { fontSize: number; color?: string; lineGap?: number }) {
    const tokens = parseInline(text);
    const baseColor = o.color ?? hex(COLORS.text);

    tokens.forEach((t, i) => {
        const last = i === tokens.length - 1;
        let font = "Helvetica";
        if (t.code) font = "Courier";
        else if (t.bold && t.italic) font = "Helvetica-BoldOblique";
        else if (t.bold) font = "Helvetica-Bold";
        else if (t.italic) font = "Helvetica-Oblique";

        const opts: { continued: boolean; lineGap: number; link?: string; underline?: boolean } =
            { continued: !last, lineGap: o.lineGap ?? 3 };
        if (t.link) { opts.link = t.link; opts.underline = true; }

        doc.font(font)
            .fontSize(t.code ? o.fontSize - 1 : o.fontSize)
            .fillColor(t.link ? hex(COLORS.link) : t.code ? hex(COLORS.inlineCode) : baseColor)
            .text(t.text, opts);
    });
    // A single continued:false call may be needed if the marker opened a run.
    if (tokens.length === 0) doc.text(" ", { continued: false });
    doc.fillColor("#000");
}

function drawPdfCodeBlock(doc: PDFKit.PDFDocument, lines: string[], lang: string) {
    const rendered = lang ? [`# ${lang}`, ...lines] : lines;
    const pad = 6;
    const width = PAGE.right - PAGE.left;
    const innerWidth = width - pad * 2 - 6;
    doc.moveDown(0.35);

    rendered.forEach((line, idx) => {
        const txt = line.length ? line : " ";
        doc.font("Courier").fontSize(9);
        const h = doc.heightOfString(txt, { width: innerWidth }) + pad;
        ensureSpace(doc, h + 2);
        const y = doc.y;
        doc.rect(PAGE.left, y, width, h).fill(hex(COLORS.codeBg));
        doc.rect(PAGE.left, y, 3, h).fill(hex(COLORS.border));   // accent bar
        doc.fillColor(idx === 0 && lang ? hex(COLORS.muted) : hex(COLORS.codeText))
            .font("Courier").fontSize(9)
            .text(txt, PAGE.left + pad + 6, y + pad / 2, { width: innerWidth });
        doc.y = y + h;
    });

    doc.fillColor("#000").moveDown(0.5);
}

function drawPdfTable(doc: PDFKit.PDFDocument, rows: string[][]) {
    const colCount = Math.max(...rows.map(r => r.length));
    const pageWidth = PAGE.right - PAGE.left;
    const colWidth = pageWidth / colCount;
    const cellPadding = 6;
    const fontSize = 9;

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        const isHeader = rowIdx === 0;

        let maxHeight = 18;
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
            const cellText = stripInlineMarkdown(row[colIdx] ?? "");
            const textWidth = colWidth - cellPadding * 2;
            const textHeight = doc.fontSize(fontSize).font(isHeader ? "Helvetica-Bold" : "Helvetica")
                .heightOfString(cellText, { width: textWidth }) + cellPadding * 2;
            if (textHeight > maxHeight) maxHeight = textHeight;
        }

        ensureSpace(doc, maxHeight);
        const rowY = doc.y;

        if (isHeader) {
            doc.rect(PAGE.left, rowY, pageWidth, maxHeight).fill(hex(COLORS.tableHeaderBg));
        }

        for (let colIdx = 0; colIdx < colCount; colIdx++) {
            const cellText = stripInlineMarkdown(row[colIdx] ?? "");
            const cellX = PAGE.left + colIdx * colWidth;
            doc.rect(cellX, rowY, colWidth, maxHeight).strokeColor(hex(COLORS.border)).lineWidth(0.75).stroke();
            doc.fontSize(fontSize)
                .font(isHeader ? "Helvetica-Bold" : "Helvetica")
                .fillColor(isHeader ? hex(COLORS.heading) : hex(COLORS.text))
                .text(cellText, cellX + cellPadding, rowY + cellPadding, {
                    width: colWidth - cellPadding * 2,
                    height: maxHeight - cellPadding * 2,
                });
        }

        doc.y = rowY + maxHeight;
        doc.x = PAGE.left;
    }

    doc.fillColor("#000").moveDown(0.6);
}

async function generatePdf(content: string, title: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
        });

        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const blocks = parseMarkdown(content);

        // Title block
        doc.fillColor(hex(COLORS.heading)).fontSize(22).font("Helvetica-Bold").text(title, { align: "left" });
        doc.moveDown(0.15);
        doc.fillColor(hex(COLORS.muted)).fontSize(9).font("Helvetica-Oblique").text("Exported from Zuychin Assistant");
        doc.moveDown(0.4);
        doc.moveTo(PAGE.left, doc.y).lineTo(PAGE.right, doc.y).strokeColor(hex(COLORS.rule)).lineWidth(1).stroke();
        doc.moveDown(0.7);

        for (const block of blocks) {
            switch (block.type) {
                case "h1":
                    ensureSpace(doc, 40);
                    doc.moveDown(0.4);
                    doc.font("Helvetica-Bold").fontSize(17).fillColor(hex(COLORS.heading)).text(stripInlineMarkdown(block.text));
                    doc.moveDown(0.2);
                    doc.moveTo(PAGE.left, doc.y).lineTo(PAGE.right, doc.y).strokeColor(hex(COLORS.rule)).lineWidth(1).stroke();
                    doc.moveDown(0.4);
                    break;
                case "h2":
                    ensureSpace(doc, 32);
                    doc.moveDown(0.35);
                    doc.font("Helvetica-Bold").fontSize(14).fillColor(hex(COLORS.heading)).text(stripInlineMarkdown(block.text));
                    doc.moveDown(0.25);
                    break;
                case "h3":
                    ensureSpace(doc, 26);
                    doc.moveDown(0.25);
                    doc.font("Helvetica-Bold").fontSize(12).fillColor(hex(COLORS.heading)).text(stripInlineMarkdown(block.text));
                    doc.moveDown(0.15);
                    break;
                case "bullet": {
                    const lvl = block.level ?? 0;
                    ensureSpace(doc, 16);
                    doc.font("Helvetica").fontSize(11).fillColor(hex(COLORS.text))
                        .text("•  ", { continued: true, indent: 12 + lvl * 18 });
                    renderInline(doc, block.text, { fontSize: 11 });
                    doc.moveDown(0.2);
                    break;
                }
                case "numbered": {
                    const lvl = block.level ?? 0;
                    ensureSpace(doc, 16);
                    doc.font("Helvetica").fontSize(11).fillColor(hex(COLORS.text))
                        .text(`${block.ordinal ?? 1}.  `, { continued: true, indent: 12 + lvl * 18 });
                    renderInline(doc, block.text, { fontSize: 11 });
                    doc.moveDown(0.2);
                    break;
                }
                case "code":
                    drawPdfCodeBlock(doc, block.items ?? [], block.lang ?? "");
                    break;
                case "quote": {
                    doc.moveDown(0.2);
                    ensureSpace(doc, 20);
                    const startY = doc.y;
                    doc.font("Helvetica-Oblique").fontSize(11).fillColor(hex(COLORS.muted))
                        .text(stripInlineMarkdown(block.text), PAGE.left + 14, startY, { width: PAGE.right - PAGE.left - 14, lineGap: 3 });
                    doc.rect(PAGE.left + 2, startY, 3, doc.y - startY).fill(hex(COLORS.border));
                    doc.x = PAGE.left;
                    doc.fillColor("#000").moveDown(0.4);
                    break;
                }
                case "hr":
                    doc.moveDown(0.4);
                    doc.moveTo(PAGE.left, doc.y).lineTo(PAGE.right, doc.y).strokeColor(hex(COLORS.rule)).lineWidth(1).stroke();
                    doc.moveDown(0.4);
                    break;
                case "table":
                    if (block.tableRows && block.tableRows.length > 0) {
                        doc.moveDown(0.3);
                        drawPdfTable(doc, block.tableRows);
                    }
                    break;
                case "paragraph":
                default:
                    ensureSpace(doc, 16);
                    renderInline(doc, block.text, { fontSize: 11, lineGap: 3 });
                    doc.moveDown(0.45);
                    break;
            }
        }

        doc.end();
    });
}


// POST /api/export

export async function POST(req: NextRequest) {
    try {
        const { content, format, title = "Document" } = await req.json();

        if (!content || typeof content !== "string") {
            return NextResponse.json({ error: "Content is required." }, { status: 400 });
        }

        if (!["docx", "pdf", "md"].includes(format)) {
            return NextResponse.json({ error: "Format must be 'docx', 'pdf' or 'md'." }, { status: 400 });
        }

        const safeTitle = title.replace(/[^a-zA-Z0-9\s_-]/g, "").substring(0, 60).trim() || "Document";

        if (format === "md") {
            const md = `# ${safeTitle}\n\n${content}\n`;
            return new NextResponse(md, {
                status: 200,
                headers: {
                    "Content-Type": "text/markdown; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${safeTitle}.md"`,
                },
            });
        }

        if (format === "docx") {
            const buffer = await generateDocx(content, safeTitle);
            return new NextResponse(new Uint8Array(buffer), {
                status: 200,
                headers: {
                    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "Content-Disposition": `attachment; filename="${safeTitle}.docx"`,
                },
            });
        }

        const buffer = await generatePdf(content, safeTitle);
        return new NextResponse(new Uint8Array(buffer), {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
            },
        });
    } catch (error) {
        console.error("[Export] Error:", error);
        return NextResponse.json({ error: "Export failed." }, { status: 500 });
    }
}
