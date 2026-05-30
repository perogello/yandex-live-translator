"""Dry-run the proposed overlay revision-dedup rule on a real log.

No code is changed. We replay the overlay (subtitle) stream and apply ONE
conservative rule against the previous shown row:

  * exact repeat            -> drop the new row (it adds nothing)
  * new CONTAINS previous    -> replace previous with new (revision grew it)
  * new is CONTAINED in prev -> drop the new row (revision shrank/subset)
  * otherwise                -> keep as a separate row

"Contained" means the shorter row's words are a contiguous run inside the
longer row's words. That guarantees NO unique words are lost: every removed
row's content survives in the row we keep.

Near-duplicates (similar but not contained) are deliberately NOT touched
here, because removing them could drop real content.

Usage:
    python scripts/simulate_overlay_dedup.py <translations.jsonl>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

EXAMPLES = 15


def find_default_log() -> Path | None:
    logs = Path(__file__).resolve().parents[1] / "logs"
    c = sorted(logs.rglob("translations_*.jsonl"),
               key=lambda p: p.stat().st_mtime, reverse=True)
    return c[0] if c else None


def words(text: str) -> list[str]:
    return [w for w in str(text or "").lower().split() if w]


def contained(short: str, long: str) -> bool:
    sw, lw = words(short), words(long)
    if not sw or len(sw) > len(lw):
        return False
    return (" " + " ".join(sw) + " ") in (" " + " ".join(lw) + " ")


def word_set(text: str) -> set[str]:
    return set(words(text))


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    path = Path(sys.argv[1]) if len(sys.argv) > 1 else find_default_log()
    if not path or not path.exists():
        print("Log not found", file=sys.stderr)
        sys.exit(1)

    rows: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("event") == "subtitle":
                ru = (e.get("translation") or "").strip()
                if ru:
                    rows.append(ru)

    kept: list[str] = []
    dropped = 0
    replaced = 0
    removed_examples = []   # (kept_row, removed_row, action)
    lost_words_cases = 0    # safety check: should stay 0

    for ru in rows:
        if not kept:
            kept.append(ru)
            continue
        prev = kept[-1]
        if ru == prev:
            dropped += 1
            removed_examples.append((prev, ru, "exact-drop"))
            continue
        if contained(prev, ru):
            # new grew the previous -> replace; prev's words all survive in ru
            if not word_set(prev) <= word_set(ru):
                lost_words_cases += 1
            kept[-1] = ru
            replaced += 1
            removed_examples.append((prev, ru, "replace(grow)"))
            continue
        if contained(ru, prev):
            # new is a subset of previous -> drop new; nothing lost
            if not word_set(ru) <= word_set(prev):
                lost_words_cases += 1
            dropped += 1
            removed_examples.append((prev, ru, "subset-drop"))
            continue
        kept.append(ru)

    removed = dropped + replaced
    print(f"Log: {path}")
    print(f"  overlay rows (original): {len(rows)}")
    print(f"  overlay rows (after dedup): {len(kept)}")
    print(f"  rows removed: {removed} "
          f"({100*removed/max(1,len(rows)):.1f}%)")
    print(f"    - exact/subset drops : {dropped}")
    print(f"    - replaced by revision: {replaced}")
    print()
    print(f"  CONTENT-LOSS CHECK: rows where removed text had words "
          f"missing from the kept row = {lost_words_cases}")
    print("    (0 means no unique text is lost by this rule)")
    print()
    print("== examples ==")
    for prev, ru, action in removed_examples[:EXAMPLES]:
        print(f"  [{action}]")
        print(f"    before: {prev[:95]}")
        print(f"    after : {ru[:95]}")


if __name__ == "__main__":
    main()
