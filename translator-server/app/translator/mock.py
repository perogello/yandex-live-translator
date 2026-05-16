from __future__ import annotations

from app.translator.base import TranslationResult, Translator


class MockTranslator(Translator):
    backend_name = "mock"
    model_name = "mock"

    async def translate(
        self,
        text: str,
        source_lang: str = "en",
        target_lang: str = "ru",
        model: str | None = None,
        profile: str | None = None,
        prompt_style: str | None = None,
    ) -> TranslationResult:
        return TranslationResult(
            translation=f"[mock ru] {text}",
            backend=self.backend_name,
            model=self.model_name,
        )
