// Shared by the Capture page (browser) and the server, so this module has no imports.

export const RECORDING_SAMPLE_RATE = 16000;
/** Three minutes of 16 kHz 16-bit mono PCM is 5,760,000 bytes, one request each (V8 Decision 18). */
export const RECORDING_PIECE_SECONDS = 180;
export const RECORDING_PIECE_BYTES = RECORDING_PIECE_SECONDS * RECORDING_SAMPLE_RATE * 2;
export const RECORDING_MAX_SECONDS = 2 * 60 * 60;
/** The file the browser decodes; a two-hour recording at 128 kbps is about 115 MB. */
export const RECORDING_MAX_FILE_BYTES = 300 * 1024 * 1024;
/** Telegram voice notes and Discord voice messages up to this length go through the voice note path. */
export const LONG_AUDIO_SECONDS = 300;
/** The most a capture holds (SOURCE_TEXT_MAX in src/lib/capture/service.ts). */
export const CAPTURE_TEXT_MAX = 120_000;

/** "47 min", or seconds under a minute. */
export function durationLabel(seconds: number): string {
    return seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
}
