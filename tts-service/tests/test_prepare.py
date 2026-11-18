import unittest

from prepare import UnsupportedText, clean, is_english, prepare, split_sentences


class SplitTests(unittest.TestCase):
    def test_splits_on_sentence_ends(self):
        self.assertEqual(split_sentences("One thing. Two things! Three?"), ["One thing.", "Two things!", "Three?"])

    def test_keeps_titles_and_initials_together(self):
        self.assertEqual(split_sentences("Dr. Smith replied. J. Lee agreed."), ["Dr. Smith replied.", "J. Lee agreed."])

    def test_keeps_decimals_and_times(self):
        self.assertEqual(split_sentences("It costs $12.99 at 3:30 p.m. today."), ["It costs $12.99 at 3:30 p.m. today."])

    def test_adds_a_closing_mark(self):
        self.assertEqual(split_sentences("No mark here"), ["No mark here."])

    def test_turns_a_trailing_comma_into_a_full_stop(self):
        self.assertEqual(split_sentences("Almost done,"), ["Almost done."])

    def test_lines_become_sentences(self):
        self.assertEqual(split_sentences("First item\nSecond item\n\nThird item."), ["First item.", "Second item.", "Third item."])

    def test_long_sentence_is_cut_at_a_comma(self):
        text = ("word " * 30).strip() + ", " + ("more " * 30).strip() + "."
        pieces = split_sentences(text, limit=200)
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(len(p) <= 202 for p in pieces))
        self.assertEqual(" ".join(pieces).replace(".", "").replace(",", "").split(), text.replace(".", "").replace(",", "").split())

    def test_drops_pieces_with_nothing_to_read(self):
        self.assertEqual(split_sentences("... \n--- \nReal words."), ["Real words."])


class CleanTests(unittest.TestCase):
    def test_urls_are_spoken_as_link(self):
        self.assertEqual(clean("See https://example.com/a?b=1 now"), "See link now")
        self.assertEqual(clean("Visit www.example.com."), "Visit link")

    def test_emoji_are_removed(self):
        self.assertEqual(clean("Done \U0001F389 ✅"), "Done  ")

    def test_code_fences_are_dropped_and_inline_code_kept(self):
        self.assertEqual(clean("Run `npm test` first. ```js\nconsole.log(1)\n``` Then stop.").split(), ["Run", "npm", "test", "first.", "Then", "stop."])

    def test_curly_quotes_become_plain(self):
        self.assertEqual(clean("it’s “fine”"), 'it\'s "fine"')


class EnglishTests(unittest.TestCase):
    def test_plain_english_and_numbers_pass(self):
        self.assertTrue(is_english("Your meeting is at 3:30 pm."))
        self.assertTrue(is_english("10:30"))

    def test_a_few_accents_pass(self):
        self.assertTrue(is_english("We met at the café near the station for a long chat about the plan."))

    def test_vietnamese_and_other_scripts_fail(self):
        self.assertFalse(is_english("Xin chào, hôm nay bạn khỏe không?"))
        self.assertFalse(is_english("今天天气很好"))

    def test_nothing_readable_fails(self):
        self.assertFalse(is_english("!!! ???"))


class PrepareTests(unittest.TestCase):
    def test_returns_sentences(self):
        self.assertEqual(prepare("Hello there. How are you?"), ["Hello there.", "How are you?"])

    def test_rejects_other_languages(self):
        with self.assertRaises(UnsupportedText) as caught:
            prepare("Xin chào, hôm nay bạn khỏe không?")
        self.assertEqual(str(caught.exception), "not_english")

    def test_rejects_text_with_nothing_to_say(self):
        with self.assertRaises(UnsupportedText):
            prepare("\U0001F389\U0001F389")


if __name__ == "__main__":
    unittest.main()
