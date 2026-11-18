"use strict";
const path = require("node:path");

const MODEL_NAME = "moonshine-tiny-en";

// The async variants run on the libuv pool, so /health and busy replies stay responsive during a decode.
async function loadRecognizer(modelDir, sherpa = require("sherpa-onnx-node")) {
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
            moonshine: {
                encoder: path.join(modelDir, "encoder_model.ort"),
                mergedDecoder: path.join(modelDir, "decoder_model_merged.ort"),
            },
            tokens: path.join(modelDir, "tokens.txt"),
            numThreads: 1,
            provider: "cpu",
            debug: 0,
        },
    });
    return {
        model: MODEL_NAME,
        async transcribe(samples) {
            const stream = recognizer.createStream();
            stream.acceptWaveform({ sampleRate: 16000, samples });
            await recognizer.decodeAsync(stream);
            return recognizer.getResult(stream).text.trim();
        },
    };
}

module.exports = { loadRecognizer, MODEL_NAME };
