from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any


class TranslationLogger:
    def __init__(self, path: str, enabled: bool = True, per_run: bool = True):
        self.enabled = enabled
        self.path = Path(path)
        if not self.path.is_absolute():
            self.path = Path(__file__).resolve().parents[3] / self.path
        if per_run:
            started_at = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.path = self.path.with_name(f"{self.path.stem}_{started_at}{self.path.suffix}")
        self._lock = Lock()

    def write(self, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            **payload,
        }
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as file:
                file.write(line + "\n")
