"""tiny-voca through onnxruntime, with dizione for text to phonemes. Heavy imports stay inside load()."""
import os

SAMPLE_RATE = 24000
VOICES = {"F2": 0, "M2": 1}
MODEL_NAME = "tiny-voca"
# The graph reads at most 512 tokens (32 s) per call.
MAX_TOKENS = 500
GAP_SECONDS = 0.12
PEAK = 0.99


class Engine:
    """synthesize(sentence, voice) returns 16-bit little-endian mono PCM at 24 kHz, followed by a short gap."""

    model = MODEL_NAME
    sample_rate = SAMPLE_RATE

    def __init__(self, session, phonemize, np):
        self._session = session
        self._phonemize = phonemize
        self._np = np

    @classmethod
    def load(cls, model_dir: str, overrides_path: str | None = None) -> "Engine":
        # dizione reads both variables when it first loads its data, so set them before it is imported.
        os.environ["DIZIONE_DATA"] = os.path.join(model_dir, "phonemizer")
        if overrides_path:
            os.environ["DIZIONE_OVERRIDES"] = overrides_path
        else:
            os.environ.pop("DIZIONE_OVERRIDES", None)
        import numpy as np
        import onnxruntime as ort
        import dizione

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(os.path.join(model_dir, "onnx", "model.onnx"), options, providers=["CPUExecutionProvider"])
        engine = cls(session, dizione.phonemize, np)
        engine.synthesize("Warm up.", "M2")
        return engine

    def _run(self, sentence: str, voice: int):
        np = self._np
        phones = self._phonemize(sentence)
        if len(phones.ids) > MAX_TOKENS:
            words = sentence.split(" ")
            if len(words) < 2:
                raise ValueError("sentence_too_long")
            middle = len(words) // 2
            first = " ".join(words[:middle]).rstrip(",;:.") + ","
            return np.concatenate([self._run(first, voice), self._run(" ".join(words[middle:]), voice)])
        audio = self._session.run(None, {
            "tokens": np.array([phones.ids], dtype=np.int64),
            "stress": np.array([phones.stress], dtype=np.int64),
            "voice": np.array([voice], dtype=np.int64),
            "speed": np.array([1.0], dtype=np.float32),
            "pitch_shift": np.array([0.0], dtype=np.float32),
            "pitch_range": np.array([1.0], dtype=np.float32),
        })[0][0]
        return audio

    def synthesize(self, sentence: str, voice: str) -> bytes:
        np = self._np
        audio = self._run(sentence, VOICES[voice])
        # The model can peak above 1.0 (about one sentence in twenty).
        peak = float(np.abs(audio).max()) if audio.size else 0.0
        if peak > PEAK:
            audio = audio * (PEAK / peak)
        gap = np.zeros(int(SAMPLE_RATE * GAP_SECONDS), dtype=np.float32)
        pcm = (np.concatenate([audio, gap]) * 32767.0).astype("<i2")
        return pcm.tobytes()
