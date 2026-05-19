from __future__ import annotations

from difflib import SequenceMatcher
from typing import Tuple

from cachetools import LRUCache


class TranslationCache:
    def __init__(self, maxsize: int):
        self._cache = LRUCache(maxsize=maxsize)

    def get(self, key: str) -> str | None:
        return self._cache.get(key)

    def set(self, key: str, value: str) -> None:
        self._cache[key] = value

    def find_similar(
        self,
        key_prefix: str,
        text: str,
        threshold: float = 0.85,
        min_words: int = 6,
        scan_limit: int = 64,
    ) -> Tuple[str, float, str] | None:
        # Return (translation, similarity_ratio, matched_source_text) when a
        # recently-cached EN text is a safe "near-duplicate" of `text`.
        #
        # Three gates must pass:
        #   1. Word-sequence similarity (difflib) >= `threshold`.
        #   2. New text introduces no content-bearing word that the cached
        #      text did not already contain — OR — the single new word is a
        #      character-level typo of a single missing word from the cached
        #      text (e.g., ASR "tacking" -> "tracking").
        #   3. Stop words (and/or/the/...) are ignored in gate 2 so trailing
        #      "and we" etc. don't block legitimate matches.
        #
        # Without these gates, "next week" and "next year" share ~0.90
        # similarity and the cache would silently return the wrong
        # translation for a sentence whose subject literally changed. The
        # typo carve-out lets us reuse a translation when Yandex re-emits
        # the same fragment with a single corrected word.
        if not text or threshold <= 0.0:
            return None
        new_words = text.lower().split()
        if len(new_words) < min_words:
            return None
        new_set = set(new_words)
        prefix_len = len(key_prefix)
        best_ratio = 0.0
        best_value: str | None = None
        best_source: str = ""
        scanned = 0
        for key, value in list(self._cache.items()):
            if scanned >= scan_limit:
                break
            if not key.startswith(key_prefix):
                continue
            cached_text = key[prefix_len:]
            cached_words = cached_text.lower().split()
            if len(cached_words) < min_words:
                continue
            scanned += 1
            ratio = SequenceMatcher(None, new_words, cached_words).ratio()
            if ratio < threshold or ratio <= best_ratio:
                continue
            cached_set = set(cached_words)
            extra_in_new = new_set - cached_set - _STOP_WORDS
            extra_in_cached = cached_set - new_set - _STOP_WORDS
            if extra_in_new:
                if len(extra_in_new) > 1 or len(extra_in_cached) != 1:
                    continue
                new_word = next(iter(extra_in_new))
                cached_word = next(iter(extra_in_cached))
                char_sim = SequenceMatcher(None, new_word, cached_word).ratio()
                if char_sim < 0.7:
                    continue
            best_ratio = ratio
            best_value = value
            best_source = cached_text
            if ratio >= 0.97:
                break
        if best_value is None:
            return None
        return (best_value, best_ratio, best_source)


_STOP_WORDS = frozenset(
    # Ultra-conservative stop list: articles, conjunctions, plain prepositions.
    # NOT modals (may, might, will, can) — they can be content. NOT pronouns
    # — they can identify the subject. NOT demonstratives (this, that) — they
    # can carry meaning. The point is to ignore "and", "the", "of" so that a
    # purely cosmetic trailing word doesn't block a true sliding-window match,
    # while still flagging real content changes like "May" -> "June".
    "a an the and or but of to in on at by as for with from into onto "
    "over under via during about between among through across".split()
)
