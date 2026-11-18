import importlib.util
import unittest
from types import SimpleNamespace

from engine import MAX_TOKENS, Engine


class FakeSession:
    def __init__(self, np):
        self.np = np
        self.calls = []

    def run(self, _outputs, inputs):
        count = len(inputs["tokens"][0])
        self.calls.append(count)
        return [self.np.zeros((1, count), dtype=self.np.float32)]


def one_token_per_character(sentence):
    return SimpleNamespace(ids=[1] * len(sentence), stress=[0] * len(sentence))


@unittest.skipUnless(importlib.util.find_spec("numpy"), "needs numpy")
class TokenLimitTests(unittest.TestCase):
    def setUp(self):
        import numpy as np

        self.session = FakeSession(np)
        self.engine = Engine(self.session, one_token_per_character, np)

    def test_a_short_sentence_is_one_call(self):
        self.engine.synthesize("Sure, it is booked for Thursday.", "M2")
        self.assertEqual(self.session.calls, [32])

    def test_a_sentence_over_the_token_limit_is_split(self):
        sentence = " ".join(["twelve"] * 60) + "."
        self.engine.synthesize(sentence, "M2")
        self.assertGreater(len(self.session.calls), 1)
        self.assertTrue(all(count <= MAX_TOKENS for count in self.session.calls), self.session.calls)


if __name__ == "__main__":
    unittest.main()
