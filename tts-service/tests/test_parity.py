"""Needs the real model, so it is skipped unless TTS_MODEL_DIR points at the tiny-voca files (onnx/ and phonemizer/).

Run locally after changing the dizione commit or the phonemizer data:
  TTS_MODEL_DIR=/path/to/tiny-voca python -m unittest discover -s tests -t .
"""
import json
import os
import unittest

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "")
HERE = os.path.dirname(os.path.abspath(__file__))


@unittest.skipUnless(MODEL_DIR and os.path.exists(os.path.join(MODEL_DIR, "onnx", "model.onnx")), "TTS_MODEL_DIR is not set")
class ParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine import Engine
        # No overrides: the golden file records dizione's own pronunciations.
        cls.engine = Engine.load(MODEL_DIR, None)

    def test_phonemes_match_the_golden_file(self):
        with open(os.path.join(HERE, "golden_tokens.json"), encoding="utf8") as file:
            golden = json.load(file)
        changed = []
        for text, expected in golden.items():
            got = self.engine._phonemize(text)
            if [int(x) for x in got.ids] != expected["ids"] or [int(x) for x in got.stress] != expected["stress"]:
                changed.append(text)
        self.assertEqual(changed, [], "dizione now reads these differently; check by ear, then regenerate golden_tokens.json")

    def test_a_sentence_becomes_pcm_at_24_khz(self):
        pcm = self.engine.synthesize("Hello there, this is a test.", "M2")
        self.assertEqual(len(pcm) % 2, 0)
        seconds = len(pcm) / 2 / self.engine.sample_rate
        self.assertGreater(seconds, 1.0)
        self.assertLess(seconds, 6.0)

    def test_both_voices_work(self):
        for voice in ("F2", "M2"):
            self.assertGreater(len(self.engine.synthesize("Good morning.", voice)), 10000)

    def test_a_sentence_over_the_token_limit_is_split_not_refused(self):
        sentence = " ".join(["the quick brown fox jumps over the lazy dog"] * 12) + "."
        pcm = self.engine.synthesize(sentence, "M2")
        self.assertGreater(len(pcm) / 2 / self.engine.sample_rate, 20.0)

    def test_output_never_clips(self):
        import numpy as np
        pcm = np.frombuffer(self.engine.synthesize("Wow! That is loud.", "F2"), dtype="<i2")
        self.assertLessEqual(int(np.abs(pcm).max()), 32767 * 0.995)


if __name__ == "__main__":
    unittest.main()
