"""Text preparation for the speech service. Pure functions, standard library only."""
import re

# Memory per call grows faster than length: on the box 150 characters peaked at 171 MB and 300 at 284 MB,
# and the arena keeps the peak, so long pieces push the service past its 220 MB MemoryHigh.
MAX_SENTENCE_CHARS = 150
# More than this share of letters outside A-Z means the text is not English the model can read.
MAX_NON_ASCII_LETTER_SHARE = 0.15

# A full stop after these (or after a single capital, as in initials) does not end a sentence.
ABBREVIATIONS = {
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "mt", "vs", "etc", "inc", "ltd", "co", "no",
    "e.g", "i.e", "a.m", "p.m", "approx", "dept", "est", "fig", "gen", "col", "capt", "lt", "sgt",
}

_FENCE = re.compile(r"```.*?```", re.S)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍⃣]")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BOUNDARY = re.compile(r"(?<=[.!?])\s+")


class UnsupportedText(Exception):
    """The text cannot be read by the local voice (not English, or nothing to say)."""


def clean(text: str) -> str:
    text = _FENCE.sub(" ", text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _URL.sub("link", text)
    text = _EMOJI.sub("", text)
    text = _CONTROL.sub(" ", text)
    return text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')


def is_english(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return any(c.isdigit() for c in text)
    outside = sum(1 for c in letters if not ("a" <= c.lower() <= "z"))
    return outside / len(letters) <= MAX_NON_ASCII_LETTER_SHARE


def _ends_with_abbreviation(piece: str) -> bool:
    last = piece.rstrip().rsplit(None, 1)[-1] if piece.strip() else ""
    word = last.rstrip(".!?").lower()
    if not last.endswith("."):
        return False
    return word in ABBREVIATIONS or (len(word) == 1 and word.isalpha())


def _split_long(sentence: str, limit: int) -> list[str]:
    parts: list[str] = []
    rest = sentence
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "))
        if cut < limit * 0.4:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit
        parts.append(rest[: cut + 1].strip())
        rest = rest[cut + 1:].strip()
    if rest:
        parts.append(rest)
    return parts


def _finish(sentence: str) -> str:
    sentence = sentence.strip()
    if not sentence:
        return ""
    # The model clips the last word when the utterance has no closing mark.
    if sentence[-1] in ",;:":
        return sentence[:-1].rstrip() + "."
    if sentence[-1] not in ".!?":
        return sentence + "."
    return sentence


def split_sentences(text: str, limit: int = MAX_SENTENCE_CHARS) -> list[str]:
    sentences: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        current = ""
        for piece in _BOUNDARY.split(line):
            current = f"{current} {piece}".strip() if current else piece
            if _ends_with_abbreviation(current):
                continue
            sentences.extend(_split_long(current, limit))
            current = ""
        if current:
            sentences.extend(_split_long(current, limit))
    prepared = [_finish(s) for s in sentences]
    return [s for s in prepared if re.search(r"[A-Za-z0-9]", s)]


def prepare(text: str, limit: int = MAX_SENTENCE_CHARS) -> list[str]:
    """Returns the sentences to speak, or raises UnsupportedText."""
    cleaned = clean(text)
    if not is_english(cleaned):
        raise UnsupportedText("not_english")
    sentences = split_sentences(cleaned, limit)
    if not sentences:
        raise UnsupportedText("nothing_to_say")
    return sentences
