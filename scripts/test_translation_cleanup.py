from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "translator-server"
sys.path.insert(0, str(SERVER))

from app.glossary import Glossary  # noqa: E402
from app.translator.ollama import clean_ollama_response  # noqa: E402


def assert_equal(name: str, actual: str, expected: str) -> None:
    if actual != expected:
        raise AssertionError(f"{name}\nexpected: {expected!r}\nactual:   {actual!r}")
    print(f"OK {name}")


glossary = Glossary(SERVER / "app" / "glossary" / "glossary.yaml")

assert_equal(
    "fix Med-PaLM 2 ASR",
    glossary.apply_corrections("met pump two was the first model", "tech_keynote"),
    "Med-PaLM 2 was the first model",
)
assert_equal(
    "fix PaLM 2 ASR",
    glossary.apply_corrections("With palm two, Bard improved reasoning", "tech_keynote"),
    "With PaLM 2, Bard improved reasoning",
)
assert_equal(
    "fix Bard possessive ASR",
    glossary.apply_corrections("bart's math logic improved", "tech_keynote"),
    "Bard's math logic improved",
)
assert_equal(
    "fix Bard ASR with coding context",
    glossary.apply_corrections("now bart is rebuilding the code", "tech_keynote"),
    "now Bard is rebuilding the code",
)
assert_equal(
    "preserve unrelated Bart without context",
    glossary.apply_corrections("Bart joined the call", "tech_keynote"),
    "Bart joined the call",
)
assert_equal(
    "fix PaLM API ASR",
    glossary.apply_corrections("using the palm api", "tech_keynote"),
    "using the PaLM API",
)
assert_equal(
    "fix state-of-the-art ASR",
    glossary.apply_corrections("currently the state of the odt", "tech_keynote"),
    "currently the state-of-the-art",
)
assert_equal(
    "fix programming language list ASR",
    glossary.apply_corrections("including c plius go, javascript, python", "tech_keynote"),
    "including C++, Go, javascript, python",
)
assert_equal(
    "fix Chrome Dino game ASR",
    glossary.apply_corrections("create a dyno game", "tech_keynote"),
    "create a Dino game",
)
assert_equal(
    "strip model hallucinated placeholder",
    clean_ollama_response("Более [неразборчиво] запросов к модели."),
    "Более запросов к модели.",
)
