"""Benchmark translation models through the REAL pipeline (glossary + prompt).

Runs the same OllamaTranslator the server uses, so glossary corrections,
prompt style and post-processing all apply. For each model it reports
per-sentence Russian output and latency, plus a latency summary.

Run it HERE to compare Russian QUALITY across models, and run the exact
same command on the weak PC to compare LATENCY that actually matters there.

Usage:
    python scripts/bench_models.py
    python scripts/bench_models.py --models translategemma:12b,aya-expanse:8b,qwen2.5:3b
    python scripts/bench_models.py --log logs/.../translations_xxx.jsonl --n 15
    python scripts/bench_models.py --out bench_result.md

Results are written to bench_result.md (markdown table) for easy reading.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "translator-server"
sys.path.insert(0, str(SERVER))

from app.config import OllamaConfig  # noqa: E402
from app.translator.ollama import OllamaTranslator  # noqa: E402

# Default sentences: keynote-style + Apple/WWDC terms (next broadcast is WWDC)
DEFAULT_SENTENCES = [
    "Today we are introducing the next generation of Apple Intelligence built right into iOS.",
    "With the new Foundation Models framework, developers can run on-device models with just a few lines of Swift.",
    "Live Translation in Messages now works entirely on device to protect your privacy.",
    "Genmoji and Image Playground let you create something personal in seconds.",
    "Vision Pro brings spatial computing to your living room with visionOS.",
    "The new chip delivers dramatically faster performance while using less power.",
    "Let's take a look at what Siri can do now that it understands your personal context.",
    "We think of agents as systems that can reason, plan, and take action on your behalf.",
    "So go ahead, just ask, and the model will do the rest.",
    "This is all in real time, not sped up.",
    "Stepping back, we have been able to deliver the best models at the most effective price point.",
    "Maybe just grab the details from there and put them at the top of the screen.",
]


def sample_from_log(path: Path, n: int) -> list[str]:
    seen: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("event") != "translate":
                continue
            en = (e.get("raw_en") or e.get("text") or "").strip()
            words = en.split()
            if 6 <= len(words) <= 20 and en[-1:] in ".?!" and en not in seen:
                seen.append(en)
    # spread across the log instead of taking the first N
    if len(seen) <= n:
        return seen
    step = len(seen) / n
    return [seen[int(i * step)] for i in range(n)]


async def bench_model(model: str, sentences: list[str]) -> tuple[list[tuple[str, str, int]], list[int]]:
    cfg = OllamaConfig(
        model=model,
        num_ctx=2048,
        num_predict=120,
        timeout_sec=60,
        temperature=0.1,
        keep_alive="10m",
    )
    tr = OllamaTranslator(cfg)
    rows = []
    lats = []
    # warm-up (load weights) - not measured
    try:
        await tr.translate("Hello, welcome to the keynote.", model=model, profile="tech_keynote")
    except Exception as exc:  # noqa: BLE001
        print(f"  [warmup failed for {model}: {exc}]")
    for en in sentences:
        t0 = time.perf_counter()
        try:
            res = await tr.translate(en, source_lang="en", target_lang="ru",
                                     model=model, profile="tech_keynote")
            ru = res.translation
        except Exception as exc:  # noqa: BLE001
            ru = f"<error: {exc}>"
        ms = int((time.perf_counter() - t0) * 1000)
        rows.append((en, ru, ms))
        lats.append(ms)
    await tr.client.aclose()
    return rows, lats


def summarize(lats: list[int]) -> str:
    if not lats:
        return "n/a"
    s = sorted(lats)
    p90 = s[min(len(s) - 1, int(len(s) * 0.9))]
    return f"median {statistics.median(s)/1000:.1f}s  p90 {p90/1000:.1f}s  max {max(s)/1000:.1f}s"


async def main_async(args) -> None:
    if args.log:
        sentences = sample_from_log(Path(args.log), args.n)
        if not sentences:
            print("No usable sentences in log; using defaults.")
            sentences = DEFAULT_SENTENCES
    else:
        sentences = DEFAULT_SENTENCES

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    print(f"Sentences: {len(sentences)}  |  Models: {models}\n")

    results: dict[str, tuple] = {}
    for model in models:
        print(f"Running {model} ...")
        rows, lats = await bench_model(model, sentences)
        results[model] = (rows, lats)
        print(f"  {summarize(lats)}\n")

    # markdown report
    out = Path(args.out)
    lines = ["# Model benchmark\n",
             f"Sentences: {len(sentences)}\n",
             "## Latency summary\n",
             "| Model | Latency |", "|---|---|"]
    for model in models:
        lines.append(f"| {model} | {summarize(results[model][1])} |")
    lines.append("\n## Per-sentence comparison\n")
    for i, en in enumerate(sentences):
        lines.append(f"\n### {i+1}. {en}\n")
        lines.append("| Model | Russian | ms |")
        lines.append("|---|---|---|")
        for model in models:
            ru, ms = results[model][0][i][1], results[model][0][i][2]
            ru_cell = ru.replace("|", "\\|").replace("\n", " ")
            lines.append(f"| {model} | {ru_cell} | {ms} |")
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {out}")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--models",
                    default="translategemma:12b,aya-expanse:8b,qwen2.5:3b")
    ap.add_argument("--log", default=None, help="sample sentences from this jsonl log")
    ap.add_argument("--n", type=int, default=12, help="sentences to sample from --log")
    ap.add_argument("--out", default="bench_result.md")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
