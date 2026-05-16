from __future__ import annotations

import asyncio
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from read_subtitles import CDP_URL, inspect_tab, list_tabs


app = FastAPI(title="Yandex Subtitle CDP Reader", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


last_error: str | None = None
last_text: str = ""
last_lines: list[str] = []
last_text_at: float = 0.0
LAST_TEXT_GRACE_SEC = 3.0
MIN_POLL_INTERVAL_SEC = 0.35
inspect_lock = asyncio.Lock()


def cached_response(started: float, source: str) -> dict:
    return {
        "ok": True,
        "text": last_text,
        "lines": last_lines,
        "stale": True,
        "source": source,
        "latency_ms": int((time.perf_counter() - started) * 1000),
    }


@app.get("/health")
async def health() -> dict:
    try:
        tabs = await list_tabs(CDP_URL)
        return {
            "ok": True,
            "tabs": len(tabs),
            "last_error": last_error,
        }
    except Exception as exc:
        return {
            "ok": False,
            "tabs": 0,
            "last_error": str(exc),
        }


@app.get("/subtitles")
async def subtitles(url_contains: str = "youtube") -> dict:
    global last_error, last_text, last_lines, last_text_at

    started = time.perf_counter()
    try:
        now = time.perf_counter()
        if last_text and now - last_text_at < MIN_POLL_INTERVAL_SEC:
            return cached_response(started, "cdp-cache-fresh")
        if inspect_lock.locked() and last_text and now - last_text_at < LAST_TEXT_GRACE_SEC:
            return cached_response(started, "cdp-cache-busy")

        async with inspect_lock:
            now = time.perf_counter()
            if last_text and now - last_text_at < MIN_POLL_INTERVAL_SEC:
                return cached_response(started, "cdp-cache-fresh")

            tabs = await list_tabs(CDP_URL)
            candidates = [tab for tab in tabs if url_contains.lower() in tab.url.lower()]
            if not candidates:
                candidates = tabs
            errors = []
            for tab in candidates:
                try:
                    data = await asyncio.wait_for(inspect_tab(tab), timeout=1.5)
                except Exception as exc:
                    errors.append(f"{tab.title}: {exc}")
                    continue
                text = data.get("text", "")
                if text:
                    lines = data.get("lines") or []
                    last_error = None
                    last_text = text
                    last_lines = [str(line) for line in lines if str(line).strip()]
                    last_text_at = time.perf_counter()
                    return {
                        "ok": True,
                        "text": text,
                        "lines": last_lines,
                        "title": tab.title,
                        "url": tab.url,
                        "source": "cdp",
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                    }
        if last_text and time.perf_counter() - last_text_at < LAST_TEXT_GRACE_SEC:
            return {
                "ok": True,
                "text": last_text,
                "lines": last_lines,
                "stale": True,
                "source": "cdp-cache",
                "errors": errors[-3:],
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        return {
            "ok": True,
            "text": "",
            "lines": [],
            "source": "cdp",
            "errors": errors[-3:],
            "latency_ms": int((time.perf_counter() - started) * 1000),
        }
    except Exception as exc:
        last_error = str(exc)
        raise HTTPException(status_code=503, detail=last_error) from exc
