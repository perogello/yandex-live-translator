# Project Memory

## 2026-05-19: Overlay repeat protection after OtherPC4 logs

Context:
- OtherPC4 logs showed repeated phrases in the overlay, but backend logs did not show matching duplicate translation/subtitle events.
- The likely cause was display-side backlog: stale `pendingRows` from a previous sliding ASR segment stayed in the overlay queue while a newer near-duplicate segment arrived.

Changed:
- `extension/src/overlay.js`: when a new overlay message is near-duplicate to pending rows, replace the pending queue with the newer message instead of appending it.
- `translator-server/app/main.py`: applied the same logic to the standalone web overlay HTML.
- Capped overlay pending rows from 8 to 4 to reduce stale backlog during bursts.

Scope:
- Display-only fix.
- No model, prompt, glossary, segmentation, ASR correction, or translation behavior changed.
- Intended to reduce visible repeated rows without making translation slower or less accurate.

Validation:
- `node --check extension\src\overlay.js`
- `node --check extension\src\content.js`
- `node scripts\test_segmenter.js`
- `cd translator-server; .\.venv\Scripts\python.exe -m py_compile app\main.py`
- `cd translator-server; .\.venv\Scripts\python.exe -c "import app.main; print('ok')"`

Follow-up local test:
- Reproduced a stale queue edge case: when a newer near-duplicate replaced the already visible row, duplicate rows could remain in `pendingRows` and appear later.
- Fixed by filtering only pending rows already covered by the visible/new message.
- Verified exact duplicate x4, stale pending duplicate cleanup, unrelated pending row preservation, and sliding ASR expansion collapse.

## 2026-05-19: Safer YouTube CC source reader

Context:
- `otherPC_youtube` was faster than Yandex ASR, but logs showed YouTube UI text leaking into source subtitles.
- Example issue: language/settings text was concatenated with real English speech before translation.
- Another issue: some captions repeated the same phrase inside one source line.

Changed:
- `extension/src/subtitle-reader-youtube.js`: read only visible YouTube caption line/segment nodes instead of broad container text.
- Filter YouTube settings/language UI text before it reaches the translator.
- Collapse adjacent repeated word runs inside one caption read.
- Remove pure non-speech caption cues such as `[APPLAUSE]` and `[SPEAKING SPANISH]` before model translation.
- Did not add automatic fallback switching between YouTube and Yandex sources.

Validation:
- `node --check extension\src\subtitle-reader-youtube.js`
- `node scripts\test_youtube_reader.js`
- `node scripts\test_segmenter.js`
- `node --check extension\src\content.js`

## 2026-05-21: Live Yandex ASR cleanup after real broadcast log

Context:
- `otherPC_live` was the real live broadcast run with Yandex subtitles in short style.
- The run was stable, but Yandex ASR repeatedly damaged Google I/O terms such as `Med-PaLM 2`, `PaLM 2`, `PaLM API`, `Bard`, `state-of-the-art`, `C++, Go`, and `Dino game`.
- One model output leaked a `[неразборчиво]` placeholder that was not present in the source.

Changed:
- Added narrow deterministic ASR corrections for the observed Google I/O term errors.
- Added contextual `bart` -> `Bard` correction only around coding/product availability contexts, preserving unrelated `Bart`.
- Added placeholder cleanup keywords for model-inserted `[неразборчиво]` / `inaudible` / `unclear`.
- Did not change model, prompt style, segmentation timing, queue policy, or source fallback behavior.

Replay on `otherPC_live`:
- 55 / 2091 source lines are corrected before model translation.
- Term corrections found: `Med-PaLM 2` 2, `PaLM 2` 11, `PaLM API` 5, `Bard` 7, `state-of-the-art` 3, `C++, Go` 2, `Dino game` 1.
- Placeholder leaks: 1 before cleanup, 0 after cleanup.

Validation:
- `cd translator-server; .\.venv\Scripts\python.exe ..\scripts\test_translation_cleanup.py`
- `cd translator-server; .\.venv\Scripts\python.exe -m py_compile app\translator\ollama.py app\glossary\loader.py`
- `node scripts\test_segmenter.js`
- `node scripts\test_youtube_reader.js`

## 2026-05-30: WWDC glossary + overlay log analysis tooling

Context:
- New project target: Apple WWDC keynote (English Yandex/YouTube subtitles -> Russian).
- Reviewed `otherPC_youtube` and `otherPC_live` logs (both 2026-05-19, weak PC with 4060 Ti).
- `otherPC_youtube`: clean; the 3 UI-text leaks ("Английский - CC / нажмите на значок") predate the `stripUiNoise` fix and are already handled.
- `otherPC_live`: real Yandex broadcast, very clean. 2090 overlay rows, 0 broken translations, only 4 exact-duplicate sources, high Russian quality. Remaining EN garble is Yandex ASR error, not ours.

Changed:
- `glossary.yaml`: added WWDC/Apple `keep` terms (Siri, Genmoji, Image Playground, Visual Intelligence, Live Translation, Foundation Models, App Intents, SwiftData, Vision Pro, visionOS, M4/M5, A18/A19, Neural Engine, devices, Apple speakers), Apple `translate` entries (Private Cloud Compute, on-device model...), ASR corrections (visionOS, Genmoji, SwiftUI, macOS...), and output corrections (Сири->Siri, Liquid Glass, Vision Pro).
- New `scripts/analyze_overlay_log.py`: per-log report of DROPS (translated but never shown), DUPLICATES (exact / contained-revision / near), and LATENCY split into SEGMENTER (seen->commit) vs QUEUE+MODEL (commit->overlay), with per-row breakdown of the worst rows.
- New `scripts/simulate_overlay_dedup.py`: dry-run of a conservative revision-dedup rule (replace/drop only on contiguous word-containment) with a content-loss check.
- New `scripts/bench_models.py`: compare models through the real OllamaTranslator pipeline (latency + Russian quality).

Findings (decisions, not just data):
- Model stays `translategemma:12b`. Local bench (4070 Ti) over 12 keynote/Apple sentences: translategemma median 1.2s with best quality and perfect product-name handling; `aya-expanse:8b` 2.4x faster but mangles product names (Genmoji->Генмоji, translated "Live Translation"); `qwen2.5:3b` 4x faster but breaks (English leakage, grammar). For a name-heavy WWDC keynote, quality wins.
- The translation QUEUE is already optimal: `MAX_TRANSLATION_QUEUE = 2`, and the QUEUE+MODEL phase never exceeds ~5.4s on the weak PC. Nothing to fix there.
- The 15s overlay spikes are the SEGMENTER waiting for a long sentence to stabilize (`qualityMaxWaitMs` floored at 5600ms), affecting only ~1.2% of chunks; 98.8% are near-instant. Open decision: leave as-is (zero risk) vs add a ~5s hard ceiling on segmenter hold (trims the tail but may send slightly-less-complete fragments on that 1.2%). Leaning leave-as-is.

Scope:
- Glossary-only translation change plus new read-only analysis scripts. No change to model, prompt, segmentation timing, queue policy, or source fallback.

Workflow:
- Collect a log on the weak PC during a run, then analyze HERE with `python scripts/analyze_overlay_log.py <log.jsonl>`. No need to run models on that PC.

Validation:
- `cd translator-server; .\.venv\Scripts\python.exe -c "import yaml; yaml.safe_load(open('app/glossary/glossary.yaml',encoding='utf-8'))"`
- `python scripts\analyze_overlay_log.py logs\_otherPC_live_extracted\translations_20260519_182255.jsonl`
- `python scripts\simulate_overlay_dedup.py logs\_otherPC_live_extracted\translations_20260519_182255.jsonl` (0 content loss)
