// Read-only probes for the V8 free providers (docs/V8_FREE_PROVIDERS_PLAN.md, C1). Prints status, timing and the
// shape of each answer (keys, types, sizes), never keys or full payloads. Synthetic inputs only.
//
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud catalogue
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud embed bge-m3
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud chat Mistral-Small-3.2-24B-Instruct-2506
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud speech nvr-tts-en-us [English-US.Female-1]
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud transcribe whisper-large-v3-turbo [audio.wav]
//   npx tsx --env-file=.env.local scripts/provider-probe.mts ovhcloud post /api/v1/systemone <body.json>
// In Git Bash, set MSYS_NO_PATHCONV=1 so `/api/...` arguments are not rewritten as Windows paths.
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare accounts|search
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare run <@cf/model> <body.json>
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare embed <@cf/model>
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare form <@cf/model> prompt=... width=512 height=512
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare speak <@cf/model> <out.wav> [speaker]
//   npx tsx --env-file=.env.local scripts/provider-probe.mts cloudflare transcribe <@cf/model> <audio file> [language]
//   npx tsx --env-file=.env.local scripts/provider-probe.mts same-space <@cf/model> <ovhcloud-model>
//   npx tsx --env-file=.env.local scripts/provider-probe.mts llamaparse parse [file.pdf|-] [fast|cost_effective|agentic]
//   npx tsx --env-file=.env.local scripts/provider-probe.mts llamaparse get <path>
//   npx tsx --env-file=.env.local scripts/provider-probe.mts llamaparse post <path> <body.json>
import { readFileSync, writeFileSync } from "node:fs";

const OVH_BASE = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
const OVH_CATALOGUE = "https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2";
const CF_API = "https://api.cloudflare.com/client/v4";
const BASES: Record<string, { url: string; env: string }> = {
    llamaparse: { url: "https://api.cloud.llamaindex.ai", env: "LLAMA_CLOUD_API_KEY" },
};
const TIMEOUT_MS = 60_000;
const SAMPLE_TEXTS = [
    "The quarterly maintenance window for the shared printer is on Thursday at 3 pm in room 204.",
    "Rainfall in the valley was higher than average this spring, so the creek stayed full until December.",
];

function usage(): never {
    console.error("See the header of scripts/provider-probe.mts for the commands.");
    process.exit(2);
}

/** A compact outline of a JSON value: keys, types, array lengths and the first element, strings by length only. */
function shape(value: unknown, depth = 0): unknown {
    if (depth > 5) return "...";
    if (Array.isArray(value)) {
        if (!value.length) return "array(0)";
        if (value.every((item) => typeof item === "number")) return `number[${value.length}]`;
        return { [`array(${value.length})`]: shape(value[0], depth + 1) };
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)]));
    if (typeof value === "string") return value.length > 80 ? `string(${value.length})` : JSON.stringify(value);
    return value;
}

function cfToken(): string {
    const token = process.env.CLOUDFLARE_AI_TOKEN?.trim();
    if (!token) { console.error("Set CLOUDFLARE_AI_TOKEN in .env.local (Workers AI read and edit)."); process.exit(2); }
    return token;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; ms: number; type: string; json: unknown; bytes: number; headers: Headers }> {
    const started = performance.now();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "provider-probe", ...(init.headers ?? {}) } });
    const buffer = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    let json: unknown = null;
    if (type.includes("json")) { try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { json = null; } }
    return { status: response.status, ms: Math.round(performance.now() - started), type, json, bytes: buffer.length, headers: response.headers };
}

async function callRaw(url: string, init: RequestInit): Promise<{ status: number; ms: number; type: string; bytes: Uint8Array }> {
    const started = performance.now();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "provider-probe", ...(init.headers ?? {}) } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, ms: Math.round(performance.now() - started), type: response.headers.get("content-type") ?? "", bytes };
}

function report(label: string, result: Awaited<ReturnType<typeof call>>): void {
    console.log(`${label}: HTTP ${result.status} in ${result.ms} ms, ${result.type || "no content type"}, ${result.bytes} bytes`);
    for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after", "x-sample-rate"]) {
        const value = result.headers.get(name);
        if (value) console.log(`  ${name}: ${value}`);
    }
    if (result.json !== null) console.log(JSON.stringify(shape(result.json), null, 2));
}

function vectorOf(json: unknown, index = 0): number[] | null {
    const data = (json as { data?: { embedding?: unknown }[] } | null)?.data;
    const embedding = data?.[index]?.embedding;
    return Array.isArray(embedding) && embedding.every((n) => typeof n === "number") ? embedding as number[] : null;
}

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / Math.sqrt(na * nb);
}

async function cfAccount(token: string): Promise<string> {
    const fixed = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (fixed) return fixed;
    const result = await call(`${CF_API}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    const id = (result.json as { result?: { id?: string }[] } | null)?.result?.[0]?.id;
    if (!id) { report("accounts", result); process.exit(1); }
    return id;
}

/** One second of 16 kHz mono 16-bit silence, enough to test that a transcription route answers. */
function silentWav(): Uint8Array {
    const samples = 16_000;
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
    buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16_000, 24); buffer.writeUInt32LE(32_000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
    return new Uint8Array(buffer);
}

/** A one-page PDF with a heading and a small table drawn as text rows, built by hand so no file is needed. */
function samplePdf(): Uint8Array {
    const rows = [["Room", "Device", "Status"], ["204", "Printer", "Ready"], ["310", "Scanner", "Needs toner"]];
    const lines = ["BT /F1 16 Tf 72 720 Td (Maintenance summary) Tj ET"];
    rows.forEach((row, r) => row.forEach((cell, c) => lines.push(`BT /F1 12 Tf ${72 + c * 150} ${680 - r * 22} Td (${cell}) Tj ET`)));
    const stream = lines.join("\n");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((body, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}

async function embed(base: string, model: string, headers: Record<string, string>, texts: readonly string[]) {
    return call(`${base}/embeddings`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ model, input: texts }) });
}

const [provider, action, arg1, arg2] = process.argv.slice(2);
if (!provider || !action) usage();

if (provider === "ovhcloud") {
    if (action === "catalogue") {
        const result = await call(OVH_CATALOGUE);
        console.log(`catalogue: HTTP ${result.status} in ${result.ms} ms`);
        const models = Array.isArray(result.json) ? result.json as Record<string, unknown>[] : [];
        if (!models.length) { report("catalogue", result); process.exit(1); }
        console.log(`${models.length} models. Fields of the first entry:`);
        console.log(JSON.stringify(shape(models[0]), null, 2));
        for (const model of models) {
            const meta = (model.metadata ?? {}) as Record<string, Record<string, unknown>>;
            const usage = (meta.usage_information ?? {}) as { status?: string; pricing?: { price?: number; price_unit?: string }[]; rate_limit?: { rate_limit_api_anonymous?: { rate_limit_value?: number; rate_limit_unit?: string }[] } };
            const eol = (meta.publishing_information ?? {}).model_eol_date;
            const price = usage.pricing?.map((entry) => `${entry.price}/${entry.price_unit}`).join(",");
            const anonymous = usage.rate_limit?.rate_limit_api_anonymous?.map((entry) => `${entry.rate_limit_value}/${entry.rate_limit_unit}`).join(",");
            // `name` is the id the router takes; `id` is only the catalogue slug.
            console.log(`- ${String(model.name)} | ${String(model.category_v2 ?? model.category)} | ${usage.status ?? "?"} | available ${String(model.available)} | eol ${String(eol)} | price ${price ?? "?"} | anonymous ${anonymous ?? "none"}`);
        }
    } else if (action === "embed" && arg1) {
        const result = await embed(OVH_BASE, arg1, {}, SAMPLE_TEXTS);
        report(`embed ${arg1}`, result);
        const vector = vectorOf(result.json);
        if (vector) console.log(`dimension ${vector.length}`);
    } else if (action === "chat" && arg1) {
        const result = await call(`${OVH_BASE}/chat/completions`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: arg1, max_tokens: 40, messages: [{ role: "user", content: "Reply with the single word: ready" }] }),
        });
        report(`chat ${arg1}`, result);
    } else if (action === "speech" && arg1) {
        const result = await call(`${OVH_BASE}/audio/speech`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: arg1, voice: arg2 ?? "English-US.Female-1", input: "The printer is ready.", response_format: "wav" }),
        });
        report(`speech ${arg1}`, result);
        if (result.status === 200 && result.json === null) {
            const header = result.bytes >= 44 ? "audio body" : "short body";
            console.log(`${header}, ${result.bytes} bytes`);
        }
    } else if (action === "transcribe" && arg1) {
        const form = new FormData();
        form.append("model", arg1);
        form.append("file", new Blob([new Uint8Array(arg2 ? readFileSync(arg2) : silentWav())], { type: "audio/wav" }), "probe.wav");
        report(`transcribe ${arg1}`, await call(`${OVH_BASE}/audio/transcriptions`, { method: "POST", body: form }));
    } else if (action === "post" && arg1 && arg2) {
        const result = await call(`${OVH_BASE.replace(/\/v1$/, "")}${arg1}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: readFileSync(arg2, "utf8") });
        report(`post ${arg1}`, result);
    } else usage();
} else if (provider === "cloudflare") {
    const token = cfToken();
    const auth = { Authorization: `Bearer ${token}` };
    if (action === "accounts") {
        const result = await call(`${CF_API}/accounts`, { headers: auth });
        console.log(`accounts: HTTP ${result.status} in ${result.ms} ms, ${(result.json as { result?: unknown[] } | null)?.result?.length ?? 0} account(s); ids not printed`);
    } else {
        const account = await cfAccount(token);
        if (action === "search") {
            const result = await call(`${CF_API}/accounts/${account}/ai/models/search?per_page=100`, { headers: auth });
            report("models search", result);
            const models = (result.json as { result?: { name?: string; task?: { name?: string } }[] } | null)?.result ?? [];
            const byTask = new Map<string, string[]>();
            for (const model of models) byTask.set(model.task?.name ?? "?", [...(byTask.get(model.task?.name ?? "?") ?? []), model.name ?? "?"]);
            for (const [task, names] of byTask) console.log(`${task} (${names.length}): ${names.join(", ")}`);
        } else if (action === "run" && arg1 && arg2) {
            const body = readFileSync(arg2, "utf8");
            const result = await call(`${CF_API}/accounts/${account}/ai/run/${arg1}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
            report(`run ${arg1}`, result);
        } else if (action === "form" && arg1) {
            const form = new FormData();
            for (const pair of process.argv.slice(5)) { const at = pair.indexOf("="); form.append(pair.slice(0, at), pair.slice(at + 1)); }
            const result = await call(`${CF_API}/accounts/${account}/ai/run/${arg1}`, { method: "POST", headers: auth, body: form });
            report(`form ${arg1}`, result);
            const image = (result.json as { result?: { image?: string } } | null)?.result?.image;
            if (image) {
                const bytes = Buffer.from(image, "base64");
                const kind = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpeg" : bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : "unknown";
                console.log(`image ${kind}, ${bytes.length} bytes`);
            }
        } else if (action === "speak" && arg1 && arg2) {
            const body = { text: "The shared printer in room two oh four is ready.", encoding: "linear16", container: "wav", ...(process.argv[6] ? { speaker: process.argv[6] } : {}) };
            const result = await callRaw(`${CF_API}/accounts/${account}/ai/run/${arg1}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
            console.log(`speak ${arg1}: HTTP ${result.status} in ${result.ms} ms, ${result.type}, ${result.bytes.length} bytes`);
            if (result.type.includes("json")) console.log(JSON.stringify(shape(JSON.parse(new TextDecoder().decode(result.bytes))), null, 2));
            else {
                writeFileSync(arg2, result.bytes);
                const wav = Buffer.from(result.bytes);
                if (wav.subarray(0, 4).toString() === "RIFF") console.log(`wav: ${wav.readUInt16LE(22)} channel(s), ${wav.readUInt32LE(24)} Hz, ${wav.readUInt16LE(34)} bit; saved to ${arg2}`);
            }
        } else if (action === "transcribe" && arg1 && arg2) {
            const audio = readFileSync(arg2).toString("base64");
            const result = await call(`${CF_API}/accounts/${account}/ai/run/${arg1}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ audio, language: process.argv[6] }) });
            report(`transcribe ${arg1}`, result);
            console.log(`text: ${(result.json as { result?: { text?: string } } | null)?.result?.text ?? "(none)"}`);
        } else if (action === "embed" && arg1) {
            const result = await embed(`${CF_API}/accounts/${account}/ai/v1`, arg1, auth, SAMPLE_TEXTS);
            report(`embed ${arg1}`, result);
            const vector = vectorOf(result.json);
            if (vector) console.log(`dimension ${vector.length}`);
        } else usage();
    }
} else if (provider === "same-space" && action && arg1) {
    const token = cfToken();
    const account = await cfAccount(token);
    const cf = await embed(`${CF_API}/accounts/${account}/ai/v1`, action, { Authorization: `Bearer ${token}` }, SAMPLE_TEXTS);
    const ovh = await embed(OVH_BASE, arg1, {}, SAMPLE_TEXTS);
    console.log(`cloudflare HTTP ${cf.status} in ${cf.ms} ms; ovhcloud HTTP ${ovh.status} in ${ovh.ms} ms`);
    for (let i = 0; i < SAMPLE_TEXTS.length; i++) {
        const a = vectorOf(cf.json, i), b = vectorOf(ovh.json, i);
        console.log(a && b ? `text ${i + 1}: dimensions ${a.length} and ${b.length}, cosine ${a.length === b.length ? cosine(a, b).toFixed(6) : "n/a"}` : `text ${i + 1}: no vector from ${a ? "ovhcloud" : "cloudflare"}`);
    }
} else if (provider === "llamaparse" && action === "parse") {
    const key = process.env.LLAMA_CLOUD_API_KEY?.trim();
    if (!key) { console.error("Set LLAMA_CLOUD_API_KEY in .env.local."); process.exit(2); }
    const auth = { Authorization: `Bearer ${key}` };
    const tier = arg2 ?? "cost_effective";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(arg1 && arg1 !== "-" ? readFileSync(arg1) : samplePdf())], { type: "application/pdf" }), "probe.pdf");
    form.append("configuration", JSON.stringify({ tier, version: "latest", disable_cache: true }));
    const started = performance.now();
    const upload = await call(`${BASES.llamaparse.url}/api/v2/parse/upload`, { method: "POST", headers: auth, body: form });
    report(`upload (${tier})`, upload);
    const id = (upload.json as { id?: string } | null)?.id;
    if (!id) process.exit(1);
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await call(`${BASES.llamaparse.url}/api/v2/parse/${id}?expand=markdown&expand=usage`, { headers: auth });
        const body = job.json as { job?: { status?: string; error_message?: string | null; usage?: { credits?: number | null } | null }; markdown?: { pages?: { markdown?: string }[] } } | null;
        const status = body?.job?.status;
        if (status === "PENDING" || status === "RUNNING") continue;
        report(`job after ${Math.round((performance.now() - started) / 1000)} s`, job);
        console.log(`status ${status}, credits ${String(body?.job?.usage?.credits)}, error ${String(body?.job?.error_message)}`);
        for (const page of body?.markdown?.pages ?? []) console.log(`--- page markdown ---\n${page.markdown ?? ""}`);
        process.exit(0);
    }
    console.log("still running after 120 s");
} else if (BASES[provider] && (action === "get" || action === "post") && arg1) {
    const key = process.env[BASES[provider].env]?.trim();
    if (!key) { console.error(`Set ${BASES[provider].env} in .env.local.`); process.exit(2); }
    const init: RequestInit = action === "post"
        ? { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: readFileSync(arg2 ?? usage(), "utf8") }
        : { headers: { Authorization: `Bearer ${key}` } };
    report(`${action} ${arg1}`, await call(`${BASES[provider].url}${arg1}`, init));
} else usage();
