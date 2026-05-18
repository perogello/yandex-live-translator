from __future__ import annotations

import re
from collections import deque
from pathlib import Path

import httpx

from app.config import OllamaConfig
from app.glossary import Glossary
from app.translator.base import TranslationResult, Translator


SYSTEM_PROMPT = """You are a professional live subtitle interpreter for major technical keynotes.
Translate English live subtitles into natural Russian.

Output rules:
- Output only the Russian translation, no explanations, no quotes, no prefix.
- Use Russian Cyrillic text, except for product names, APIs, SDKs, programming languages and established English technology names.
- Never use Chinese, Japanese or Korean characters.
- Preserve meaning. Do not invent missing context.
- Do not infer or add unspoken continuation, even if the previous context suggests one.
- Keep the style concise and readable as subtitles.
- Do not use ellipses. Do not end with "..." unless the English source literally contains "...".
- If the current subtitle is fragmentary, translate the fragment naturally without completing it with invented content.
- If the current subtitle ends mid-thought, output a short Russian fragment that also ends mid-thought.
- If the text is already a product or technology name, keep it unchanged.
- Prefer stable terminology across the session.
- The English input may contain live ASR mistakes. When the surrounding context makes the intended wording obvious, translate the intended wording, not the literal ASR error. If uncertain, stay literal.
- Before translating, silently normalize the live ASR text: fix obvious recognition errors, restore basic punctuation, and merge fragmentary wording only when context makes it clear.
- Do not output the normalized English. Output only the final Russian subtitle translation.

Event context:
Apple WWDC, Google I/O, Microsoft Build, OpenAI DevDay, developer keynotes, AI/product/platform announcements.

Keep these names unchanged unless Russian usage strongly requires otherwise:
Apple Intelligence, iOS, iPadOS, macOS, watchOS, visionOS, Xcode, Swift, SwiftUI, UIKit, App Store, API, SDK,
Gemini, Android, Chrome, Firebase, TensorFlow, Kubernetes, OpenAI, ChatGPT, model, token, context window.

Terminology preferences:
developer -> разработчик
developers -> разработчики
feature -> функция / возможность
framework -> фреймворк
inference -> инференс
on device -> на устройстве
privacy -> конфиденциальность
performance -> производительность
latency -> задержка
rollout -> выпуск / постепенное внедрение
cloud -> облако / облачный
keynote -> презентация
"""


PROFILE_PROMPTS = {
    "general": "Domain profile: general speech. Prefer literal, cautious translation. Do not over-correct ambiguous names.",
    "tech_keynote": """Domain profile: technology keynote / developer conference / product launch.
Expected topics: software development, AI, developer tools, cloud, mobile platforms, apps, privacy, performance.
Expected entities and names to keep mostly unchanged:
Apple Intelligence, iOS, iPadOS, macOS, watchOS, visionOS, Xcode, Swift, SwiftUI, App Store,
Google I/O, Gemini, Android, Chrome, Firebase, Workspace, TensorFlow,
Microsoft Build, Copilot, Windows, Azure, Visual Studio, GitHub, .NET,
OpenAI, ChatGPT, API, SDK, model, token, context window, on-device inference.""",
    "politics_news": """Domain profile: politics / news / international relations.
Expected topics: diplomacy, war, elections, sanctions, defense industry, budgets, international law.
Expected entities and terms:
United States, U.S., China, Russia, Ukraine, Gaza, Iran, Israel, Qatar, Taiwan, NATO, UN, Congress,
Eisenhower, military-industrial complex, war machine, ceasefire, truce, Strait of Hormuz.
Common ASR corrections in this domain:
U.S. fans -> U.S. firms when discussing companies
Isra -> Israel when discussing the Middle East
Hazza -> Gaza when discussing Gaza
warm machine -> war machine
farewell addressed -> farewell address
why Eisenhower -> Dwight Eisenhower
war industry -> arms industry / defense industry depending on context
water the others didn't want to -> what others didn't want to, when the phrase is otherwise ungrammatical
decad reality -> the reality, when discussing political facts or positions

Translation cautions:
have no care for life -> им нет дела до человеческой жизни / они не ценят человеческую жизнь
turn south of Lebanon into Gaza -> превратить юг Ливана в Газу
Do not change the subject of the sentence. If the subject is missing, keep the Russian sentence subjectless too.""",
}


class OllamaTranslator(Translator):
    backend_name = "ollama"

    def __init__(self, config: OllamaConfig):
        self.config = config
        self.model_name = config.model
        self.history = deque(maxlen=max(0, config.context_items))
        self.glossary = Glossary(Path(__file__).resolve().parents[1] / "glossary" / "glossary.yaml")
        self.client = httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            timeout=httpx.Timeout(config.timeout_sec),
        )
        self.name_cache: dict[str, str] = {}

    async def translate(
        self,
        text: str,
        source_lang: str = "en",
        target_lang: str = "ru",
        model: str | None = None,
        profile: str | None = None,
        prompt_style: str | None = None,
    ) -> TranslationResult:
        selected_model = model or self.config.model
        selected_profile = profile or "tech_keynote"
        selected_style = prompt_style or getattr(self.config, "prompt_style", "красивый")
        if selected_style not in ("красивый", "короткий"):
            selected_style = "красивый"
        corrected_text = self.glossary.apply_corrections(text, selected_profile)
        translation = await self._translate_once(corrected_text, strict=False, model=selected_model, profile=selected_profile, prompt_style=selected_style)
        if looks_bad_russian(translation):
            translation = await self._translate_once(corrected_text, strict=True, model=selected_model, profile=selected_profile, prompt_style=selected_style)

        cleaned = clean_ollama_response(translation, source=corrected_text)
        cleaned = self.glossary.apply_output_corrections(corrected_text, cleaned, selected_profile)
        cleaned = align_subtitle_punctuation(corrected_text, cleaned)
        cleaned = self._capitalize_after_prev_sentence_end(cleaned)
        self._update_name_cache(corrected_text, cleaned)
        self._remember(corrected_text, cleaned)
        return TranslationResult(
            translation=cleaned,
            backend=self.backend_name,
            model=selected_model,
        )

    async def _translate_once(self, text: str, strict: bool, model: str, profile: str, prompt_style: str = "красивый") -> str:
        if model.lower().startswith("translategemma"):
            return await self._translate_with_translategemma(text, strict=strict, model=model, profile=profile, prompt_style=prompt_style)
        if "towerinstruct" in model.lower():
            return await self._translate_with_tower(text, strict=strict, model=model, profile=profile)

        profile_block = PROFILE_PROMPTS.get(profile, PROFILE_PROMPTS["general"])
        glossary_block = self.glossary.prompt_block(text, profile)
        use_context = strict or self._needs_context(text)
        context_block = self._context_block(limit=2) if use_context else ""
        user_prompt = (
            f"{profile_block}\n\n"
            f"{glossary_block}"
            f"{context_block}"
            "Task: silently correct obvious live ASR errors in the CURRENT subtitle, then translate it into Russian.\n"
            "Do not translate the context again.\n"
            "Do not output corrected English.\n"
            "Output only the final Russian subtitle translation.\n\n"
            f"CURRENT SUBTITLE:\n{text}"
        )
        if strict:
            user_prompt = (
                "Your previous answer was not valid Russian subtitle text.\n"
                "Return only a Russian Cyrillic translation. No CJK characters. No explanation.\n\n"
                f"{profile_block}\n\n"
                f"{glossary_block}"
                f"{context_block}"
                f"CURRENT ENGLISH SUBTITLE:\n{text}"
            )

        payload = {
            "model": model,
            "stream": False,
            "keep_alive": self.config.keep_alive,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "options": {
                "temperature": self.config.temperature,
                "num_ctx": self.config.num_ctx,
                "num_predict": self.config.num_predict,
            },
        }
        response = await self.client.post("/api/chat", json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("message", {}).get("content", "")

    async def _translate_with_tower(self, text: str, strict: bool, model: str, profile: str) -> str:
        profile_block = PROFILE_PROMPTS.get(profile, PROFILE_PROMPTS["general"])
        glossary_block = self.glossary.prompt_block(text, profile)
        context_block = self._context_block(limit=1) if strict or self._needs_context(text) else ""
        domain_hint = ""
        if profile == "tech_keynote":
            domain_hint = (
                "This is a live technology keynote subtitle. Keep product and company names unchanged, "
                "especially Gemini, Google, Android, YouTube, API, SDK, AI, model names and programming terms. "
                "Never translate Gemini as a zodiac sign or a common noun.\n"
            )
        elif profile == "politics_news":
            domain_hint = "This is a live politics/news subtitle. Preserve factual meaning, named entities, and the subject of each sentence.\n"
        user_prompt = (
            "Translate the following text from English into Russian.\n"
            f"{profile_block}\n\n"
            f"{glossary_block}"
            f"{context_block}"
            f"{domain_hint}"
            "Rules:\n"
            "- Return only the Russian translation.\n"
            "- Do not add explanations, alternatives, prefixes, or missing content.\n"
            "- The glossary is mandatory. If it says X -> Y, use Y verbatim in the Russian translation.\n"
            "- If the glossary says a term must be kept unchanged, keep it unchanged verbatim.\n"
            "- Keep product names unchanged unless the glossary says otherwise.\n"
            "- If the English text is an unfinished live subtitle fragment, translate only that fragment.\n"
            "- Do not add a final period if the English source does not have final punctuation.\n"
            "- Translate idioms naturally; do not translate them word-by-word when that creates nonsense.\n\n"
            f"English subtitle:\n{text}\n"
            "Russian:"
        )
        if strict:
            user_prompt = (
                "Translate the following text from English into Russian.\n"
                f"{profile_block}\n\n"
                f"{glossary_block}"
                f"{context_block}"
                "Return only valid Russian Cyrillic text. No explanations, no alternatives, no extra commentary. "
                "The glossary is mandatory: use its target translations verbatim. "
                "Keep product names unchanged. Do not translate Gemini as a common word.\n"
                f"English subtitle:\n{text}\n"
                "Russian:"
            )

        payload = {
            "model": model,
            "stream": False,
            "keep_alive": self.config.keep_alive,
            "messages": [
                {"role": "user", "content": user_prompt},
            ],
            "options": {
                "temperature": 0,
                "num_ctx": min(self.config.num_ctx, 2048),
                "num_predict": min(self.config.num_predict, 120),
            },
        }
        response = await self.client.post("/api/chat", json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("message", {}).get("content", "")

    async def _translate_with_translategemma(self, text: str, strict: bool, model: str, profile: str, prompt_style: str = "красивый") -> str:
        glossary_block = self.glossary.prompt_block(text, profile)
        context_block = self._context_block(limit=1) if self._needs_context(text) else ""
        name_hint = self._name_hint_block(text)
        domain_hint = ""
        if profile == "tech_keynote":
            domain_hint = (
                "The source text is from live technical keynote subtitles. Preserve product names, company names, "
                "APIs, SDKs, programming languages, model names and established English technology terms when appropriate. "
            )
        elif profile == "politics_news":
            domain_hint = "The source text is from live political or international news subtitles. Preserve the subject and factual meaning. "
        if prompt_style == "короткий":
            user_prompt = (
                "Translate the English live subtitle into Russian.\n"
                "Rules:\n"
                "- Output ONLY the Russian translation. No explanations, no quotes, no brackets, no parenthetical glosses.\n"
                "- Keep the Russian length close to the English length. Do not expand, explain, or rephrase for elegance.\n"
                "- Keep product, company, API, SDK, framework and model names in English unless the glossary maps them.\n"
                "- If the English source is an unfinished fragment, output an unfinished Russian fragment without a final period.\n"
                "- Do not add a subject, speaker intention, or verbs that are not in the English source.\n"
                "- If the English is garbled by ASR, translate literally and do not invent meaning.\n\n"
                f"{glossary_block}"
                f"{name_hint}"
                f"{context_block}"
                "English:\n"
                f"{text}\n"
                "Russian:"
            )
        else:
            user_prompt = (
                "You are a professional English (en) to Russian (ru) translator. "
                "Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Russian grammar, vocabulary, and natural subtitle style. "
                f"{domain_hint}"
                "Produce only the Russian translation, without any additional explanations or commentary. "
                "If a glossary is provided below, follow it exactly. Keep terms marked as unchanged verbatim. "
                "If a term looks like a product name, feature name, project name, model name, API, app, or branded capability, keep it in English unless the glossary explicitly says otherwise. "
                "Prefer polished, natural Russian subtitle phrasing that is concise and easy to read. "
                "If the English source is clearly garbled, translate conservatively and do not invent a precise technical claim. "
                "If the English text is an unfinished live subtitle fragment, translate only that fragment and do not add a final period unless the English source has final punctuation. "
                "Do not add a subject, speaker intention, or verbs such as 'we will show' or 'we will tell' unless they are explicitly present in the English text. "
                f"\n\n{glossary_block}"
                f"{name_hint}"
                f"{context_block}"
                "Please translate the following English text into Russian:\n\n"
                f"{text}"
            )
        if strict:
            user_prompt = (
                "You are a professional English (en) to Russian (ru) translator. "
                "Produce only a valid Russian translation in Cyrillic, without explanations, prefixes, alternatives or extra commentary. "
                "Do not use Chinese, Japanese, Korean, Hebrew or Arabic characters. "
                "If a glossary is provided below, follow it exactly. Keep terms marked as unchanged verbatim. "
                "Keep product names, feature names, project names, model names, APIs, apps, and branded capabilities in English unless the glossary explicitly says otherwise. "
                "Use polished, natural Russian subtitle phrasing that is concise and easy to read. If the English source is garbled, stay conservative and do not invent a precise technical claim. "
                "Do not add missing subjects or complete unfinished thoughts. "
                f"\n\n{glossary_block}"
                f"{name_hint}"
                f"{context_block}"
                "Please translate the following English text into Russian:\n\n"
                f"{text}"
            )

        payload = {
            "model": model,
            "stream": False,
            "keep_alive": self.config.keep_alive,
            "messages": [
                {"role": "user", "content": user_prompt},
            ],
            "options": {
                "temperature": 0,
                "num_ctx": min(self.config.num_ctx, 1024),
                "num_predict": min(self.config.num_predict, 120),
            },
        }
        response = await self.client.post("/api/chat", json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("message", {}).get("content", "")

    def _context_block(self, limit: int | None = None) -> str:
        if not self.history:
            return ""
        items = list(self.history)
        if limit is not None and limit > 0:
            items = items[-limit:]
        lines = ["Previous subtitle translations for context and terminology. Do not repeat them:"]
        for source, translation in items:
            lines.append(f"EN: {source}")
            lines.append(f"RU: {translation}")
        return "\n".join(lines) + "\n\n"

    def _needs_context(self, text: str) -> bool:
        value = " ".join(text.lower().split())
        words = value.split()
        if len(words) <= 5 and not re.search(r"[.!?]\s*$", value):
            return True
        if re.match(r"^(and|but|so|now|then|this|that|it|they|we|you|he|she|these|those)\b", value):
            return True
        if re.search(r"\b(this|that|it|they|them|these|those|its|their|our|his|her)\b", value):
            return True
        if re.search(r"\b(same|previous|next|above|below|here|there|such|these|those)\b", value):
            return True
        if re.search(r"[,:\-]\s*$", value):
            return True
        return False

    def _remember(self, source: str, translation: str) -> None:
        source_value = " ".join(source.split()).strip()
        translation_value = " ".join(translation.split()).strip()
        if not source_value or not translation_value:
            return
        if self.history and self.history[-1][0] == source_value:
            self.history[-1] = (source_value, translation_value)
            return
        self.history.append((source_value, translation_value))

    def _capitalize_after_prev_sentence_end(self, value: str) -> str:
        # If the previous translation ended a sentence (.!?), the next
        # fragment is shown right after on the overlay. Reading it with a
        # lowercase first letter looks like a continuation, even though it
        # is actually a new sentence. Capitalize so the viewer reads it
        # as the start of something new.
        if not value or not self.history:
            return value
        prev_translation = self.history[-1][1] if self.history else ""
        if not prev_translation:
            return value
        if not re.search(r'[.!?]\s*["\)\]»]?\s*$', prev_translation):
            return value
        first = value[0]
        if first.isalpha() and first.islower():
            return first.upper() + value[1:]
        return value

    def reset_context(self) -> None:
        self.history.clear()
        self.name_cache.clear()

    def _name_hint_block(self, text: str) -> str:
        if not self.name_cache:
            return ""
        hints = []
        lower = text.lower()
        for en_name, ru_name in self.name_cache.items():
            if en_name.lower() in lower:
                hints.append(f"- {en_name} -> {ru_name}")
        if not hints:
            return ""
        return "Use these exact Russian spellings already used earlier in this session:\n" + "\n".join(hints) + "\n\n"

    def _update_name_cache(self, source: str, translation: str) -> None:
        if not source or not translation:
            return
        en_candidates = re.findall(
            r"\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b", source
        )
        ru_candidates = re.findall(
            r"\b([А-ЯЁ][А-Яа-яЁё'\-]{2,}(?:\s+[А-ЯЁ][А-Яа-яЁё'\-]{2,}){0,2})\b",
            translation,
        )
        common_stopwords = {
            "We", "You", "They", "He", "She", "It", "And", "But", "So", "Now", "The",
            "This", "That", "These", "Those", "Hey", "Hello", "Allright", "Yes",
            "Google", "Apple", "Microsoft", "OpenAI", "Gemini", "Android", "Chrome",
            "Pixel", "Nest", "ChatGPT", "Copilot", "Windows", "Azure", "GitHub",
            "Firebase", "Kubernetes", "TensorFlow", "Swift", "Xcode",
        }
        for en in en_candidates:
            first = en.split()[0]
            if first in common_stopwords:
                continue
            if en in self.name_cache:
                continue
            if not ru_candidates:
                continue
            if len(en.split()) >= 2 and len(ru_candidates) >= 1:
                self.name_cache[en] = ru_candidates[0]
                if len(self.name_cache) > 64:
                    first_key = next(iter(self.name_cache))
                    self.name_cache.pop(first_key, None)

    async def health(self) -> dict:
        try:
            response = await self.client.get("/api/tags")
            response.raise_for_status()
            return {
                "available": True,
                "backend": self.backend_name,
                "model": self.model_name,
            }
        except Exception as exc:
            return {
                "available": False,
                "backend": self.backend_name,
                "model": self.model_name,
                "error": str(exc),
            }

    async def warmup(self, text: str = "Hello, welcome to the keynote.") -> None:
        selected_profile = "tech_keynote"
        corrected_text = self.glossary.apply_corrections(text, selected_profile)
        await self._translate_once(corrected_text, strict=False, model=self.config.model, profile=selected_profile)


_PLACEHOLDER_KEYWORDS = (
    "название", "имя", "company", "name", "speaker", "person",
    "имени", "company_name", "placeholder", "фио", "company name",
)


def _strip_placeholders(value: str) -> str:
    def _is_placeholder(inner: str) -> bool:
        lowered = inner.strip().lower()
        if not lowered:
            return True
        if any(keyword in lowered for keyword in _PLACEHOLDER_KEYWORDS):
            return True
        if re.fullmatch(r"[\.\-_ ]+", lowered):
            return True
        return False

    def _replace(match: re.Match) -> str:
        inner = match.group(1)
        if _is_placeholder(inner):
            return ""
        return match.group(0)

    value = re.sub(r"\[([^\[\]]{1,60})\]", _replace, value)
    value = re.sub(r"\{([^\{\}]{1,60})\}", _replace, value)
    value = re.sub(r"<([^<>]{1,60})>", _replace, value)
    value = re.sub(r"</?[A-Za-zА-Яа-я][\wЀ-ӿ _\-]{0,30}>", "", value)
    return value


def _balance_punctuation(value: str) -> str:
    if value.count('"') % 2 != 0:
        value = re.sub(r'"(?=[\s.,;:!?]*$)', "", value, count=1)
        if value.count('"') % 2 != 0:
            value = value.replace('"', "", 1)
    while value.count("«") > value.count("»"):
        idx = value.rfind("«")
        value = value[:idx] + value[idx + 1:]
    while value.count("»") > value.count("«"):
        idx = value.find("»")
        value = value[:idx] + value[idx + 1:]
    while value.count("(") > value.count(")"):
        idx = value.rfind("(")
        value = value[:idx] + value[idx + 1:]
    while value.count(")") > value.count("("):
        idx = value.find(")")
        value = value[:idx] + value[idx + 1:]
    return value


def _strip_lone_english_prefix(source: str, value: str) -> str:
    if not value:
        return value
    match = re.match(r"^([a-z][a-z'\-]*)\s+([А-ЯЁа-яёA-Z])", value)
    if not match:
        return value
    en_word = match.group(1).lower()
    source_lower = source.strip().lower()
    if source_lower.startswith(en_word + " ") or source_lower.startswith(en_word + ","):
        return value[match.start(2):].lstrip()
    return value


def clean_ollama_response(text: str, source: str = "") -> str:
    value = text.strip().strip('"').strip("'").strip()
    value = re.sub(r"^\s*(перевод|translation|russian)\s*:\s*", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*\.{3,}\s*$", "", value)
    value = re.sub(r"\.{3,}", "", value)
    value = _strip_placeholders(value)
    value = _balance_punctuation(value)
    value = _strip_lone_english_prefix(source, value)
    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    value = re.sub(r"\s{2,}", " ", value)
    return value.strip(" ,;:-—")


def align_subtitle_punctuation(source: str, translation: str) -> str:
    value = translation.strip()
    source_value = " ".join(source.split()).strip()
    if not value or not source_value:
        return value

    if not source_value.startswith(("—", "-")):
        value = re.sub(r"^\s*[—-]\s*", "", value)

    source_has_terminal = bool(re.search(r"[.!?]\s*$", source_value))
    source_words = re.findall(r"[A-Za-z0-9']+", source_value)
    starts_lower = bool(re.match(r"^[a-z]", source_value))
    weak_tail = bool(
        re.search(
            r"\b(a|an|the|to|of|and|or|but|with|for|from|in|on|at|as|that|which|who|when|where|because|if|so|then|this|these|those|our|your|their|new|more|right|really)$",
            source_value,
            flags=re.IGNORECASE,
        )
    ) or bool(re.search(r"[,;:—-]\s*$", source_value))
    looks_fragmentary = not source_has_terminal and (starts_lower or weak_tail or len(source_words) < 8)

    if looks_fragmentary:
        value = re.sub(r"\s*[.。]\s*$", "", value).strip()
    return value


def looks_bad_russian(text: str) -> bool:
    value = clean_ollama_response(text)
    if not value:
        return True
    hebrew_count = len(re.findall(r"[\u0590-\u05ff]", value))
    arabic_count = len(re.findall(r"[\u0600-\u06ff]", value))
    cjk_count = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", value))
    cyrillic_count = len(re.findall(r"[А-Яа-яЁё]", value))
    latin_count = len(re.findall(r"[A-Za-z]", value))
    if cjk_count or hebrew_count or arabic_count:
        return True
    if cyrillic_count == 0 and latin_count > 8:
        return True
    return False
