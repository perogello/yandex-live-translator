"""Analyze a translations JSONL log for overlay quality.

Reports three things the operator cares about for a live broadcast:

  1. DUPLICATES  - text shown in the overlay that repeats an earlier row
                   (exact repeats and near-duplicates / ASR revisions).
  2. LATENCY     - how long between first seeing a subtitle chunk and
                   showing its translation in the overlay.
  3. DROPS       - chunks that were translated but never shown in the
                   overlay (produced -> lost), i.e. skipped text.

Usage:
    python scripts/analyze_overlay_log.py <path-to-translations.jsonl>
    python scripts/analyze_overlay_log.py            # auto-pick newest under logs/

The log schema (one JSON object per line):
  event == "translate"  -> a translation was produced
  event == "subtitle"   -> that translation was shown in the overlay
                           (has client_overlay_shown_ms / *_to_overlay_ms)

Both events for the same chunk share client_committed_ms, so we join on
(client_committed_ms, raw_en) to find translations that never reached the
overlay.
"""

from __future__ import annotations

import json
import sys
from difflib import SequenceMatcher
from pathlib import Path

# --- thresholds (tweak here) ---------------------------------------------
HIGH_LATENCY_MS = 4000        # seen -> overlay above this is "high latency"
NEAR_DUP_RATIO = 0.80         # RU similarity above this counts as near-dup
DUP_WINDOW_ROWS = 6           # only compare against the last N overlay rows
EXAMPLES = 12                 # how many examples to print per section
# -------------------------------------------------------------------------


def find_default_log() -> Path | None:
    root = Path(__file__).resolve().parents[1]
    logs = root / "logs"
    candidates = sorted(
        logs.rglob("translations_*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def load_events(path: Path) -> list[dict]:
    events = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def words(text: str) -> list[str]:
    return [w for w in str(text or "").lower().split() if w]


def ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, words(a), words(b)).ratio()


def is_contained(short: str, long: str) -> bool:
    """True if the shorter row's words are a contiguous run inside the longer
    one (a revision that simply grew the previous chunk)."""
    sw, lw = words(short), words(long)
    if not sw or len(sw) > len(lw):
        return False
    joined_l = " " + " ".join(lw) + " "
    joined_s = " " + " ".join(sw) + " "
    return joined_s in joined_l


def pct(values: list[int], q: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, int(len(s) * q))
    return s[idx]


def fmt_ms(ms: int) -> str:
    return f"{ms/1000:.1f}s"


def analyze(path: Path) -> None:
    events = load_events(path)
    translates = [e for e in events if e.get("event") == "translate"]
    subtitles = [e for e in events if e.get("event") == "subtitle"]

    print(f"Log: {path}")
    print(f"  translate events : {len(translates)}")
    print(f"  overlay (subtitle) events: {len(subtitles)}")
    print()

    # ---- 1. DROPS: translated but never shown in overlay -----------------
    def key(e: dict):
        return (e.get("client_committed_ms"), e.get("raw_en") or e.get("text"))

    shown_keys = {key(e) for e in subtitles}
    drops = [e for e in translates if key(e) not in shown_keys]
    print("== DROPS (translated but never shown in overlay) ==")
    print(f"  count: {len(drops)} / {len(translates)} "
          f"({100*len(drops)/max(1,len(translates)):.1f}%)")
    for e in drops[:EXAMPLES]:
        en = (e.get("raw_en") or e.get("text") or "")[:90]
        print(f"    - {en}")
    print()

    # ---- 2. LATENCY: split into segmenter vs queue+model -----------------
    # seen -> overlay  = total delay the viewer feels
    # commit -> overlay = QUEUE + MODEL (after the chunk was committed)
    # seen -> commit    = SEGMENTER (waiting for the sentence to stabilize)
    seen = [e["client_seen_to_overlay_ms"] for e in subtitles
            if isinstance(e.get("client_seen_to_overlay_ms"), (int, float))]
    commit = [e["client_commit_to_overlay_ms"] for e in subtitles
              if isinstance(e.get("client_commit_to_overlay_ms"), (int, float))]
    segmenter = [
        e["client_seen_to_overlay_ms"] - e["client_commit_to_overlay_ms"]
        for e in subtitles
        if isinstance(e.get("client_seen_to_overlay_ms"), (int, float))
        and isinstance(e.get("client_commit_to_overlay_ms"), (int, float))
        and e["client_seen_to_overlay_ms"] >= e["client_commit_to_overlay_ms"]
    ]

    def line(name: str, vals: list) -> None:
        if vals:
            print(f"  {name:24} median {fmt_ms(pct(vals,0.5))}  "
                  f"p90 {fmt_ms(pct(vals,0.9))}  p99 {fmt_ms(pct(vals,0.99))}  "
                  f"max {fmt_ms(max(vals))}")

    print("== LATENCY (overlay output delay) ==")
    line("TOTAL  seen->overlay", seen)
    line("SEGMENTER seen->commit", segmenter)
    line("QUEUE+MODEL commit->ovl", commit)
    seg_slow = [v for v in segmenter if v > HIGH_LATENCY_MS]
    qm_slow = [v for v in commit if v > HIGH_LATENCY_MS]
    print(f"  segmenter waits > {fmt_ms(HIGH_LATENCY_MS)}: {len(seg_slow)} "
          f"({100*len(seg_slow)/max(1,len(segmenter)):.1f}%)  "
          f"<- fix here = sentence-stabilize ceiling")
    print(f"  queue+model > {fmt_ms(HIGH_LATENCY_MS)}: {len(qm_slow)} "
          f"({100*len(qm_slow)/max(1,len(commit)):.1f}%)  "
          f"<- fix here = faster model / queue cap")
    high = [e for e in subtitles
            if isinstance(e.get("client_seen_to_overlay_ms"), (int, float))
            and e["client_seen_to_overlay_ms"] > HIGH_LATENCY_MS]
    print(f"  worst rows (total > {fmt_ms(HIGH_LATENCY_MS)}): {len(high)} "
          f"({100*len(high)/max(1,len(seen)):.1f}%)")
    for e in sorted(high, key=lambda x: -x["client_seen_to_overlay_ms"])[:EXAMPLES]:
        total = e["client_seen_to_overlay_ms"]
        cm = e.get("client_commit_to_overlay_ms")
        sg = f"seg {fmt_ms(total-cm)}/q+m {fmt_ms(cm)}" if isinstance(cm, (int, float)) else ""
        en = (e.get("raw_en") or e.get("text") or "")[:55]
        print(f"    - {fmt_ms(total):>6} [{sg}]  {en}")
    print()

    # ---- 3. DUPLICATES in the overlay stream -----------------------------
    exact = 0
    near = 0
    contained = 0
    near_examples = []
    recent: list[str] = []
    for e in subtitles:
        ru = (e.get("translation") or "").strip()
        if not ru:
            continue
        flagged = False
        for prev in reversed(recent[-DUP_WINDOW_ROWS:]):
            if ru == prev:
                exact += 1
                flagged = True
                break
            if is_contained(ru, prev) or is_contained(prev, ru):
                contained += 1
                if len(near_examples) < EXAMPLES:
                    near_examples.append((prev, ru, "contained"))
                flagged = True
                break
            if ratio(ru, prev) >= NEAR_DUP_RATIO:
                near += 1
                if len(near_examples) < EXAMPLES:
                    near_examples.append((prev, ru, "near"))
                flagged = True
                break
        recent.append(ru)

    total_dup = exact + near + contained
    print("== DUPLICATES in overlay ==")
    print(f"  exact repeats      : {exact}")
    print(f"  contained (revision): {contained}")
    print(f"  near-duplicates    : {near}")
    print(f"  total duplicate rows: {total_dup} / {len(subtitles)} "
          f"({100*total_dup/max(1,len(subtitles)):.1f}%)")
    for prev, ru, kind in near_examples:
        print(f"    [{kind}]")
        print(f"      prev: {prev[:90]}")
        print(f"      now : {ru[:90]}")
    print()

    # ---- verdict ---------------------------------------------------------
    print("== VERDICT ==")
    drop_pct = 100 * len(drops) / max(1, len(translates))
    dup_pct = 100 * total_dup / max(1, len(subtitles))
    high_pct = 100 * len(high) / max(1, len(seen))
    print(f"  drops {drop_pct:.1f}%  |  duplicates {dup_pct:.1f}%  |  "
          f"high-latency {high_pct:.1f}%")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
    else:
        path = find_default_log()
        if path is None:
            print("No log given and none found under logs/", file=sys.stderr)
            sys.exit(1)
    if not path.exists():
        print(f"Log not found: {path}", file=sys.stderr)
        sys.exit(1)
    analyze(path)


if __name__ == "__main__":
    main()
