from __future__ import annotations

from app.config import Ct2OpusConfig
from app.translator.base import TranslationResult, Translator


class Ct2OpusTranslator(Translator):
    backend_name = "ct2_opus"

    def __init__(self, config: Ct2OpusConfig):
        self.config = config
        self.model_name = config.model_path
        try:
            import ctranslate2
            from transformers import MarianTokenizer
        except ImportError as exc:
            raise RuntimeError(
                "ct2_opus requires ctranslate2, transformers and sentencepiece. "
                "Install optional dependencies from requirements.txt."
            ) from exc

        self.tokenizer = MarianTokenizer.from_pretrained(config.model_path)
        self.translator = ctranslate2.Translator(
            config.model_path,
            device=config.device,
            compute_type=config.compute_type,
            inter_threads=config.inter_threads,
            intra_threads=config.intra_threads,
        )

    async def translate(
        self,
        text: str,
        source_lang: str = "en",
        target_lang: str = "ru",
        model: str | None = None,
        profile: str | None = None,
        prompt_style: str | None = None,
    ) -> TranslationResult:
        clipped = text[: self.config.max_input_chars]
        tokens = self.tokenizer.convert_ids_to_tokens(self.tokenizer.encode(clipped))
        results = self.translator.translate_batch([tokens], beam_size=1, max_decoding_length=160)
        output_tokens = results[0].hypotheses[0]
        translation = self.tokenizer.decode(self.tokenizer.convert_tokens_to_ids(output_tokens), skip_special_tokens=True)
        return TranslationResult(
            translation=translation.strip(),
            backend=self.backend_name,
            model=self.model_name,
        )
