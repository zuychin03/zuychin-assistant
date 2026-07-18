import { createHash } from "node:crypto";
import type { KnowledgeChunk } from "@/lib/knowledge/types";

interface Block {
    headingPath: string[];
    text: string;
    tokens: number;
}

export interface ChunkOptions {
    targetTokens?: number;
    overlapTokens?: number;
    maxTokens?: number;
}

function digest(value: string): string {
    return createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
}

export function estimateTokens(value: string): number {
    const words = value.trim().match(/[\p{L}\p{N}_]+|[^\s]/gu)?.length ?? 0;
    return Math.max(1, Math.ceil(words * 1.15));
}

function markdownBody(markdown: string): string {
    const normalized = markdown.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return normalized;
    const end = normalized.indexOf("\n---\n", 4);
    return end === -1 ? normalized : normalized.slice(end + 5);
}

function blocksFromMarkdown(markdown: string): Block[] {
    const lines = markdownBody(markdown).split("\n");
    const headings: string[] = [];
    const blocks: Block[] = [];
    let buffer: string[] = [];
    let inFence = false;

    const flush = () => {
        const text = buffer.join("\n").trim();
        if (text) blocks.push({ headingPath: [...headings], text, tokens: estimateTokens(text) });
        buffer = [];
    };

    for (const line of lines) {
        const heading = !inFence ? line.match(/^(#{1,6})\s+(.+)$/) : null;
        if (heading) {
            flush();
            const level = heading[1].length;
            headings.splice(level - 1);
            headings[level - 1] = heading[2].trim();
            continue;
        }

        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            buffer.push(line);
            continue;
        }

        if (!inFence && line.trim() === "") {
            flush();
            continue;
        }
        buffer.push(line);
    }
    flush();
    return blocks;
}

function splitOversizedBlock(block: Block, maxTokens: number): Block[] {
    if (block.tokens <= maxTokens || block.text.includes("```")) return [block];
    const sentences = block.text.split(/(?<=[.!?])\s+/);
    const parts: Block[] = [];
    let current = "";
    for (const sentence of sentences) {
        const candidate = current ? `${current} ${sentence}` : sentence;
        if (current && estimateTokens(candidate) > maxTokens) {
            parts.push({ ...block, text: current, tokens: estimateTokens(current) });
            current = sentence;
        } else {
            current = candidate;
        }
    }
    if (current) parts.push({ ...block, text: current, tokens: estimateTokens(current) });
    return parts;
}

export function chunkMarkdown(params: {
    documentId: string;
    path: string;
    markdown: string;
    options?: ChunkOptions;
}): KnowledgeChunk[] {
    const targetTokens = params.options?.targetTokens ?? 256;
    const overlapTokens = params.options?.overlapTokens ?? 40;
    const maxTokens = params.options?.maxTokens ?? 420;
    const sourceBlocks = blocksFromMarkdown(params.markdown)
        .flatMap((block) => splitOversizedBlock(block, maxTokens));
    const chunks: KnowledgeChunk[] = [];
    let packed: Block[] = [];
    let packedTokens = 0;

    const emit = () => {
        if (!packed.length) return;
        const headingPath = packed[0].headingPath;
        const content = packed.map((block) => block.text).join("\n\n");
        const ordinal = chunks.length;
        const contentHash = digest(content);
        chunks.push({
            id: `${params.documentId}:${ordinal}:${contentHash.slice(0, 12)}`,
            documentId: params.documentId,
            path: params.path,
            heading: headingPath.at(-1) ?? "",
            headingPath,
            ordinal,
            content,
            contentHash,
            tokenCount: estimateTokens(content),
        });

        const overlap: Block[] = [];
        let tokens = 0;
        for (let index = packed.length - 1; index >= 0; index--) {
            const block = packed[index];
            if (tokens && tokens + block.tokens > overlapTokens) break;
            overlap.unshift(block);
            tokens += block.tokens;
            if (tokens >= overlapTokens) break;
        }
        packed = overlap;
        packedTokens = tokens;
    };

    for (const block of sourceBlocks) {
        const headingChanged = packed.length > 0
            && packed[0].headingPath.join("\n") !== block.headingPath.join("\n");
        if (packed.length && (packedTokens + block.tokens > targetTokens || headingChanged)) emit();
        packed.push(block);
        packedTokens += block.tokens;
        if (packedTokens >= maxTokens) emit();
    }
    emit();

    return chunks.filter((chunk, index) => index === 0 || chunk.content !== chunks[index - 1].content);
}
