from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class GlossaryMatch:
    source: str
    target: str
    kind: str


class Glossary:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        return yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}

    def profile(self, name: str | None) -> dict[str, Any]:
        profiles = self.data.get("profiles", {})
        return profiles.get(name or "", {})

    def apply_corrections(self, text: str, profile: str | None) -> str:
        value = text
        corrections = self.profile(profile).get("asr_corrections", {})
        for wrong, right in corrections.items():
            value = re.sub(rf"\b{re.escape(str(wrong))}\b", str(right), value, flags=re.IGNORECASE)
        for rule in self.profile(profile).get("asr_contextual", []):
            wrong = str(rule.get("wrong", ""))
            right = str(rule.get("right", ""))
            contexts = [str(item) for item in rule.get("when", [])]
            if not wrong or not right:
                continue
            if contexts and not any(re.search(rf"\b{re.escape(item)}\b", value, flags=re.IGNORECASE) for item in contexts):
                continue
            value = re.sub(rf"\b{re.escape(wrong)}\b", right, value, flags=re.IGNORECASE)
        return value

    def relevant_matches(self, text: str, profile: str | None, limit: int = 14) -> list[GlossaryMatch]:
        haystack = text.lower()
        profile_data = self.profile(profile)
        matches: list[GlossaryMatch] = []

        for term in profile_data.get("keep", []):
            if self._contains_term(haystack, str(term)):
                matches.append(GlossaryMatch(str(term), "keep unchanged", "keep"))

        for source, target in profile_data.get("translate", {}).items():
            if self._contains_term(haystack, str(source)):
                matches.append(GlossaryMatch(str(source), str(target), "translate"))

        for source, target in profile_data.get("asr_corrections", {}).items():
            if self._contains_term(haystack, str(source)):
                matches.append(GlossaryMatch(str(source), str(target), "asr"))

        for rule in profile_data.get("asr_contextual", []):
            wrong = str(rule.get("wrong", ""))
            right = str(rule.get("right", ""))
            contexts = [str(item) for item in rule.get("when", [])]
            context_matches = not contexts or any(
                re.search(rf"\b{re.escape(item)}\b", text, flags=re.IGNORECASE) for item in contexts
            )
            if wrong and context_matches and self._contains_term(haystack, wrong):
                matches.append(GlossaryMatch(wrong, right, "asr"))

        return matches[:limit]

    def prompt_block(self, text: str, profile: str | None) -> str:
        matches = self.relevant_matches(text, profile)
        if not matches:
            return ""
        lines = ["Relevant glossary for this subtitle:"]
        for item in matches:
            if item.kind == "keep":
                lines.append(f"- {item.source}: keep unchanged")
            elif item.kind == "asr":
                lines.append(f"- ASR correction: {item.source} -> {item.target}")
            else:
                lines.append(f"- {item.source} -> {item.target}")
        return "\n".join(lines) + "\n\n"

    def apply_output_corrections(self, source_text: str, translation: str, profile: str | None) -> str:
        value = translation
        source = source_text.lower()
        for rule in self.profile(profile).get("output_corrections", []):
            when_source = str(rule.get("when_source", ""))
            wrong = str(rule.get("wrong", ""))
            right = str(rule.get("right", ""))
            if not wrong or not right:
                continue
            if when_source and not self._contains_term(source, when_source):
                continue
            value = re.sub(rf"\b{re.escape(wrong)}\b", right, value, flags=re.IGNORECASE)
        return value

    @staticmethod
    def _contains_term(haystack: str, term: str) -> bool:
        needle = term.lower()
        if not needle:
            return False
        return re.search(rf"(?<![\w]){re.escape(needle)}(?![\w])", haystack, flags=re.IGNORECASE) is not None
