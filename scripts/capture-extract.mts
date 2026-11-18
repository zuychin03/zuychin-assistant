import { readFile } from "node:fs/promises";
import { extractCapture } from "../src/lib/capture/extract/index.ts";
import type { CaptureSource } from "../src/lib/capture/types.ts";

const args = process.argv.slice(2);
const json = args.includes("--json"), target = args.find((arg) => !arg.startsWith("--"));
if (!target) {
    console.error("Usage: npx tsx scripts/capture-extract.mts <url | file.pdf> [--json]");
    process.exit(2);
}
const source: CaptureSource = /^https?:\/\//i.test(target)
    ? { kind: "link", title: "Dry run", text: "", url: target }
    : { kind: "pdf", title: "Dry run", text: "", pdf: { name: target, base64: (await readFile(target)).toString("base64") } };

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
const baseline = process.memoryUsage().rss;
let peak = baseline;
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
const started = performance.now();
const extract = await extractCapture(source);
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss);
const ms = Math.round(performance.now() - started);

if (json) {
    console.log(JSON.stringify({ ...extract, ms, rssBaselineMb: mb(baseline), rssPeakMb: mb(peak) }, null, 2));
} else {
    console.log(`${extract.status} via ${extract.method}: ${extract.words} words${extract.pages ? `, ${extract.pages} pages` : ""}${extract.truncated ? ", truncated" : ""}; ${ms} ms; RSS ${mb(baseline)} -> ${mb(peak)} MB`);
    if (extract.note) console.log(`note: ${extract.note}`);
    const meta = [extract.title, extract.author, extract.site, extract.published, extract.finalUrl].filter(Boolean);
    if (meta.length) console.log(meta.join(" | "));
    console.log("---");
    console.log(extract.text.slice(0, 700));
}
