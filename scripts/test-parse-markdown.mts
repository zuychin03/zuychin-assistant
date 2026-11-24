// Offline checks for the parse-model converter (V8 Decision 22): tags, reading order, tables and empty output.
import assert from "node:assert/strict";
import { parseOutputToMarkdown, tabularToMarkdown } from "../src/lib/capture/extract/parse-markdown";

let checks = 0;
function check(name: string, run: () => void) {
    run();
    checks++;
    console.log(`PASS ${name}`);
}

const block = (x: number, y: number, content: string, kind: string) => `<x_${x}><y_${y}>${content}<x_${x + 0.4}><y_${y + 0.02}><class_${kind}>`;

check("blocks come out in reading order: top to bottom, then left to right", () => {
    const raw = [block(0.55, 0.3, "Right column", "Text"), block(0.1, 0.1, "**Invoice 1042**", "Title"), block(0.1, 0.3, "Left column", "Text")].join("");
    assert.equal(parseOutputToMarkdown(raw), "# Invoice 1042\n\nLeft column\n\nRight column");
});

check("headings lose their bold, page furniture and pictures are dropped", () => {
    const raw = [
        block(0.1, 0.01, "Acme Pty Ltd", "Page-header"), block(0.1, 0.1, "**Payment terms**", "Section-header"),
        block(0.1, 0.2, "", "Picture"), block(0.1, 0.3, "Pay within 14 days.", "Text"), block(0.45, 0.97, "Page 2 of 3", "Page-footer"),
    ].join("");
    assert.equal(parseOutputToMarkdown(raw), "## Payment terms\n\nPay within 14 days.");
    // Seen live on 24/11/2026: the heading text already carried its own Markdown marker.
    assert.equal(parseOutputToMarkdown(block(0.1, 0.1, "## What to prepare", "Section-header") + block(0.1, 0.2, "# **Notice**", "Title")), "## What to prepare\n\n# Notice");
});

check("list items stay one list and keep their own markers", () => {
    const raw = [block(0.1, 0.1, "Milk", "List-item"), block(0.1, 0.12, "• Bread", "List-item"), block(0.1, 0.14, "3) Eggs", "List-item"), block(0.1, 0.3, "Shop on Friday.", "Text")].join("");
    assert.equal(parseOutputToMarkdown(raw), "- Milk\n- Bread\n3) Eggs\n\nShop on Friday.");
});

check("formulas become display maths without doubled dollar signs", () => {
    assert.equal(parseOutputToMarkdown(block(0.1, 0.1, "$$E = mc^2$$", "Formula")), "$$\nE = mc^2\n$$");
});

check("a LaTeX table becomes a Markdown table with spans, escapes and pipes handled", () => {
    const latex = "\\begin{tabular}{|l|l|r|}\\hline \\textbf{Item} & \\textbf{Due} & \\textbf{Cost} \\\\ \\hline Rent & 1 Dec & \\$450 \\\\ Power \\& gas & 5 Dec & 12\\% \\\\ a|b & \\multicolumn{2}{c}{Waived} \\\\ \\hline \\end{tabular}";
    assert.equal(tabularToMarkdown(latex), [
        "| Item | Due | Cost |", "| --- | --- | --- |", "| Rent | 1 Dec | $450 |", "| Power & gas | 5 Dec | 12% |", "| a\\|b | Waived |   |",
    ].join("\n"));
    assert.match(parseOutputToMarkdown(block(0.1, 0.4, latex, "Table")), /^\| Item \| Due \| Cost \|/);
});

check("short rows are padded to the widest row", () => {
    assert.equal(tabularToMarkdown("\\begin{tabular}{ll} A & B \\\\ only \\\\ \\end{tabular}"), "| A | B |\n| --- | --- |\n| only |   |");
});

check("a table block without usable rows keeps its raw text instead of vanishing", () => {
    assert.equal(tabularToMarkdown("\\begin{tabular}{c} \\hline \\end{tabular}"), null);
    assert.equal(parseOutputToMarkdown(block(0.1, 0.1, "Totals shown on the next page", "Table")), "Totals shown on the next page");
});

check("empty and untagged output", () => {
    assert.equal(parseOutputToMarkdown(""), "");
    assert.equal(parseOutputToMarkdown("   \n\n  "), "");
    assert.equal(parseOutputToMarkdown(block(0.1, 0.1, "   ", "Text")), "");
    assert.equal(parseOutputToMarkdown("Plain words <class_Text> with\n\n\n\nstray tags <y_0.4>"), "Plain words  with\n\nstray tags");
});

console.log(`\n${checks} parse converter checks passed.`);
