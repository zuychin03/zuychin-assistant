# Text-to-speech service

A small local service that speaks Assistant replies with [tiny-voca](https://huggingface.co/n4ze3m/tiny-voca) (voice M2 by default, F2 also available). It runs beside the app, answers on loopback only, and is never exposed through the tunnel. Gemini TTS stays as the fallback in the app.

- Model: tiny-voca, 4.5M parameters, fp32 ONNX, English only, two American voices, 24 kHz mono. Apache-2.0.
- Text to phonemes: [dizione](https://github.com/n4ze3m/dizione) (Apache-2.0), pinned to one commit. It reads numbers, dates, money and abbreviations, and guesses unknown words.
- Runtime: Python 3.12 with `onnxruntime` and `numpy`, one thread.
- Measured on the 1 GB, 2 vCPU target box: first audio about 0.45 s for an 80-character sentence, real-time factor about 0.10 to 0.15, about 130 MB loaded and under 180 MB at peak with the sentence limits below.

## API

`GET /health` needs no token and returns `{ ok, model, loaded, busy, waiting }`.

`POST /speak` needs `Authorization: Bearer <TTS_TOKEN>` and `Content-Type: application/json`:

```json
{ "text": "Sure, it is booked for Thursday at three pm.", "voice": "M2" }
```

The response is `200` with a chunked `application/octet-stream` body of 16-bit little-endian mono PCM at 24 kHz (`X-Sample-Rate: 24000`, `X-Voice: M2`). The service speaks one sentence at a time and writes each as soon as it is ready, with 120 ms of silence after each. Headers are sent only once the first sentence is ready, so a failure before any audio is a normal error status.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_body`, `empty`, `bad_voice` | Invalid request |
| 401 | `unauthorised` | Missing or wrong token |
| 413 | `too_long`, `too_large` | Over 2,500 characters, or a body over 16 KB |
| 415 | `content_type` | Not JSON |
| 422 | `unsupported_text` | Not English (more than 15% of letters outside A to Z), or nothing readable |
| 503 | `busy`, `queue_timeout`, `loading`, `time_limit` | One synthesis runs at a time with 2 waiting; the model may still be loading; 90 s cap |
| 500 | `synth_failed` | The model failed before the first chunk |

Text preparation: URLs are spoken as "link", emoji and code fences are dropped, lines become sentences, titles such as "Dr." do not end a sentence, sentences over 150 characters are cut at a comma (or a space), a piece that still reads as more than 140 tokens is cut in half, and a closing full stop is added when missing. The limits keep memory low: it grows faster than sentence length (on the box, 171 MB at peak for 150 characters, 284 MB for 300), and the runtime keeps the highest peak until the service exits.

Logs are one JSON line per request with sizes and timings. They never hold text.

## Settings

| Name | Default | Purpose |
|---|---|---|
| `TTS_TOKEN` | required, 32 or more characters | Bearer token the app sends |
| `TTS_MODEL_DIR` | required | Folder with `onnx/model.onnx` and `phonemizer/` from the tiny-voca repository |
| `TTS_PORT` | 3011 | Loopback port (ignored under systemd socket activation) |
| `TTS_OVERRIDES` | none | Pronunciation list, one word per line (see `overrides.example.txt`). Keep your own copy outside the repository |
| `TTS_IDLE_EXIT_SEC` | 900 | With socket activation only: exit after this long without a request, handing the memory back |

## Tests

```bash
python -m unittest discover -s tts-service/tests -t tts-service
```

These use a fake engine, so they need only the standard library. `tests/test_parity.py` needs the real model and is skipped unless `TTS_MODEL_DIR` is set. It checks that dizione still turns 30 fixed sentences into the same phonemes (`tests/golden_tokens.json`), so a change to the dizione commit or the data is caught. After a deliberate change, listen to the new output and regenerate the file.

## Run locally

```bash
pip install -r tts-service/requirements.txt "git+https://github.com/n4ze3m/dizione@8cd889e4de7be6bd1dd2e6891344a0729fa14dd4"
TTS_TOKEN=<32+ characters> TTS_MODEL_DIR=/path/to/tiny-voca python tts-service/server.py
```
