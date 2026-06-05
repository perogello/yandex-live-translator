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

## 2026-05-31: Route YouTube CC through the segmenter (fix overlap/fragmentation)

Context:
- Log `translations_20260531_021647.jsonl` was a real WWDC run on YouTube CC in "короткий" mode. Metrics were excellent (0 drops, median 2.1s, max 5.3s, 0.6% overlay dups) but the TEXT had clear problems:
  - "Liquid Glass" split across caption windows and mistranslated ("we call liquid" -> "...жидкость"; "call liquid glass." -> "позвоните в Liquid Glass").
  - 28% of chunks repeated >=2 words of the previous chunk (visible repeats).
  - 47% of chunks were mid-sentence continuations (choppy fragments, wrong mid-sentence capitals).
  - Common words like "the material" left in English as "Material".
- Root cause: the live-reader path `handleText()` in `content.js` did NOT use `SubtitleSegmenter`; it sent the whole rolling caption window after a debounce. Only the CDP path (`handleCdpText`) used the segmenter, which is why the Yandex CDP broadcast log was clean while YouTube was fragmented.

Changed:
- `extension/src/content.js` `handleText()`: route live reads (YouTube CC and open-shadow Yandex) through the same `segmenter.push()` the CDP path uses, enqueueing its sentence-level commits. Kept the legacy naive debounce only as a fallback when no segmenter is available.
- No change to model, prompt, glossary, segmentation thresholds, queue policy, or the CDP path.

Validation (simulation on the real log via `scripts/sim_youtube_segmenter.js`, replaying the log's caption windows through the actual segmenter):
- chunks 791 -> 371 (whole sentences)
- overlapping-previous 28% -> 1%
- mid-sentence continuations 47% -> 9%
- "Liquid Glass" now committed intact: "...an entirely new expressive material we call liquid glass."
- Residual (minor, pre-existing segmenter behavior): ~9% still start lowercase; 2/371 had a doubled word at a stitch boundary ("concentric concentric"). Left as-is (segmenter is tested code; risk not worth 2 cases).
- `node --check extension\src\content.js`; `node scripts\test_segmenter.js`; `node scripts\test_youtube_reader.js` all pass.
- Locked the fix with a regression test in `scripts/test_segmenter.js` ("stitch rolling window so multi-word term stays intact").
- Added `scripts/run_all_tests.ps1` as a single suite runner (JS unit tests + node --check + Python cleanup test); run with `powershell -ExecutionPolicy Bypass -File scripts\run_all_tests.ps1`.

## 2026-05-31: Test suite redesign for full-pipeline coverage

Context:
- The suite only covered segmentation, the YouTube reader, and glossary ASR corrections. Several pipeline stages with real failure history were untested: overlay dedup, translation post-processing (clean/align/bad-russian), output corrections, and timing metrics had no regression gate.

Coverage map now (stage -> test):
- Ingestion (YouTube CC)      -> `test_youtube_reader.js`
- Segmentation / stitching    -> `test_segmenter.js`
- Overlay near-duplicate dedup-> `test_overlay.js` (NEW)
- Translate: ASR corrections  -> `test_translation_cleanup.py`
- Translate: post-processing  -> `test_translation_postprocess.py` (NEW)
- Timing / overlay metrics    -> `analyze_overlay_log.py --check` (opt-in gate)

Added:
- `scripts/test_overlay.js`: unit tests for `SubtitleOverlay.areNearDuplicates` (exact, contained revisions, unrelated rows kept, case/punctuation-insensitive). Run in a vm sandbox; no DOM needed.
- `scripts/test_translation_postprocess.py`: tests for `clean_ollama_response` (prefix/quote/ellipsis/placeholder/unbalanced-quote/echoed-English), `align_subtitle_punctuation` (fragment vs complete period, dialogue dashes), `looks_bad_russian` (CJK/all-Latin/empty), and `Glossary.apply_output_corrections` (Liquid Glass, Siri, Gemini restoration).
- `analyze_overlay_log.py`: `--check` flag that returns the verdict metrics and exits non-zero if drops>2%, duplicates>6%, or high-latency>20% (thresholds from clean reference logs with headroom). Opt-in so normal variance does not break CI; used to gate a freshly collected log.
- `run_all_tests.ps1`: updated to run all JS+Python tests grouped by stage (47 assertions total).

Known gap (intentionally not closed):
- `content.js` helper predicates (overlapRatio, looksIncomplete, isLikelyContinuation, shouldDropChunk, splitFirstCompleteSentence) live inside an IIFE and are not exported, so they are untested. Extracting them is a refactor with regression risk on the live read path; deferred. The segmenter (which content.js now delegates to) is well covered, which mitigates most ingestion-quality risk.

Validation:
- `powershell -ExecutionPolicy Bypass -File scripts\run_all_tests.ps1` -> ALL TESTS PASSED
- `python scripts\analyze_overlay_log.py --check logs\translations_20260531_021647.jsonl` -> CHECK PASSED

## 2026-05-31: Extract content.js pure predicates into segment-utils.js

Context:
- The 2026-05-31 suite redesign left the content.js helper predicates untested because they lived inside the content.js IIFE and were not exported. The operator approved a careful extraction (will do a live run afterwards).

Changed:
- New `extension/src/segment-utils.js` exposes `window.YaSegmentUtils` with 12 pure predicates moved verbatim from content.js: isFastPunctuation, looksIncomplete, hasHardIncompleteTail, isSentenceBoundary, splitFirstCompleteSentence, wordsOf, normalizedWords, overlapRatio, shouldDropChunk, isLikelyContinuation, isUnsafeFinalFragment, isHoldableFragment.
- `content.js`: deleted those 12 definitions and bound the same names via `const { ... } = window.YaSegmentUtils` near the top, so every existing call site is unchanged. `shouldWaitForFullerSentence` stays in content.js (it depends on settings + *_STALE_MS constants).
- `manifest.json`: load `src/segment-utils.js` before `src/content.js`.
- New `scripts/test_segment_utils.js` (24 assertions) wired into `run_all_tests.ps1`.

Safety:
- Proved byte-identical: extracted each of the 12 bodies from `git show HEAD:...content.js` and from segment-utils.js; after normalizing the `window.YaSubtitleNormalizeText`->`normalize` token and whitespace, all 12 match exactly. `normalize()` in the module delegates to `window.YaSubtitleNormalizeText` when present (always true in the extension), so runtime behavior is unchanged.
- This closes the previously-documented "known gap". Only `shouldWaitForFullerSentence` remains content.js-local (not pure).

Validation:
- `node scripts\test_segment_utils.js` (24/24), full `run_all_tests.ps1` -> ALL TESTS PASSED.
- Pending: operator live run (YouTube + Yandex) to confirm no regression on the real read path.

## 2026-05-31: Fix garble regression from YouTube->segmenter routing

Context:
- First post-fix live YouTube run: `logs/translations_20260531_033601.jsonl`. Compared against the pre-fix run `021647`.
- The routing fix DID help (Liquid Glass intact live, continuations 47%->35%) but the metric analyzer plus a custom phrase-repeat scan exposed a REGRESSION the simulation had missed (the sim was fed pre-committed coarse chunks, not raw polls):
  - internal-repeat (garbled commits, a 3+ word phrase duplicated inside one commit): pre-fix 0% -> post-fix 6% (45/753). Example: "I'm going to start with two things that are foundational going to start with two".
  - seam overlap (>=4 words shared between consecutive commits): 10% -> 12%.
  - latency tail: seen->overlay max 5.3s -> 14.8s, high-latency(>4s) 0.3% -> 4.6%. This tail is the segmenter waiting for whole sentences (inherent cost of coherent output); only ~0.4% are truly bad (>8s). Left as an accepted trade for now.
- Root cause of garble: the segmenter (built for Yandex grow-then-reset windows) hits its reset branch on YouTube's rolling-scroll window when overlap detection fails, concatenating old segment + new window.

Changed:
- New pure helper `collapseRepeatedPhrases(text)` in `segment-utils.js`: finds a 3+ word phrase repeated non-adjacently inside one commit and removes the duplicate WITHOUT losing content - if little follows the 2nd occurrence it is a trailing re-append (keep the full first version), otherwise a revision (keep the later, more complete version). removeRepeatedTail only handled adjacent repeats.
- `content.js` `cleanSourceForTranslation()` calls it (after removeRepeatedTail, before stripOverlapPrefix), so it cleans every enqueue path. No model/segmenter-timing change.
- 4 new assertions in `scripts/test_segment_utils.js`.

Replay on `033601`:
- 46 rows rewritten; internal-repeat 45 -> 0; content preserved (revision cases keep the longer version, e.g. "...all trails can use our ondevice models...").

Validation:
- full `run_all_tests.ps1` -> ALL TESTS PASSED.
- Pending: next live YouTube run + `analyze_overlay_log.py --check` to confirm garble is gone in the wild.

## 2026-05-31: Garble fix confirmed live; fix seen->overlay latency metric artifact

Context:
- Third live YouTube run `logs/translations_20260531_122432.jsonl` compared with `033601` and `021647`.
- collapseRepeatedPhrases confirmed working in the wild: internal-repeat (garbled commits) 6.0% (033601) -> 0.0% (122432). Drops 0%, overlay duplicates 0.9%. CHECK PASSED.

Latency investigation (operator specifically asked about processing + output time):
- REAL processing + output time = commit->overlay (model + queue + render). Rock stable across all three logs: median ~1.6-2.0s, p90 ~2.2-3.3s, max ~4.5-4.9s. This is the honest answer: output latency is excellent and not regressing.
- The scary seen->overlay tail (max 31.9s, "you use every day.") is a MEASUREMENT ARTIFACT, not real delay. Proof: that phrase recurred ~28s earlier in the talk; `firstSeenFor` fuzzy-matched the stale occurrence and reported a 30s wait (round numbers 30000/14001/13000 gave it away). The segmenter routing made this worse only because it accumulates more source-seen keys for the fuzzy match to hit.

Changed:
- `content.js` `firstSeenFor`: added `FIRST_SEEN_MAX_LOOKBACK_MS = 12000` cap. A prior sighting older than 12s is ignored (a live sentence finishes building in a few seconds; older = a recurring phrase, not the same utterance). Applies to both the exact-key and fuzzy-match branches. Telemetry-only value (never used for behavior), so zero behavior risk; it just keeps the seen->overlay metric honest going forward.

Takeaways:
- Real output latency: ~2s median, <5s worst (commit->overlay). Good.
- Garble regression from the segmenter routing: fixed (0% live).
- Latency "regression" in seen->overlay was a metric artifact, now capped.

Validation:
- `node --check extension/src/content.js`; full `run_all_tests.ps1` -> ALL TESTS PASSED.
- Pending: next run's seen->overlay tail should drop to <=12s (artifact bounded).

## 2026-05-31: Translation-quality review of 122432; fix English-prefix leak

Context:
- Operator asked for a qualitative review of the actual Russian (quality, terms, duplicates, speed), not just metrics. Read a long contiguous stretch of `122432`.

What is good:
- Full sentences are natural, fluent Russian; product terms held correctly (Liquid Glass, visionOS, Apple silicon, iOS 7, Retina).
- Speed: real output latency (commit->overlay) ~2s median, <5s max.
- Garbled internal-repeats 0% live; drops 0%; overlay duplicates ~0.9%.

Problems found (scanned the whole log):
- English leak at line start (2 lines): a leaked sentence-tail word echoed before the translation, e.g. "use. iOS 7 представила...", "layout. Теперь...". The existing _strip_lone_english_prefix missed these because the next token was a kept term ("iOS"), not Russian.
- "Material" left capitalized once ("...приложением. Material динамически...") - model treats the common noun as a product name. 1 occurrence; left as-is (an output rule risks Material Design / is low value).
- Seam-overlap choppiness (~12% of commits share boundary words with the previous), producing some redundant/choppy lines ("доступных, чем"; "Этап готов к использованию в течение дня."). This is the rolling-window seam, not garble. Needs segmenter-level work; deferred (higher risk).

Changed:
- `ollama.py` `_strip_lone_english_prefix`: added a second branch that strips a leaked English word carrying trailing punctuation ("use.", "touch.", "layout.") when the source also starts with it, even if the real translation begins with a kept term. Verified it does NOT strip a legitimately leading kept term (Liquid Glass) or a leading Russian word.
- 2 new assertions in `scripts/test_translation_postprocess.py`.

Validation:
- full `run_all_tests.ps1` -> ALL TESTS PASSED.

## 2026-05-31: YouTube segmenter plan (Stage 0 - raw-read capture)

Decision:
- Fix YouTube seam-overlap/choppiness with a YouTube-ISOLATED path; do NOT touch the shared segmenter's Yandex behavior (works well, higher risk). YouTube = rolling-scroll window; Yandex = grow-then-reset; genuinely different, so split handling.
- Root cause of seams: appendSlidingWindow matches the LAST raw read's tail vs the new read's head; on a scrolling window that often fails and hits the destructive `reset` branch, dumping context and committing a fragment ("The stage", "доступных, чем").

Plan (staged, in a worktree, A/B on real data before merge):
- Stage 0 (DONE): capture real raw reads to build a corpus (can't fix blind - logs only had commits).
- Stage 1: reconstruct the new suffix by aligning the current read against the END of the accumulated segment (not just the last read); remove the destructive reset.
- Stage 2: seam guard - strip a new commit's leading words duplicating the previous commit's tail.
- Stage 3: regression tests from the captured corpus (+ content-loss check).
- Stage 4: A/B old vs new on the corpus (target seam>=4w 12% -> <5%, internal-repeat stays 0%, no content loss), one live run, then merge.

Stage 0 implementation (behind the extension debug flag, zero behavior change):
- main.py: POST /debug/raw-read writes event:"raw_read" into the same per-run translations JSONL.
- translator-client.js: captureRawRead(text, source).
- content.js: in tick, when settings.debug and YouTube reader active, send each DISTINCT raw read.
- Collect: enable Debug in options, run ~5 min on YouTube with CC, send the log. Raw reads = event:"raw_read".

Validation: node --check (content.js, translator-client.js), py_compile app/main.py, full run_all_tests.ps1 -> ALL PASSED.

## 2026-05-31: Stage 1 - YouTube stitcher (kills seam/choppiness)

Context:
- Corpus captured (4583 raw reads, log 134428). Baseline replay confirmed the seam is severe: raw segmenter 40% seam, real post-cleanup 12% seam, 36% mid-sentence continuations.
- Root cause (verified on real reads, e.g. the "June 27th" sequence): the rolling window itself is CLEAN (suffix==prefix overlap works for growth and front-scroll). The seam came from the shared segmenter FORCE-committing a mid-sentence fragment by age while the sentence was still completing; the next read then re-committed it in full.

Changed (YouTube-isolated; Yandex untouched):
- New `extension/src/youtube-stitcher.js` (`window.YouTubeStitcher`): reconstructs one continuous transcript from the rolling window (append only the new tail via suffix==prefix overlap; handles front-scroll and the tail-inside-read scroll case) and commits on SENTENCE boundaries. Patient with an unfinished tail (only force at 9s / >=10 words), plus a hard length cap (36 words) so un-punctuated auto-CC never holds/drops. Reuses segment-utils predicates + collapseRepeatedPhrases.
- `content.js`: instantiate the stitcher only when the YouTube reader is active; `liveSource = youtubeStitcher || segmenter`. handleText, the idle-flush, and resetLiveContext use `liveSource`. The Yandex CDP path (handleCdpText) still uses the shared segmenter directly.
- `manifest.json`: load youtube-stitcher.js before content.js.
- New `scripts/test_youtube_stitcher.js` (5 cases) + `scripts/ab_youtube_stitcher.js` (corpus A/B). Both wired/available; test added to run_all_tests.ps1.

A/B on the real corpus (134428), stitcher vs the log's actual live commits:
- seam >=4w: 12% -> 0%
- mid-sentence continuations: 36% -> 1%
- internal-repeat: 0% -> 0%
- content coverage baseline->stitcher: 99.9% (no lost text)

Trade: commits whole sentences, so per-sentence latency = sentence speak-time + model (no artificial extra wait; force caps the tail). Quality over choppiness, as intended.

Validation: full run_all_tests.ps1 -> ALL TESTS PASSED. Pending: operator live YouTube run to confirm in the wild; trivial revert (one path switch) if worse.

## 2026-05-31: Decouple raw-read capture from the debug flag

Context:
- Operator keeps the Debug panel ALWAYS on. The Stage 0 raw-read capture was gated on settings.debug, so it ran constantly on YouTube (~1.6 POST/sec to the server + ~12x log bloat), competing with /translate and likely contributing to the latency seen in log 134428.
- The debug PANEL itself is cheap (local DOM textContent only, no network/model) and is fine to leave on.

Changed:
- New setting `captureRawReads` (default FALSE) in settings.js, with an options checkbox "Capture raw reads (diagnostics; keep OFF for normal use)".
- content.js: the raw-read trigger now checks `settings.captureRawReads` instead of `settings.debug`.
- Result: always-on debug is overhead-free; raw-read corpus capture only runs when explicitly enabled.

Operator guidance:
- Debug panel: fine to leave on (no latency cost).
- Capture raw reads: keep OFF for normal use / broadcasts; enable only when asked to collect a segmenter corpus.

Validation: node --check (content.js, settings.js, options.js); full run_all_tests.ps1 -> ALL TESTS PASSED.

## 2026-06-05: Gemma 4 12B research note

Context:
- Operator asked whether new Gemma 4 12B can bring value even though it is not a dedicated translation model.
- Local pipeline remains centered on `translategemma:12b`; recent stability work is mostly source/segmentation/overlay safety, not model replacement.

Findings:
- Official Google docs describe Gemma 4 12B as a multimodal instruction model with text/image/audio input, text output, multilingual capability, audio handling up to 30 minutes, and 128K context.
- It is theoretically useful for ASR repair, suspicious-segment QA, offline log analysis, and future direct audio-to-text/audio-to-translation experiments.
- It is NOT a safe live replacement for TranslateGemma without A/B testing on real logs. General models can be stronger at reasoning while still hurting Russian fluency, product-name preservation, or live latency.
- Current Ollama path is not clearly plug-and-play for Gemma 4 12B on the existing Windows/NVIDIA setup; official Ollama docs emphasize Gemma 4 4B and note audio multimodal limitations.

Decision:
- Keep `translategemma:12b` as the live default.
- If Gemma 4 12B becomes locally runnable, add it only as a benchmark/research candidate first.
- Safest possible role: fallback/checker for damaged ASR or suspicious segments, not primary live translator.
