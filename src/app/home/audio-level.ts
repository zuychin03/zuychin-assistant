// Speech sits roughly between -48 dBFS (quiet room) and -12 dBFS (close, loud); this span maps to 0..1.
const FLOOR_DB = -48;
const SPAN_DB = 36;

/** Returns a reader for the analyser's current loudness, 0 (silence) to 1 (loud speech). */
export function levelMeter(analyser: AnalyserNode): () => number {
    const samples = new Float32Array(analyser.fftSize);
    return () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        if (rms <= 0) return 0;
        return Math.min(1, Math.max(0, (20 * Math.log10(rms) - FLOOR_DB) / SPAN_DB));
    };
}
