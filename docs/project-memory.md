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
