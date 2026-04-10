import { NextRequest, NextResponse } from "next/server";
import {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, BorderStyle,
    Table, TableRow, TableCell, WidthType, TableBorders,
} from "docx";
import PDFDocument from "pdfkit";


type BlockType = "h1" | "h2" | "h3" | "bullet" | "numbered" | "code" | "paragraph" | "hr" | "table";

interface Block {
    type: BlockType;
    text: string;
    items?: string[];
    tableRows?: string[][];
}


function parseMarkdown(content: string): Block[] {
    const lines = content.split("\n");
    const blocks: Block[] = [];
    let inCodeBlock = false;
    let codeLines: string[] = [];
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

        if (line.trimStart().startsWith("```")) {
            flushTable();
            if (inCodeBlock) {
                blocks.push({ type: "code", text: "", items: codeLines });
                codeLines = [];
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
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


        if (trimmed.startsWith("### ")) {
            blocks.push({ type: "h3", text: trimmed.slice(4) });
        } else if (trimmed.startsWith("## ")) {
            blocks.push({ type: "h2", text: trimmed.slice(3) });
        } else if (trimmed.startsWith("# ")) {
            blocks.push({ type: "h1", text: trimmed.slice(2) });
        }

        else if (/^[-*_]{3,}$/.test(trimmed)) {
            blocks.push({ type: "hr", text: "" });
        }

        else if (/^[-*+]\s/.test(trimmed)) {
            blocks.push({ type: "bullet", text: trimmed.replace(/^[-*+]\s/, "") });
        }

        else if (/^\d+\.\s/.test(trimmed)) {
            blocks.push({ type: "numbered", text: trimmed.replace(/^\d+\.\s/, "") });
        }

        else {
            blocks.push({ type: "paragraph", text: trimmed });
        }
    }


    flushTable();
    if (inCodeBlock && codeLines.length > 0) {
        blocks.push({ type: "code", text: "", items: codeLines });
    }

    return blocks;
}


function stripInlineMarkdown(text: string): string {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`(.+?)`/g, "$1")
        .replace(/\[(.+?)\]\(.+?\)/g, "$1");
}


function buildTextRuns(text: string, baseBold = false): TextRun[] {
    const runs: TextRun[] = [];
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\(.+?\))/g;
    let lastIdx = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIdx) {
            runs.push(new TextRun({ text: text.slice(lastIdx, match.index), size: 22, bold: baseBold }));
        }
        if (match[2]) {
            runs.push(new TextRun({ text: match[2], bold: true, size: 22 }));
        } else if (match[3]) {
            runs.push(new TextRun({ text: match[3], italics: true, size: 22, bold: baseBold }));
        } else if (match[4]) {
            runs.push(new TextRun({ text: match[4], font: "Courier New", size: 20, bold: baseBold }));
        } else if (match[5]) {
            runs.push(new TextRun({ text: match[5], size: 22, bold: baseBold }));
        }
        lastIdx = match.index + match[0].length;
    }

    if (lastIdx < text.length) {
        runs.push(new TextRun({ text: text.slice(lastIdx), size: 22, bold: baseBold }));
    }

    if (runs.length === 0) {
        runs.push(new TextRun({ text, size: 22, bold: baseBold }));
    }

    return runs;
}



function buildDocxTable(rows: string[][]): Table {
    const colCount = Math.max(...rows.map(r => r.length));
    const colWidth = Math.floor(9000 / colCount); // total page width ~9000 twips

    const tableRows = rows.map((row, rowIdx) => {
        const cells = [];
        for (let i = 0; i < colCount; i++) {
            const cellText = row[i] ?? "";
            const isHeader = rowIdx === 0;
            cells.push(
                new TableCell({
                    children: [
                        new Paragraph({
                            children: buildTextRuns(stripInlineMarkdown(cellText), isHeader),
                            spacing: { before: 40, after: 40 },
                        }),
                    ],
                    width: { size: colWidth, type: WidthType.DXA },
                    shading: isHeader ? { fill: "E8E8E8" } : undefined,
                })
            );
        }
        return new TableRow({ children: cells });
    });

    return new Table({
        rows: tableRows,
        width: { size: 9000, type: WidthType.DXA },
        borders: TableBorders.NONE,
    });
}



async function generateDocx(content: string, title: string): Promise<Buffer> {
    const blocks = parseMarkdown(content);

    const children: (Paragraph | Table)[] = [];


    children.push(
        new Paragraph({
            children: [new TextRun({ text: title, bold: true, size: 32, font: "Calibri" })],
            heading: HeadingLevel.TITLE,
            spacing: { after: 200 },
        })
    );

    for (const block of blocks) {
        switch (block.type) {
            case "h1":
                children.push(new Paragraph({
                    children: [new TextRun({ text: block.text, bold: true, size: 28, font: "Calibri" })],
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 240, after: 120 },
                }));
                break;
            case "h2":
                children.push(new Paragraph({
                    children: [new TextRun({ text: block.text, bold: true, size: 26, font: "Calibri" })],
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 200, after: 100 },
                }));
                break;
            case "h3":
                children.push(new Paragraph({
                    children: [new TextRun({ text: block.text, bold: true, size: 24, font: "Calibri" })],
                    heading: HeadingLevel.HEADING_3,
                    spacing: { before: 160, after: 80 },
                }));
                break;
            case "bullet":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text),
                    bullet: { level: 0 },
                    spacing: { after: 60 },
                }));
                break;
            case "numbered":
                children.push(new Paragraph({
                    children: buildTextRuns(block.text),
                    numbering: { reference: "default-numbering", level: 0 },
                    spacing: { after: 60 },
                }));
                break;
            case "code":
                for (const codeLine of (block.items ?? [])) {
                    children.push(new Paragraph({
                        children: [new TextRun({
                            text: codeLine || " ",
                            font: "Courier New",
                            size: 18,
                        })],
                        spacing: { after: 20 },
                        indent: { left: 720 },
                    }));
                }
                break;
            case "hr":
                children.push(new Paragraph({
                    children: [new TextRun({ text: "" })],
                    border: {
                        bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
                    },
                    spacing: { before: 120, after: 120 },
                }));
                break;
            case "table":
                if (block.tableRows && block.tableRows.length > 0) {
                    children.push(buildDocxTable(block.tableRows));
                    children.push(new Paragraph({ children: [], spacing: { after: 100 } }));
                }
                break;
            case "paragraph":
            default:
                children.push(new Paragraph({
                    children: buildTextRuns(block.text),
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 100 },
                }));
                break;
        }
    }

    const doc = new Document({
        numbering: {
            config: [{
                reference: "default-numbering",
                levels: [{
                    level: 0,
                    format: "decimal" as const,
                    text: "%1.",
                    alignment: AlignmentType.LEFT,
                }],
            }],
        },
        sections: [{ children }],
    });

    return Buffer.from(await Packer.toBuffer(doc));
}



function drawPdfTable(doc: PDFKit.PDFDocument, rows: string[][]) {
    const colCount = Math.max(...rows.map(r => r.length));
    const pageWidth = 535 - 60; // usable width (page - margins)
    const colWidth = pageWidth / colCount;
    const startX = 60;
    const cellPadding = 6;
    const fontSize = 9;

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        const isHeader = rowIdx === 0;

    
        let maxHeight = 20;
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
            const cellText = stripInlineMarkdown(row[colIdx] ?? "");
            const textWidth = colWidth - cellPadding * 2;
            const textHeight = doc.fontSize(fontSize).font(isHeader ? "Helvetica-Bold" : "Helvetica")
                .heightOfString(cellText, { width: textWidth }) + cellPadding * 2;
            if (textHeight > maxHeight) maxHeight = textHeight;
        }

    
        if (doc.y + maxHeight > 760) {
            doc.addPage();
        }

        const rowY = doc.y;

    
        if (isHeader) {
            doc.rect(startX, rowY, pageWidth, maxHeight).fill("#E8E8E8").fillColor("black");
        }

    
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
            const cellText = stripInlineMarkdown(row[colIdx] ?? "");
            const cellX = startX + colIdx * colWidth;


            doc.rect(cellX, rowY, colWidth, maxHeight).strokeColor("#CCCCCC").stroke();


            doc.fontSize(fontSize)
                .font(isHeader ? "Helvetica-Bold" : "Helvetica")
                .fillColor("black")
                .text(cellText, cellX + cellPadding, rowY + cellPadding, {
                    width: colWidth - cellPadding * 2,
                    height: maxHeight - cellPadding * 2,
                });
        }


        doc.y = rowY + maxHeight;
        doc.x = startX;
    }

    doc.moveDown(0.5);
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


        doc.fontSize(20).font("Helvetica-Bold").text(title, { align: "left" });
        doc.moveDown(0.5);
        doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#cccccc").stroke();
        doc.moveDown(0.8);

        for (const block of blocks) {
            const plain = stripInlineMarkdown(block.text);

            switch (block.type) {
                case "h1":
                    doc.moveDown(0.3);
                    doc.fontSize(16).font("Helvetica-Bold").text(plain);
                    doc.moveDown(0.2);
                    break;
                case "h2":
                    doc.moveDown(0.2);
                    doc.fontSize(14).font("Helvetica-Bold").text(plain);
                    doc.moveDown(0.2);
                    break;
                case "h3":
                    doc.moveDown(0.1);
                    doc.fontSize(12).font("Helvetica-Bold").text(plain);
                    doc.moveDown(0.1);
                    break;
                case "bullet":
                    doc.fontSize(11).font("Helvetica").text(`  •  ${plain}`, { indent: 10 });
                    break;
                case "numbered":
                    doc.fontSize(11).font("Helvetica").text(`     ${plain}`, { indent: 10 });
                    break;
                case "code":
                    doc.moveDown(0.2);
                    for (const codeLine of (block.items ?? [])) {
                        doc.fontSize(9).font("Courier").text(codeLine || " ", { indent: 20 });
                    }
                    doc.moveDown(0.2);
                    break;
                case "hr":
                    doc.moveDown(0.3);
                    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#cccccc").stroke();
                    doc.moveDown(0.3);
                    break;
                case "table":
                    if (block.tableRows && block.tableRows.length > 0) {
                        doc.moveDown(0.3);
                        drawPdfTable(doc, block.tableRows);
                    }
                    break;
                case "paragraph":
                default:
                    doc.fontSize(11).font("Helvetica").text(plain, { align: "left", lineGap: 3 });
                    doc.moveDown(0.3);
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

        if (!["docx", "pdf"].includes(format)) {
            return NextResponse.json({ error: "Format must be 'docx' or 'pdf'." }, { status: 400 });
        }

        const safeTitle = title.replace(/[^a-zA-Z0-9\s_-]/g, "").substring(0, 60) || "Document";

        if (format === "docx") {
            const buffer = await generateDocx(content, safeTitle);
            return new NextResponse(new Uint8Array(buffer), {
                status: 200,
                headers: {
                    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "Content-Disposition": `attachment; filename="${safeTitle}.docx"`,
                },
            });
        } else {
            const buffer = await generatePdf(content, safeTitle);
            return new NextResponse(new Uint8Array(buffer), {
                status: 200,
                headers: {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
                },
            });
        }
    } catch (error) {
        console.error("[Export] Error:", error);
        return NextResponse.json({ error: "Export failed." }, { status: 500 });
    }
}
