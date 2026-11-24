// 16-bit PCM and WAV helpers shared by speech out, speech in and their probes.

export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

export interface ParsedWav {
    pcm: Buffer;
    sampleRate: number;
    channels: number;
}

/** 16-bit PCM WAV only; walks the chunks so extra chunks (LIST, fact) before "data" are skipped. */
export function parseWav(bytes: Buffer): ParsedWav | null {
    if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12, sampleRate = 0, channels = 0, bits = 0, format = 0;
    while (offset + 8 <= bytes.length) {
        const id = bytes.toString("ascii", offset, offset + 4);
        // Streamed WAVs may carry 0 or 0xFFFFFFFF as the data size; the rest of the file is then the data.
        let size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === "fmt " && start + 16 <= bytes.length) {
            format = bytes.readUInt16LE(start);
            channels = bytes.readUInt16LE(start + 2);
            sampleRate = bytes.readUInt32LE(start + 4);
            bits = bytes.readUInt16LE(start + 14);
        } else if (id === "data") {
            if (size === 0 || size === 0xffffffff || start + size > bytes.length) size = bytes.length - start;
            // 0xFFFE is WAVE_FORMAT_EXTENSIBLE, which carries the same PCM samples.
            if ((format !== 1 && format !== 0xfffe) || bits !== 16 || !sampleRate || !channels) return null;
            const length = size - (size % (2 * channels));
            return { pcm: bytes.subarray(start, start + length), sampleRate, channels };
        }
        offset = start + size + (size % 2);
    }
    return null;
}

/** Sample rate from a content type such as "audio/pcm;rate=44100" or "audio/L16; rate=24000". */
export function rateFromContentType(contentType: string | null): number | null {
    const match = contentType ? /rate=(\d+)/i.exec(contentType) : null;
    const rate = match ? Number(match[1]) : NaN;
    return Number.isInteger(rate) && rate >= 8000 && rate <= 192000 ? rate : null;
}

/** Mixes interleaved 16-bit channels down to mono. */
export function toMono(pcm: Buffer, channels: number): Buffer {
    if (channels <= 1) return pcm;
    const frames = Math.floor(pcm.length / (2 * channels));
    const out = Buffer.alloc(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) sum += pcm.readInt16LE((frame * channels + channel) * 2);
        out.writeInt16LE(Math.round(sum / channels), frame * 2);
    }
    return out;
}

/** Root mean square of 16-bit mono samples, 0 to 32768. */
export function pcmRms(pcm: Buffer): number {
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return 0;
    let sum = 0;
    for (let index = 0; index < samples; index++) {
        const value = pcm.readInt16LE(index * 2);
        sum += value * value;
    }
    return Math.sqrt(sum / samples);
}

export function pcmSeconds(pcm: Buffer, sampleRate: number): number {
    return sampleRate ? pcm.length / 2 / sampleRate : 0;
}
