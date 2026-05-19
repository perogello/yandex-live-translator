from __future__ import annotations

from cachetools import LRUCache


class TranslationCache:
    def __init__(self, maxsize: int):
        self._cache = LRUCache(maxsize=maxsize)

    def get(self, key: str) -> str | None:
        return self._cache.get(key)

    def set(self, key: str, value: str) -> None:
        self._cache[key] = value
