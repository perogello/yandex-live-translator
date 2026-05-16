from __future__ import annotations

from app.config import AppConfig
from app.translator.base import Translator
from app.translator.mock import MockTranslator
from app.translator.ollama import OllamaTranslator
from app.translator.opus_ct2 import Ct2OpusTranslator


def create_translator(config: AppConfig) -> Translator:
    backend = config.translation.backend
    if backend == "ollama":
        return OllamaTranslator(config.ollama)
    if backend == "ct2_opus":
        return Ct2OpusTranslator(config.ct2_opus)
    if backend == "mock":
        return MockTranslator()
    if backend == "ct2_m2m":
        raise RuntimeError("ct2_m2m backend is reserved for future implementation")
    raise RuntimeError(f"Unsupported backend: {backend}")
