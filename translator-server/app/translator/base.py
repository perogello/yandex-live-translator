from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class TranslationResult:
    translation: str
    backend: str
    model: str


class Translator(ABC):
    backend_name: str
    model_name: str

    @abstractmethod
    async def translate(
        self,
        text: str,
        source_lang: str = "en",
        target_lang: str = "ru",
        model: str | None = None,
        profile: str | None = None,
        prompt_style: str | None = None,
    ) -> TranslationResult:
        raise NotImplementedError

    async def health(self) -> dict:
        return {
            "available": True,
            "backend": self.backend_name,
            "model": self.model_name,
        }

    async def warmup(self, text: str = "Hello, welcome to the keynote.") -> None:
        await self.translate(text)

    def reset_context(self) -> None:
        return
