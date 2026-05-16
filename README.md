# Yandex Live Subtitles Translator

> Local English → Russian live subtitle translator for Yandex Browser. Runs entirely on your machine through Ollama, no cloud APIs.

Russian docs: **[README.ru.md](README.ru.md)** · Architecture: **[docs/app-overview.md](docs/app-overview.md)** · Quality metrics: **[docs/translation-quality-metrics.md](docs/translation-quality-metrics.md)**

---

## What it does

Yandex Browser produces real-time English subtitles on YouTube, conference streams, podcasts and most online videos. This project picks those subtitles up, translates them to Russian locally with a self-hosted LLM, and renders the result either inside the browser or on a separate page suitable for vMix / OBS as a browser source.

The whole pipeline runs on the user's PC. Nothing leaves the machine.

## How it works

```
┌───────────────────────┐
│   Yandex Browser      │  built-in ASR produces English subtitles
│   live subtitles      │  (shadow DOM or via remote debugging port)
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐    ┌───────────────────────────────┐
│  Browser extension    │ ←→ │  CDP reader (FastAPI, :8766)  │
│  (MV3, content+inject)│    │  fallback for closed shadow   │
│                       │    └───────────────────────────────┘
│  - segmenter          │
│  - dedup + overlap    │
│  - pause handling     │
│  - context reset      │
└──────────┬────────────┘
           │ POST /translate
           ▼
┌─────────────────────────────────────────────────────────┐
│  Translator server (FastAPI, :8765)                     │
│  - glossary + ASR corrections                           │
│  - prompt assembly (polished / concise styles)          │
│  - session name cache                                   │
│  - output filter: placeholders, quotes, English prefix  │
└──────────┬─────────────────────────────────────┬────────┘
           │ /api/chat                           │ /current
           ▼                                     ▼
┌────────────────────┐               ┌────────────────────────┐
│  Ollama            │               │  Overlay               │
│  translategemma    │               │  - in-page overlay     │
│  :12b              │               │  - /overlay HTML page  │
│                    │               │    for vMix / OBS      │
└────────────────────┘               └────────────────────────┘
```

### Components

| Folder | What's inside |
|---|---|
| `extension/` | Browser extension (Manifest V3). Reads subtitles from the page, segments live text, sends to backend, draws the overlay. |
| `translator-server/` | Local FastAPI backend on `127.0.0.1:8765`. Handles glossary, prompt, output cleanup, caches and logs. |
| `subtitle-cdp-reader/` | Tiny FastAPI bridge on `:8766` that reads subtitles via Chrome DevTools Protocol when the page hides them behind a closed shadow root. |
| `scripts/` | Windows setup, doctor, cleanup and launcher PowerShell scripts. |
| `tools/` | Log analyzer with live-translation quality metrics. |
| `docs/` | Architecture and metrics documentation. |

### Translation model

Default model is **`translategemma:12b`** (Google's translation-specialized variant of Gemma, ~7 GB). Pulled automatically by `setup_windows.bat`. Runs in Ollama on the local machine.

Two prompt styles are user-selectable from the extension options:

- **`красивый` / polished** — literary, natural Russian, slightly longer than the English source (default).
- **`короткий` / concise** — close to source length, optimized for two-line overlay readability.

### Live-text stabilisation

Live subtitles arrive as a sliding window that updates every few hundred milliseconds. To avoid translating each intermediate state, the extension:

- waits for a short pause before committing;
- commits faster on natural sentence boundaries (`.!?`);
- holds suspicious short fragments;
- drops weak fragment endings (`and`, `to`, `the`, `with`…);
- de-duplicates against a 45-second window of recently sent phrases;
- resets the segmenter, queue and translator memory after 15 seconds of silence (configurable).

Output post-processing strips:

- placeholder leaks like `[name of company]`, `{placeholder}`;
- XML-like tags the model occasionally emits (`<unk>`, `<translation>`);
- unbalanced quotes / brackets;
- orphan lowercase English words at the start of the Russian line.

A session-scoped name cache stabilises proper nouns: if the model translates a name one way the first time, the same Russian spelling is preferred for the rest of the broadcast.

---

## Quick start (Windows)

1. Copy the folder anywhere.
2. Install three tools manually:
   - [Python 3.11–3.13](https://www.python.org/downloads/) (tick *Add to PATH*).
   - [Yandex Browser](https://browser.yandex.ru).
   - [Ollama](https://ollama.com/download).
3. Run `setup_windows.bat`. It creates venvs, installs deps, and offers to download `translategemma:12b` (~7 GB).
4. Run `doctor.bat` to verify everything is green.
5. Load the extension in Yandex Browser: `chrome://extensions` → Developer mode → Load unpacked → pick the `extension/` folder.
6. Run `run_all_servers.bat` and start a video with subtitles enabled.

Detailed Russian instructions: **[README.ru.md](README.ru.md)**.

### Helper scripts

| Script | Purpose | When to run |
|---|---|---|
| `setup_windows.bat` | First-time install: venvs, deps, model download | Once per machine |
| `run_all_servers.bat` | Start translator, CDP reader, Yandex with debug port | Before each broadcast |
| `doctor.bat` | Read-only health check with actionable hints | When something seems off |
| `cleanup.bat` | Interactive cleanup of logs, stuck processes, configs | Weekly maintenance |

---

## Endpoints

| URL | What it is |
|---|---|
| `http://127.0.0.1:8765/health` | Translator server health |
| `http://127.0.0.1:8765/translate` (POST) | Main translation endpoint |
| `http://127.0.0.1:8765/current` | Latest translation, polled by overlay |
| `http://127.0.0.1:8765/overlay` | HTML overlay page (use as a browser source in vMix / OBS) |
| `http://127.0.0.1:8765/context/reset` (POST) | Wipe translator session memory |
| `http://127.0.0.1:8766/health` | CDP reader health |
| `http://127.0.0.1:9222/json` | Yandex Browser debug port |

Overlay URL accepts query parameters: `font_size`, `bottom`, `max_width`, `opacity`, `hide_after_ms`, `poll_ms`, `min_display_ms`, `slide_ms`.

Example:

```
http://127.0.0.1:8765/overlay?font_size=42&bottom=7&max_width=88&opacity=0.72&hide_after_ms=6000
```

---

## Performance on the latest run

Measured from `logs/translations_20260516_132417.jsonl` — 241 translations of a live Google I/O keynote, model `translategemma:12b`, prompt style `concise`, on i7-12700K + RTX 4070 Ti + 64 GB RAM.

### Latency (ms)

| Stage | min | median | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| Model only | 527 | **1 312** | 1 879 | 1 955 | 2 391 | 2 688 |
| English subtitle → overlay shown | 592 | **1 766** | 3 441 | 4 101 | 4 934 | 7 558 |
| Commit → overlay shown | 533 | 1 367 | 1 900 | 2 031 | 2 397 | 2 693 |

### Quality (live-translation scorer, 0–100)

| Metric | Value |
|---|---|
| Records / errors | 241 / 0 |
| Average Russian-to-English length ratio | **1.15** (target ≤ 1.20) |
| Verbose lines (ratio > 1.35) | 17% |
| Placeholder leaks | 0 |
| Unbalanced quotes / brackets | 0 |
| CJK / Hebrew / Arabic artifacts | 0 |
| Weak fragment endings sent to model | 0 |
| Proper-noun inconsistencies | 6 |
| Sliding-window duplicate inputs | 0 |
| **Technical live score** | **97.5 / 100** |

### Recommended video delay

To keep the Russian overlay aligned with picture-and-sound, add a ~5 second delay to the video signal. This covers 99% of all translations.

| Coverage | Delay |
|---|---|
| 90% | 3.5 s |
| 95% | 4.5 s |
| **99%** | **5 s (recommended)** |
| 100% | 7 s |

The remaining ~1 second of total mouth-to-overlay lag is Yandex's own ASR latency (which we don't control).

---

## Features at a glance

- 🔒 **Fully local.** No cloud APIs, no telemetry, no account.
- 🧠 **Translation-specialized model** (`translategemma:12b`), not a general chat LLM.
- 📚 **Glossary** with ASR corrections and product-name preservation (Google I/O, WWDC, MS Build vocabulary built-in).
- 🎚 **Two prompt styles** for literary vs subtitle-optimised output.
- 🧹 **Output filter** removes placeholders, broken quotes, model tags, orphan English prefixes.
- 🧷 **Session name cache** keeps proper nouns stable across a broadcast.
- ⏸ **Smart pause handling**: undelivered fragments are dropped after 5 s of silence; full context reset after 15 s.
- 🔘 **Manual memory reset** button in the extension options for the warmup → broadcast transition.
- 📊 **Quality metrics** scorer in `tools/evaluate_translation_logs.py`.
- 🖥 **vMix / OBS ready** via `/overlay` HTML browser source.

---

## License

MIT (see `LICENSE` if present).

## Acknowledgements

- [Ollama](https://ollama.com/) for the local LLM runtime.
- Google's TranslateGemma checkpoint, packaged for Ollama.
- Yandex Browser team for the in-browser live ASR that this project relies on as a source.
