from __future__ import annotations

import asyncio
import logging
import os
import re
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import load_config
from app.translator import create_translator
from app.utils.cache import TranslationCache
from app.utils.logging import configure_logging
from app.utils.translation_log import TranslationLogger


configure_logging()
logger = logging.getLogger("translator-server")

CONFIG_PATH = os.environ.get("YA_TRANSLATOR_CONFIG", "config.yaml")
config = load_config(CONFIG_PATH)
translator = create_translator(config)
cache = TranslationCache(config.runtime.cache_size)
translation_logger = TranslationLogger(
    path=config.runtime.translation_log_path,
    enabled=config.runtime.log_translations,
    per_run=config.runtime.translation_log_per_run,
)
translate_lock = asyncio.Lock()
last_error: str | None = None
last_requested_model: str = ""
last_active_model: str = ""
last_profile: str = ""
current_subtitle: dict = {
    "original": "",
    "translation": "",
    "updated_at": 0.0,
    "activity_updated_at": 0.0,
    "pending_until": 0.0,
    "latency_ms": 0,
    "model": "",
    "backend": "",
}
warmup_status: dict = {
    "enabled": config.runtime.warmup_on_start,
    "done": False,
    "running": False,
    "latency_ms": 0,
    "error": "",
}

app = FastAPI(title="Yandex Live Subtitles Local Translator", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


async def warmup_model() -> None:
    if not config.runtime.warmup_on_start:
        return
    warmup_status.update({"running": True, "done": False, "latency_ms": 0, "error": ""})
    started = time.perf_counter()
    try:
        await asyncio.wait_for(
            translator.warmup(config.runtime.warmup_text),
            timeout=config.runtime.warmup_timeout_sec,
        )
        warmup_status.update(
            {
                "done": True,
                "running": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "error": "",
            }
        )
        logger.info("translator warmup complete latency_ms=%s", warmup_status["latency_ms"])
    except Exception as exc:
        warmup_status.update(
            {
                "done": False,
                "running": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "error": str(exc),
            }
        )
        logger.warning("translator warmup failed: %s", exc)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(warmup_model())


class TranslateRequest(BaseModel):
    text: str
    source_lang: str = "en"
    target_lang: str = "ru"
    model: str | None = None
    profile: str | None = None
    prompt_style: str | None = None
    client_first_seen_ms: float = 0.0
    client_committed_ms: float = 0.0
    client_enqueued_ms: float = 0.0
    client_request_started_ms: float = 0.0


class TranslateResponse(BaseModel):
    translation: str
    backend: str
    model: str
    cached: bool
    latency_ms: int


class SubtitleUpdateRequest(BaseModel):
    original: str = ""
    translation: str = ""
    backend: str = ""
    model: str = ""
    latency_ms: int = 0
    client_first_seen_ms: float = 0.0
    client_committed_ms: float = 0.0
    client_enqueued_ms: float = 0.0
    client_overlay_shown_ms: float = 0.0


class ActivityRequest(BaseModel):
    original: str = ""
    pending_for_sec: float = 8.0


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip()


def now_ms() -> int:
    return int(time.time() * 1000)


def elapsed_ms(later_ms: float, earlier_ms: float) -> int:
    if not later_ms or not earlier_ms:
        return 0
    return max(0, int(later_ms - earlier_ms))


def client_timing_payload(request: TranslateRequest, backend_received_ms: int) -> dict:
    return {
        "client_first_seen_ms": int(request.client_first_seen_ms or 0),
        "client_committed_ms": int(request.client_committed_ms or 0),
        "client_enqueued_ms": int(request.client_enqueued_ms or 0),
        "client_request_started_ms": int(request.client_request_started_ms or 0),
        "backend_received_ms": backend_received_ms,
        "client_seen_to_commit_ms": elapsed_ms(request.client_committed_ms, request.client_first_seen_ms),
        "client_commit_to_enqueue_ms": elapsed_ms(request.client_enqueued_ms, request.client_committed_ms),
        "client_queue_wait_ms": elapsed_ms(request.client_request_started_ms, request.client_enqueued_ms),
        "client_request_to_backend_ms": elapsed_ms(backend_received_ms, request.client_request_started_ms),
    }


def mark_translation_activity(original: str = "", pending_for_sec: float = 0.0) -> None:
    now = time.time()
    if original:
        current_subtitle["original"] = normalize_text(original)
    current_subtitle["activity_updated_at"] = now
    if pending_for_sec > 0:
        current_subtitle["pending_until"] = max(float(current_subtitle.get("pending_until") or 0), now + pending_for_sec)


def update_current_translation(
    *,
    original: str,
    translation: str,
    backend: str,
    model: str,
    latency_ms: int,
) -> None:
    now = time.time()
    current_subtitle.update(
        {
            "original": normalize_text(original),
            "translation": normalize_text(translation),
            "backend": backend,
            "model": model,
            "latency_ms": latency_ms,
            "updated_at": now,
            "activity_updated_at": now,
            "pending_until": 0.0,
        }
    )


@app.get("/current")
async def current() -> dict:
    age_ms = int((time.time() - float(current_subtitle.get("updated_at") or 0)) * 1000)
    activity_age_ms = int((time.time() - float(current_subtitle.get("activity_updated_at") or 0)) * 1000)
    pending = translate_lock.locked() or time.time() < float(current_subtitle.get("pending_until") or 0)
    return {
        **current_subtitle,
        "age_ms": age_ms,
        "activity_age_ms": activity_age_ms,
        "pending": pending,
    }


@app.post("/subtitle")
async def update_subtitle(request: SubtitleUpdateRequest) -> dict:
    update_current_translation(
        original=request.original,
        translation=request.translation,
        backend=request.backend,
        model=request.model,
        latency_ms=request.latency_ms,
    )
    translation_logger.write(
        {
            "event": "subtitle",
            "text": normalize_text(request.original),
            "raw_en": normalize_text(request.original),
            "translation": normalize_text(request.translation),
            "backend": request.backend,
            "model": request.model,
            "latency_ms": request.latency_ms,
            "client_first_seen_ms": int(request.client_first_seen_ms or 0),
            "client_committed_ms": int(request.client_committed_ms or 0),
            "client_enqueued_ms": int(request.client_enqueued_ms or 0),
            "client_overlay_shown_ms": int(request.client_overlay_shown_ms or 0),
            "client_seen_to_overlay_ms": elapsed_ms(request.client_overlay_shown_ms, request.client_first_seen_ms),
            "client_commit_to_overlay_ms": elapsed_ms(request.client_overlay_shown_ms, request.client_committed_ms),
            "status": "ok",
        }
    )
    return {"ok": True}


@app.post("/activity")
async def update_activity(request: ActivityRequest) -> dict:
    mark_translation_activity(request.original, pending_for_sec=max(1.0, min(request.pending_for_sec, 20.0)))
    return {"ok": True}


@app.post("/context/reset")
async def reset_context() -> dict:
    reset = getattr(translator, "reset_context", None)
    if callable(reset):
        reset()
    return {"ok": True}


@app.get("/overlay", response_class=HTMLResponse)
async def overlay() -> str:
    return OVERLAY_HTML


@app.get("/health")
async def health() -> dict:
    backend_health = await translator.health()
    configured_model = getattr(translator, "model_name", "")
    active_model = last_active_model or current_subtitle.get("model") or configured_model
    return {
        "ok": True,
        "backend": config.translation.backend,
        "model": active_model,
        "active_model": active_model,
        "configured_model": configured_model,
        "last_requested_model": last_requested_model,
        "last_profile": last_profile,
        "backend_health": backend_health,
        "last_error": last_error,
        "warmup": warmup_status,
    }


@app.post("/translate", response_model=TranslateResponse)
async def translate(request: TranslateRequest) -> TranslateResponse:
    global last_error, last_requested_model, last_active_model, last_profile

    started = time.perf_counter()
    backend_received_ms = now_ms()
    timing = client_timing_payload(request, backend_received_ms)
    text = normalize_text(request.text)
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > config.runtime.max_input_chars:
        text = text[: config.runtime.max_input_chars].strip()
    mark_translation_activity(text, pending_for_sec=config.runtime.request_timeout_sec + 3)

    model = request.model.strip() if request.model else None
    profile = request.profile.strip() if request.profile else None
    prompt_style = request.prompt_style.strip() if request.prompt_style else None
    resolved_model = model or getattr(translator, "model_name", "")
    last_requested_model = resolved_model
    last_profile = profile or ""
    cache_key = f"{request.source_lang}:{request.target_lang}:{model or getattr(translator, 'model_name', '')}:{profile or ''}:{prompt_style or ''}:{text}"
    cached = cache.get(cache_key)
    if cached is not None:
        latency_ms = int((time.perf_counter() - started) * 1000)
        update_current_translation(
            original=text,
            translation=cached,
            backend=config.translation.backend,
            model=resolved_model,
            latency_ms=latency_ms,
        )
        last_active_model = resolved_model
        translation_logger.write(
            {
                "event": "translate",
                "source_lang": request.source_lang,
                "target_lang": request.target_lang,
                "text": text,
                "raw_en": text,
                "translation": cached,
                "backend": config.translation.backend,
                "model": model or getattr(translator, "model_name", ""),
                "profile": profile,
                "cached": True,
                "latency_ms": latency_ms,
                **timing,
                "status": "ok",
            }
        )
        return TranslateResponse(
            translation=cached,
            backend=config.translation.backend,
            model=resolved_model,
            cached=True,
            latency_ms=latency_ms,
        )

    try:
        try:
            await asyncio.wait_for(translate_lock.acquire(), timeout=8.0)
        except TimeoutError as exc:
            last_error = "translator busy"
            translation_logger.write(
                {
                    "event": "translate",
                    "source_lang": request.source_lang,
                    "target_lang": request.target_lang,
                    "text": text,
                    "raw_en": text,
                    "translation": "",
                    "backend": config.translation.backend,
                    "model": model or getattr(translator, "model_name", ""),
                    "profile": profile,
                    "cached": False,
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                    **timing,
                    "status": "busy",
                    "error": last_error,
                }
            )
            raise HTTPException(status_code=429, detail=last_error) from exc

        cached_after_wait = cache.get(cache_key)
        if cached_after_wait is not None:
            translate_lock.release()
            latency_ms = int((time.perf_counter() - started) * 1000)
            update_current_translation(
                original=text,
                translation=cached_after_wait,
                backend=config.translation.backend,
                model=resolved_model,
                latency_ms=latency_ms,
            )
            last_active_model = resolved_model
            translation_logger.write(
                {
                    "event": "translate",
                    "source_lang": request.source_lang,
                    "target_lang": request.target_lang,
                    "text": text,
                    "raw_en": text,
                    "translation": cached_after_wait,
                    "backend": config.translation.backend,
                    "model": model or getattr(translator, "model_name", ""),
                    "profile": profile,
                    "cached": True,
                    "latency_ms": latency_ms,
                    **timing,
                    "status": "ok",
                }
            )
            return TranslateResponse(
                translation=cached_after_wait,
                backend=config.translation.backend,
                model=resolved_model,
                cached=True,
                latency_ms=latency_ms,
            )

        try:
            result = await asyncio.wait_for(
                translator.translate(text, request.source_lang, request.target_lang, model=model, profile=profile, prompt_style=prompt_style),
                timeout=config.runtime.request_timeout_sec,
            )
        finally:
            translate_lock.release()
    except HTTPException:
        raise
    except TimeoutError as exc:
        last_error = f"translation timeout after {config.runtime.request_timeout_sec:g}s"
        translation_logger.write(
            {
                "event": "translate",
                "source_lang": request.source_lang,
                "target_lang": request.target_lang,
                "text": text,
                "raw_en": text,
                "translation": "",
                "backend": config.translation.backend,
                "model": model or getattr(translator, "model_name", ""),
                "profile": profile,
                "cached": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                **timing,
                "status": "timeout",
                "error": last_error,
            }
        )
        logger.warning("translation timeout latency_ms=%s chars=%s", int((time.perf_counter() - started) * 1000), len(text))
        raise HTTPException(status_code=504, detail=last_error) from exc
    except Exception as exc:
        last_error = str(exc)
        translation_logger.write(
            {
                "event": "translate",
                "source_lang": request.source_lang,
                "target_lang": request.target_lang,
                "text": text,
                "raw_en": text,
                "translation": "",
                "backend": config.translation.backend,
                "model": model or getattr(translator, "model_name", ""),
                "profile": profile,
                "cached": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                **timing,
                "status": "error",
                "error": last_error,
            }
        )
        logger.exception("translation failed")
        raise HTTPException(status_code=503, detail=last_error) from exc

    cache.set(cache_key, result.translation)
    latency_ms = int((time.perf_counter() - started) * 1000)
    update_current_translation(
        original=text,
        translation=result.translation,
        backend=result.backend,
        model=result.model,
        latency_ms=latency_ms,
    )
    last_active_model = result.model
    logger.info("translated backend=%s cached=false latency_ms=%s chars=%s", result.backend, latency_ms, len(text))
    translation_logger.write(
        {
            "event": "translate",
            "source_lang": request.source_lang,
            "target_lang": request.target_lang,
            "text": text,
            "raw_en": text,
            "translation": result.translation,
            "backend": result.backend,
            "model": result.model,
            "profile": profile,
            "cached": False,
            "latency_ms": latency_ms,
            **timing,
            "status": "ok",
        }
    )
    last_error = None
    return TranslateResponse(
        translation=result.translation,
        backend=result.backend,
        model=result.model,
        cached=False,
        latency_ms=latency_ms,
    )


OVERLAY_HTML = """
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Translation Overlay</title>
  <style>
    :root {
      --font-size: 42px;
      --row-height: calc(var(--font-size) * 1.55);
      --bg: rgba(0, 0, 0, 0.72);
      --bottom: 7vh;
      --max-width: 88vw;
    }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
      font-family: Arial, Helvetica, sans-serif;
    }
    #overlay {
      position: fixed;
      left: 50%;
      bottom: var(--bottom);
      width: min(1180px, var(--max-width));
      height: calc(var(--row-height) * 2 + 20px);
      transform: translateX(-50%);
      box-sizing: border-box;
      padding: 10px 18px;
      border-radius: 8px;
      background: var(--bg);
      color: #fff;
      font-size: var(--font-size);
      line-height: 1.22;
      font-weight: 700;
      text-align: center;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.85);
      pointer-events: none;
      opacity: 0;
      overflow: hidden;
      transition: opacity 160ms ease;
    }
    #overlay.visible {
      opacity: 1;
    }
    #viewport {
      width: 100%;
      height: calc(var(--row-height) * 2);
      overflow: hidden;
    }
    #track {
      display: flex;
      flex-direction: column;
      transform: translateY(0);
    }
    #track.sliding {
      transition: transform 220ms ease;
    }
    .row {
      flex: 0 0 var(--row-height);
      height: var(--row-height);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
      text-overflow: clip;
      font-size: var(--font-size);
    }
    #meta {
      position: fixed;
      left: 12px;
      bottom: 12px;
      display: none;
      padding: 6px 8px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.7);
      font: 13px/1.2 Consolas, monospace;
      color: #c7f9cc;
      white-space: pre;
    }
    body.debug #meta {
      display: block;
    }
  </style>
</head>
<body>
  <div id="overlay">
    <div id="viewport">
      <div id="track"></div>
    </div>
  </div>
  <div id="meta"></div>
  <script>
    const params = new URLSearchParams(location.search);
    const hideAfterMs = Number(params.get("hide_after_ms") || 6000);
    const pollMs = Number(params.get("poll_ms") || 250);
    const minDisplayMs = Number(params.get("min_display_ms") || 1500);
    const slideMs = Number(params.get("slide_ms") || 220);

    if (params.get("debug") === "1") document.body.classList.add("debug");
    if (params.get("font_size")) document.documentElement.style.setProperty("--font-size", `${Number(params.get("font_size"))}px`);
    if (params.get("bottom")) document.documentElement.style.setProperty("--bottom", `${Number(params.get("bottom"))}vh`);
    if (params.get("max_width")) document.documentElement.style.setProperty("--max-width", `${Number(params.get("max_width"))}vw`);
    if (params.get("opacity")) document.documentElement.style.setProperty("--bg", `rgba(0,0,0,${Number(params.get("opacity"))})`);

    const overlay = document.getElementById("overlay");
    const track = document.getElementById("track");
    const meta = document.getElementById("meta");
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");

    let lastUpdatedAt = 0;
    let lastRenderedText = "";
    let lines = [];
    let pendingRows = [];
    let animating = false;
    let rowTimer = 0;
    let lastRowStartedAt = 0;
    let lastMessageKey = "";
    let lastMessageAt = 0;

    function cleanDisplayText(text) {
      return String(text || "")
        .replace(/(\\.{3}|…|вЂ¦|РІР‚В¦)+/g, "")
        .replace(/\\s{2,}/g, " ")
        .trim();
    }

    function getFontSize() {
      return Math.max(18, Number(params.get("font_size") || 42));
    }

    function getTextWidthLimit() {
      return Math.max(260, overlay.clientWidth - 56);
    }

    function measureText(text) {
      measureContext.font = `700 ${getFontSize()}px Arial, Helvetica, sans-serif`;
      return measureContext.measureText(String(text || "")).width;
    }

    function fitWords(words, maxWidth) {
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (measureText(next) > maxWidth && line) break;
        line = next;
      }
      return line;
    }

    function splitDisplayLines(text) {
      const value = cleanDisplayText(text);
      if (!value) return [];

      const maxWidth = getTextWidthLimit();
      if (measureText(value) <= maxWidth) return [value];

      const words = value.split(/\\s+/);
      const lines = [];
      let current = "";
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (measureText(next) > maxWidth && current) {
          lines.push(current);
          current = word;
          continue;
        }
        current = next;
      }
      if (current) lines.push(current);
      return lines;
    }

    function areNearDuplicates(a, b) {
      const left = String(a || "").toLowerCase().replace(/[^\\p{L}\\p{N}' ]+/gu, " ").split(/\\s+/).filter(Boolean);
      const right = String(b || "").toLowerCase().replace(/[^\\p{L}\\p{N}' ]+/gu, " ").split(/\\s+/).filter(Boolean);
      if (!left.length || !right.length) return false;
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      let best = 0;
      for (let i = 0; i <= longer.length - shorter.length; i += 1) {
        let same = 0;
        for (let j = 0; j < shorter.length; j += 1) {
          if (longer[i + j] === shorter[j]) same += 1;
        }
        best = Math.max(best, same / shorter.length);
      }
      return best > 0.76;
    }

    function createRow(text) {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = text;
      return row;
    }

    function renderStatic() {
      const visible = lines.slice(-2);
      track.innerHTML = "";
      if (visible.length === 1) track.appendChild(createRow(""));
      for (const line of visible) track.appendChild(createRow(line));
      track.classList.remove("sliding");
      track.style.transform = "translateY(0)";
    }

    function renderAnimated() {
      if (animating) {
        renderStatic();
        lines = lines.slice(-2);
        return;
      }

      const visible = lines.slice(-3);
      if (visible.length < 3) {
        renderStatic();
        window.setTimeout(processRowQueue, 0);
        return;
      }

      animating = true;
      track.innerHTML = "";
      for (const line of visible) track.appendChild(createRow(line));
      track.classList.remove("sliding");
      track.style.transform = "translateY(0)";

      window.requestAnimationFrame(() => {
        track.classList.add("sliding");
        track.style.transform = "translateY(calc(var(--row-height) * -1))";
      });

      window.setTimeout(() => {
        lines = lines.slice(-2);
        animating = false;
        renderStatic();
        processRowQueue();
      }, slideMs + 20);
    }

    function pushLine(text) {
      if (lines[lines.length - 1] === text) {
        processRowQueue();
        return;
      }
      if (lines.length > 0 && areNearDuplicates(lines[lines.length - 1], text)) {
        lines[lines.length - 1] = text.length > lines[lines.length - 1].length ? text : lines[lines.length - 1];
        renderStatic();
        processRowQueue();
        return;
      }
      lines.push(text);
      lastRowStartedAt = Date.now();
      renderAnimated();
    }

    function getRowDisplayMs() {
      const current = lines[lines.length - 1] || "";
      const queued = pendingRows[0] || "";
      const text = current.length >= queued.length ? current : queued;
      const byLength = Math.min(2600, minDisplayMs + text.length * 18);
      return pendingRows.length > 3 ? Math.max(1750, byLength) : byLength;
    }

    function processRowQueue() {
      if (animating) return;
      window.clearTimeout(rowTimer);
      const elapsed = Date.now() - lastRowStartedAt;
      const displayMs = getRowDisplayMs();
      if (lastRowStartedAt && elapsed < displayMs) {
        rowTimer = window.setTimeout(processRowQueue, displayMs - elapsed);
        return;
      }
      const next = pendingRows.shift();
      if (!next) return;
      pushLine(next);
    }

    function pushMessage(text) {
      const messageLines = splitDisplayLines(text);
      if (!messageLines.length) return;

      const messageKey = messageLines.join("\\n");
      const now = Date.now();
      if (messageKey === lastMessageKey && now - lastMessageAt < 45000) return;
      lastMessageKey = messageKey;
      lastMessageAt = now;
      const lastKey = lines.slice(-2).join("\\n");
      if (lastKey === messageKey) return;

      if (lastKey && areNearDuplicates(lastKey, messageKey)) {
        lines = messageKey.length > lastKey.length ? messageLines : lines.slice(-2);
        renderStatic();
        return;
      }

      const pendingKey = pendingRows.join("\\n");
      if (pendingKey && areNearDuplicates(pendingKey, messageKey)) {
        pendingRows = messageLines;
        processRowQueue();
        return;
      }

      if (pendingRows.length > 0 && lines.length > 0) {
        const combinedKey = [...lines.slice(-1), ...pendingRows].join("\\n");
        if (areNearDuplicates(combinedKey, messageKey)) {
          pendingRows = messageLines;
          processRowQueue();
          return;
        }
      }

      pendingRows.push(...messageLines);
      if (pendingRows.length > 4) pendingRows = pendingRows.slice(-4);
      processRowQueue();
    }

    async function tick() {
      try {
        const response = await fetch("/current", { cache: "no-store" });
        const data = await response.json();
        const translation = cleanDisplayText(data.translation || "");
        const age = Number(data.age_ms || 999999);
        const activityAge = Number(data.activity_age_ms || 999999);
        const isActive = Boolean(data.pending) || activityAge < hideAfterMs;

        if (translation && data.updated_at !== lastUpdatedAt) {
          if (translation !== lastRenderedText) {
            pushMessage(translation);
            lastRenderedText = translation;
          }
          lastUpdatedAt = data.updated_at;
        }

        meta.textContent = `${data.model || ""} ${data.latency_ms || 0} ms\\nage=${age} ms active=${activityAge} ms pending=${Boolean(data.pending)} rows=${lines.length} queue=${pendingRows.length}`;
        overlay.classList.toggle("visible", Boolean(translation) && (age < hideAfterMs || isActive));
      } catch (error) {
        overlay.classList.remove("visible");
      } finally {
        setTimeout(tick, pollMs);
      }
    }

    tick();
  </script>
</body>
</html>
"""
