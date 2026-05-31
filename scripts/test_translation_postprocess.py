"""Tests for the translation post-processing stage.

Covers the functions that run AFTER the model returns text, before the
translation reaches the overlay:

  - clean_ollama_response      : strip prefixes/quotes/ellipsis/placeholders,
                                 balance punctuation, drop echoed English word
  - align_subtitle_punctuation : drop a stray final period on fragments,
                                 keep it on complete sentences, handle dashes
  - looks_bad_russian          : detect non-Russian / garbled model output
                                 (triggers a strict re-translation upstream)
  - Glossary.apply_output_corrections : restore product names the model
                                 mistranslated (Liquid Glass, Siri, Gemini...)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "translator-server"
sys.path.insert(0, str(SERVER))

from app.glossary import Glossary  # noqa: E402
from app.translator.ollama import (  # noqa: E402
    align_subtitle_punctuation,
    clean_ollama_response,
    looks_bad_russian,
)

FAILS = []


def eq(name: str, actual, expected) -> None:
    if actual != expected:
        FAILS.append(name)
        print(f"FAIL {name}\n  expected: {expected!r}\n  actual:   {actual!r}")
    else:
        print(f"OK {name}")


glossary = Glossary(SERVER / "app" / "glossary" / "glossary.yaml")

# --- clean_ollama_response -------------------------------------------------
eq("strip 'Translation:' prefix",
   clean_ollama_response("Translation: Привет."), "Привет.")
eq("strip wrapping quotes",
   clean_ollama_response('"Привет"'), "Привет")
eq("strip trailing ellipsis",
   clean_ollama_response("Мы начинаем..."), "Мы начинаем")
eq("drop unbalanced quote",
   clean_ollama_response('Он сказал "привет'), "Он сказал привет")
eq("drop echoed English word when source starts with it",
   clean_ollama_response("so мы начинаем", source="so we begin"), "мы начинаем")
eq("strip model-inserted placeholder",
   clean_ollama_response("Более [неразборчиво] запросов."), "Более запросов.")

# --- align_subtitle_punctuation -------------------------------------------
eq("drop final period on lowercase fragment",
   align_subtitle_punctuation("and we are building", "и мы строим."), "и мы строим")
eq("keep final period on complete sentence",
   align_subtitle_punctuation("We are building today.", "Мы строим сегодня."),
   "Мы строим сегодня.")
eq("preserve dialogue dash when source has it",
   align_subtitle_punctuation("— Yes.", "— Да."), "— Да.")
eq("strip stray leading dash when source has none",
   align_subtitle_punctuation("Yes indeed today my friends.",
                              "— Да, действительно сегодня друзья."),
   "Да, действительно сегодня друзья.")

# --- looks_bad_russian -----------------------------------------------------
eq("normal Russian is fine", looks_bad_russian("Привет, как дела"), False)
eq("Russian with English term is fine",
   looks_bad_russian("Это Liquid Glass материал"), False)
eq("CJK output is bad", looks_bad_russian("你好 world"), True)
eq("all-English output is bad",
   looks_bad_russian("this is all english text here now"), True)
eq("empty output is bad", looks_bad_russian(""), True)

# --- Glossary.apply_output_corrections (product-name restoration) ----------
eq("restore Liquid Glass",
   glossary.apply_output_corrections("Liquid Glass material",
                                     "Жидкое стекло — материал", "tech_keynote"),
   "Liquid Glass — материал")
eq("restore Siri",
   glossary.apply_output_corrections("Siri can help", "Сири может помочь",
                                     "tech_keynote"),
   "Siri может помочь")
eq("restore Gemini from Близнецы",
   glossary.apply_output_corrections("Gemini is great", "Близнецы это здорово",
                                     "tech_keynote"),
   "Gemini это здорово")

if FAILS:
    print(f"\n{len(FAILS)} test(s) failed: {', '.join(FAILS)}")
    sys.exit(1)
print("\nall post-processing tests passed")
