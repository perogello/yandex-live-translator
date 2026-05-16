from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from statistics import median


WEAK_TAIL_RE = re.compile(
    r"\b(a|an|the|to|of|and|or|but|with|for|from|in|on|at|as|that|which|who|when|where|because|new|more|all|our|your|their)$",
    re.IGNORECASE,
)
CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
BAD_PREFIX_RE = re.compile(r"^\s*(translation|перевод|russian)\s*:", re.IGNORECASE)
PLACEHOLDER_RE = re.compile(r"[\[\{<][^\]\}>]{1,60}[\]\}>]")
PROPER_NOUN_RE = re.compile(r"\b([A-Z][a-z]{2,})(?:\s+([A-Z][a-z]{2,}))?\b")
PROPER_NOUN_STOP = {
    "We", "You", "They", "He", "She", "And", "But", "So", "Now", "Then",
    "The", "This", "That", "These", "Those", "Our", "Your", "Their", "There",
    "Google", "Apple", "Microsoft", "OpenAI", "Gemini", "Android", "Chrome",
    "Pixel", "Nest", "ChatGPT", "Copilot", "Windows", "Azure", "GitHub",
    "Firebase", "Kubernetes", "TensorFlow", "Swift", "Xcode", "Hey", "Allright",
    "Yes", "Okay", "Hello",
}
WORD_RE = re.compile(r"[\w']+", re.UNICODE)


def cyrillic_words(text: str) -> list[str]:
    return [m.group(0).lower() for m in re.finditer(r"[А-Яа-яЁё][А-Яа-яЁё'-]{1,}", text)]


def unbalanced_punctuation(text: str) -> bool:
    if text.count('"') % 2 != 0:
        return True
    if text.count("«") != text.count("»"):
        return True
    if text.count("(") != text.count(")"):
        return True
    if text.count("[") != text.count("]"):
        return True
    return False


def extract_proper_pairs(text: str) -> list[str]:
    found = []
    for match in PROPER_NOUN_RE.finditer(text):
        first, second = match.group(1), match.group(2)
        if first in PROPER_NOUN_STOP:
            continue
        if second and second not in PROPER_NOUN_STOP:
            found.append(f"{first} {second}")
        else:
            found.append(first)
    return found


def trailing_ngram(text: str, n: int = 4) -> str:
    words = WORD_RE.findall(text.lower())
    if len(words) < n:
        return ""
    return " ".join(words[-n:])


def leading_ngram(text: str, n: int = 4) -> str:
    words = WORD_RE.findall(text.lower())
    if len(words) < n:
        return ""
    return " ".join(words[:n])


def percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    index = max(0, min(len(values) - 1, int((len(values) * pct + 99) // 100) - 1))
    return values[index]


def words(text: str) -> list[str]:
    return [item for item in re.split(r"\s+", text.strip()) if item]


def key(text: str) -> str:
    cleaned = re.sub(r"[^\w\s']+", " ", text.lower(), flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip()


def read_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    with path.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
    return records


def analyze(path: Path) -> dict:
    all_records = read_jsonl(path)
    records = [item for item in all_records if item.get("event") in ("", None, "translate")]
    subtitle_records = [item for item in all_records if item.get("event") == "subtitle" and item.get("status") == "ok"]
    ok = [item for item in records if item.get("status") == "ok"]
    latencies = sorted(int(item.get("latency_ms") or 0) for item in ok)
    seen_to_commit = sorted(int(item.get("client_seen_to_commit_ms") or 0) for item in ok if int(item.get("client_seen_to_commit_ms") or 0) > 0)
    queue_wait = sorted(int(item.get("client_queue_wait_ms") or 0) for item in ok if int(item.get("client_queue_wait_ms") or 0) > 0)
    request_to_backend = sorted(int(item.get("client_request_to_backend_ms") or 0) for item in ok if int(item.get("client_request_to_backend_ms") or 0) > 0)
    seen_to_overlay = sorted(
        int(item.get("client_seen_to_overlay_ms") or 0)
        for item in subtitle_records
        if int(item.get("client_seen_to_overlay_ms") or 0) > 0
    )
    commit_to_overlay = sorted(
        int(item.get("client_commit_to_overlay_ms") or 0)
        for item in subtitle_records
        if int(item.get("client_commit_to_overlay_ms") or 0) > 0
    )
    models = Counter(str(item.get("model") or "") for item in ok)
    text_keys = Counter(key(str(item.get("text") or "")) for item in ok)

    short_fragments = 0
    weak_tail = 0
    cjk = 0
    bad_prefix = 0
    source_addition_risk = 0
    term_risks = Counter()
    placeholder_leaks = 0
    unbalanced_punct = 0
    length_ratios: list[float] = []
    proper_to_targets: dict[str, Counter] = {}
    overlap_count = 0
    prev_trailing = ""

    for item in ok:
        source = str(item.get("text") or "")
        target = str(item.get("translation") or "")
        if len(words(source)) < 6:
            short_fragments += 1
        if WEAK_TAIL_RE.search(source.strip()):
            weak_tail += 1
        if CJK_RE.search(target):
            cjk += 1
        if BAD_PREFIX_RE.search(target):
            bad_prefix += 1
        if PLACEHOLDER_RE.search(target):
            placeholder_leaks += 1
        if unbalanced_punctuation(target):
            unbalanced_punct += 1

        en_chars = len(source.strip())
        ru_chars = len(target.strip())
        if en_chars >= 20 and ru_chars > 0:
            length_ratios.append(ru_chars / en_chars)

        if prev_trailing:
            leading = leading_ngram(source, n=4)
            if leading and leading == prev_trailing:
                overlap_count += 1
        prev_trailing = trailing_ngram(source, n=4)

        for name in extract_proper_pairs(source):
            ru_tokens = cyrillic_words(target)
            if ru_tokens:
                ru_signature = " ".join(ru_tokens[:3])
                proper_to_targets.setdefault(name, Counter())[ru_signature] += 1

        source_lower = source.lower()
        target_lower = target.lower()
        if source[:1].islower() and re.search(r"\b(мы расскажем|мы покажем|сегодня мы)\b", target_lower):
            source_addition_risk += 1
        if "text to speech" in source_lower and "речи в текст" in target_lower:
            term_risks["text_to_speech_reversed"] += 1
        if "speech to text" in source_lower and "текста в речь" in target_lower:
            term_risks["speech_to_text_reversed"] += 1
        if "gemini" in source_lower and re.search(r"\b(близнец|близнецы|близнецов)\b", target_lower):
            term_risks["gemini_translated"] += 1

    name_variants = 0
    name_examples: list[str] = []
    for name, variants in proper_to_targets.items():
        if sum(variants.values()) < 2:
            continue
        if len(variants) > 1:
            name_variants += 1
            if len(name_examples) < 5:
                top = ", ".join(f"{k}({v})" for k, v in variants.most_common(3))
                name_examples.append(f"{name}: {top}")
    avg_length_ratio = round(sum(length_ratios) / len(length_ratios), 3) if length_ratios else 0
    high_ratio_count = sum(1 for r in length_ratios if r > 1.35)

    duplicate_count = sum(count - 1 for value, count in text_keys.items() if value and count > 1)
    slow_3000 = sum(1 for value in latencies if value > 3000)
    slow_5000 = sum(1 for value in latencies if value > 5000)
    avg_en = round(sum(len(str(item.get("text") or "")) for item in ok) / len(ok), 1) if ok else 0
    avg_ru = round(sum(len(str(item.get("translation") or "")) for item in ok) / len(ok), 1) if ok else 0

    live_score = 100.0
    live_score -= min(30, slow_3000 * 30 / max(1, len(ok)))
    live_score -= min(20, slow_5000 * 80 / max(1, len(ok)))
    live_score -= min(15, weak_tail * 50 / max(1, len(ok)))
    live_score -= min(15, short_fragments * 20 / max(1, len(ok)))
    live_score -= min(10, duplicate_count * 50 / max(1, len(ok)))
    live_score -= min(20, (cjk + bad_prefix + source_addition_risk + sum(term_risks.values())) * 100 / max(1, len(ok)))
    live_score -= min(15, (placeholder_leaks + unbalanced_punct) * 80 / max(1, len(ok)))
    live_score -= min(10, name_variants * 15 / max(1, len(ok)))
    if avg_length_ratio and avg_length_ratio > 1.20:
        live_score -= min(10, (avg_length_ratio - 1.20) * 50)
    live_score -= min(10, overlap_count * 25 / max(1, len(ok)))

    return {
        "file": str(path),
        "records": len(records),
        "ok": len(ok),
        "errors": len(records) - len(ok),
        "model": models.most_common(1)[0][0] if models else "",
        "latency_median_ms": int(median(latencies)) if latencies else 0,
        "latency_p90_ms": percentile(latencies, 90),
        "latency_p95_ms": percentile(latencies, 95),
        "latency_max_ms": latencies[-1] if latencies else 0,
        "seen_to_commit_median_ms": int(median(seen_to_commit)) if seen_to_commit else 0,
        "seen_to_commit_p90_ms": percentile(seen_to_commit, 90),
        "queue_wait_median_ms": int(median(queue_wait)) if queue_wait else 0,
        "queue_wait_p90_ms": percentile(queue_wait, 90),
        "request_to_backend_median_ms": int(median(request_to_backend)) if request_to_backend else 0,
        "seen_to_overlay_median_ms": int(median(seen_to_overlay)) if seen_to_overlay else 0,
        "seen_to_overlay_p90_ms": percentile(seen_to_overlay, 90),
        "commit_to_overlay_median_ms": int(median(commit_to_overlay)) if commit_to_overlay else 0,
        "commit_to_overlay_p90_ms": percentile(commit_to_overlay, 90),
        "slow_gt_3000": slow_3000,
        "slow_gt_5000": slow_5000,
        "short_fragments_lt_6_words": short_fragments,
        "weak_tail_fragments": weak_tail,
        "exact_duplicate_sources": duplicate_count,
        "avg_en_chars": avg_en,
        "avg_ru_chars": avg_ru,
        "cjk_artifacts": cjk,
        "bad_prefixes": bad_prefix,
        "source_addition_risk": source_addition_risk,
        "term_risks": dict(term_risks),
        "placeholder_leaks": placeholder_leaks,
        "unbalanced_punctuation": unbalanced_punct,
        "avg_ru_to_en_ratio": avg_length_ratio,
        "verbose_lines_gt_1_35": high_ratio_count,
        "proper_noun_inconsistent": name_variants,
        "proper_noun_examples": name_examples,
        "sliding_overlap_inputs": overlap_count,
        "technical_live_score": round(max(0, live_score), 1),
    }


def print_table(rows: list[dict]) -> None:
    columns = [
        ("model", 34),
        ("ok", 6),
        ("latency_median_ms", 8),
        ("latency_p90_ms", 8),
        ("seen_to_commit_median_ms", 8),
        ("queue_wait_median_ms", 8),
        ("seen_to_overlay_median_ms", 8),
        ("latency_max_ms", 8),
        ("slow_gt_3000", 8),
        ("slow_gt_5000", 8),
        ("short_fragments_lt_6_words", 8),
        ("weak_tail_fragments", 8),
        ("exact_duplicate_sources", 8),
        ("technical_live_score", 8),
    ]
    print(" ".join(name[:width].ljust(width) for name, width in columns))
    for row in rows:
        print(" ".join(str(row.get(name, ""))[:width].ljust(width) for name, width in columns))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate translation JSONL logs.")
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="Print JSON instead of a table.")
    args = parser.parse_args()

    rows = [analyze(path) for path in args.paths]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print_table(rows)


if __name__ == "__main__":
    main()
