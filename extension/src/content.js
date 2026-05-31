(async function () {
  "use strict";

  if (window.__yaTranslatorContentStarted) {
    return;
  }
  window.__yaTranslatorContentStarted = true;

  function isLocalBackendPage() {
    const host = window.location.hostname;
    const port = window.location.port;
    const path = window.location.pathname;
    return (
      (host === "127.0.0.1" || host === "localhost") &&
      port === "8765" &&
      (path === "/overlay" || path === "/current" || path === "/health")
    );
  }

  if (isLocalBackendPage()) {
    return;
  }

  const State = Object.freeze({
    INIT: "INIT",
    READY: "READY",
    LISTENING: "LISTENING",
    IDLE: "IDLE",
    ERROR: "ERROR"
  });

  // Pure text predicates live in segment-utils.js (loaded before this script)
  // so they can be unit-tested in isolation. Bound here so the rest of the
  // file calls them by their original names unchanged.
  const _segUtils = window.YaSegmentUtils || {};
  const {
    collapseRepeatedPhrases,
    isFastPunctuation,
    looksIncomplete,
    hasHardIncompleteTail,
    isSentenceBoundary,
    splitFirstCompleteSentence,
    wordsOf,
    normalizedWords,
    overlapRatio,
    shouldDropChunk,
    isLikelyContinuation,
    isUnsafeFinalFragment,
    isHoldableFragment
  } = _segUtils;

  let settings = await window.YaTranslatorSettings.load();
  if (Number(settings.qualityMaxWaitMs) < 5600) {
    settings.qualityMaxWaitMs = 5600;
  }
  const debugPanel = new window.YaTranslatorDebugPanel();
  const overlay = new window.YaTranslatorOverlay(settings);
  // Reader selection: settings.subtitleSource controls where we read EN
  // subtitles from. "yandex" forces the Yandex Browser ASR widget,
  // "youtube" forces YouTube native CC, "auto" picks YouTube when we're
  // on a YouTube host and YouTube CC is visible, otherwise Yandex.
  function chooseReader() {
    const mode = (settings && settings.subtitleSource) || "auto";
    const host = (window.location.hostname || "").toLowerCase();
    const isYouTubeHost = host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com") || host === "youtu.be";
    if (mode === "youtube") {
      return window.YouTubeSubtitleReader ? new window.YouTubeSubtitleReader() : new window.YaSubtitleReader();
    }
    if (mode === "yandex") {
      return new window.YaSubtitleReader();
    }
    if (isYouTubeHost && window.YouTubeSubtitleReader) {
      return new window.YouTubeSubtitleReader();
    }
    return new window.YaSubtitleReader();
  }
  const reader = chooseReader();
  const translator = new window.YaTranslatorClient(settings);
  const segmenter = window.YaSubtitleSegmenter ? new window.YaSubtitleSegmenter(settings) : null;
  // YouTube CC is a rolling-scroll window and needs its own stitcher (commits
  // whole sentences, no seam). Yandex keeps the shared segmenter untouched.
  const usingYouTubeSource = reader instanceof (window.YouTubeSubtitleReader || function () {});
  const youtubeStitcher = usingYouTubeSource && window.YouTubeStitcher
    ? new window.YouTubeStitcher(settings)
    : null;
  // The active source for direct live reads (handleText): stitcher on YouTube,
  // otherwise the shared segmenter.
  const liveSource = youtubeStitcher || segmenter;

  let state = State.INIT;
  let lastRawText = "";
  let lastCapturedRead = "";
  let lastSentText = "";
  let lastTranslation = "";
  let lastTranslationActivityAt = 0;
  let stableTimer = 0;
  let idleSince = 0;
  let hookSeen = false;
  let tickScheduled = false;
  let cdpBusy = false;
  let cdpLastText = "";
  let cdpLastLines = [];
  let cdpLastSeenAt = 0;
  let cdpLastWindow = "";
  let cdpSegment = "";
  let cdpSegmentTimer = 0;
  let cdpSegmentStartedAt = 0;
  let cdpSegmentUpdatedAt = 0;
  let pendingFragment = "";
  let pendingFragmentAt = 0;
  let lastAnySubtitleAt = 0;
  let lastActivityPublishAt = 0;
  const translationQueue = [];
  let translationInProgress = false;
  const FRAGMENT_JOIN_MAX_MS = 8000;
  const FRAGMENT_STALE_MS = 10000;
  const HARD_FRAGMENT_STALE_MS = 6500;
  const SOFT_FRAGMENT_STALE_MS = 8200;
  const RECENT_TEXT_TTL_MS = 45000;
  const MAX_TRANSLATION_QUEUE = 2;
  // Max age of a prior sighting still counted as the same utterance for the
  // seen->overlay latency metric. Beyond this it is a recurring phrase, not a
  // real wait, so we ignore it to keep the metric honest.
  const FIRST_SEEN_MAX_LOOKBACK_MS = 12000;
  function getContextResetGapMs() {
    const value = Number(settings && settings.contextResetGapMs);
    if (!Number.isFinite(value) || value < 4000) {
      return 15000;
    }
    return Math.min(120000, value);
  }
  const SOURCE_SEEN_TTL_MS = 90000;
  const recentTextKeys = new Map();
  const sourceSeenKeys = new Map();

  function injectMainWorldFallback() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/injected.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head || document).appendChild(script);
  }

  function setState(next, patch = {}) {
    state = next;
    debugPanel.update({ state, ...patch });
  }

  function shouldWaitForFullerSentence(text, ageMs) {
    const value = window.YaSubtitleNormalizeText(text);
    const words = wordsOf(value);
    if (!value || isSentenceBoundary(value)) {
      return false;
    }
    if (hasHardIncompleteTail(value)) {
      return ageMs < HARD_FRAGMENT_STALE_MS;
    }
    if (words.length < 8) {
      return ageMs < SOFT_FRAGMENT_STALE_MS;
    }
    if (words.length < 13 && !/[,:;)]$/.test(value.trim())) {
      return ageMs < Math.min(SOFT_FRAGMENT_STALE_MS, settings.qualityMaxWaitMs + 2600);
    }
    return false;
  }

  function clearCdpSegment() {
    cdpSegment = "";
    cdpLastWindow = "";
    cdpSegmentStartedAt = 0;
    cdpSegmentUpdatedAt = 0;
  }

  function publishInputActivity(text) {
    const now = Date.now();
    lastTranslationActivityAt = now;
    rememberSourceSeen(text, now);
    if (!text || now - lastActivityPublishAt < 1000) {
      return;
    }
    lastActivityPublishAt = now;
    translator.publishActivity({
      original: text,
      pending_for_sec: Math.ceil((settings.hideAfterSilenceMs + 3000) / 1000)
    });
  }

  function textKey(text) {
    return normalizedWords(text).join(" ");
  }

  function pruneRecentTextKeys(now = Date.now()) {
    for (const [key, seenAt] of recentTextKeys.entries()) {
      if (now - seenAt > RECENT_TEXT_TTL_MS) {
        recentTextKeys.delete(key);
      }
    }
  }

  function pruneSourceSeenKeys(now = Date.now()) {
    for (const [key, seenAt] of sourceSeenKeys.entries()) {
      if (now - seenAt > SOURCE_SEEN_TTL_MS) {
        sourceSeenKeys.delete(key);
      }
    }
  }

  function rememberSourceSeen(text, seenAt = Date.now()) {
    const key = textKey(text);
    if (!key) {
      return;
    }
    pruneSourceSeenKeys(seenAt);
    if (!sourceSeenKeys.has(key)) {
      sourceSeenKeys.set(key, seenAt);
    }
  }

  function firstSeenFor(text) {
    const key = textKey(text);
    if (!key) {
      return 0;
    }
    const now = Date.now();
    pruneSourceSeenKeys(now);
    // Only treat a prior sighting as "first seen" if it is recent. A live
    // sentence finishes building within a few seconds, so a match older than
    // this is a recurring phrase reappearing later in the talk (e.g. "you use
    // every day"), not the same utterance. Without this cap, the fuzzy match
    // below picks up that stale occurrence and inflates the seen->overlay
    // latency metric to tens of seconds (a measurement artifact only - this
    // value is used solely for telemetry, never for behavior).
    const exact = sourceSeenKeys.get(key);
    if (exact !== undefined && now - exact <= FIRST_SEEN_MAX_LOOKBACK_MS) {
      return exact;
    }
    let bestSeenAt = 0;
    let bestWords = 0;
    for (const [seenKey, seenAt] of sourceSeenKeys.entries()) {
      if (now - seenAt > FIRST_SEEN_MAX_LOOKBACK_MS) {
        continue;
      }
      if (seenKey.includes(key) || key.includes(seenKey)) {
        const words = Math.min(key.split(" ").length, seenKey.split(" ").length);
        if (words > bestWords) {
          bestWords = words;
          bestSeenAt = seenAt;
        }
      }
    }
    return bestSeenAt;
  }

  function wasRecentlySent(text) {
    const key = textKey(text);
    if (!key) {
      return false;
    }
    const now = Date.now();
    pruneRecentTextKeys(now);
    return recentTextKeys.has(key);
  }

  function markRecentlySent(text) {
    const key = textKey(text);
    if (!key) {
      return;
    }
    recentTextKeys.set(key, Date.now());
  }

  function unmarkRecentlySent(text) {
    const key = textKey(text);
    if (key) {
      recentTextKeys.delete(key);
    }
  }

  function collapseRepeatedSentences(text) {
    const parts = String(text || "")
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      return text;
    }
    const result = [];
    for (const part of parts) {
      if (result.length && textKey(result[result.length - 1]) === textKey(part)) {
        continue;
      }
      result.push(part);
    }
    return result.join(" ");
  }

  function removeRepeatedWords(text) {
    const rawWords = wordsOf(window.YaSubtitleNormalizeText(text));
    if (rawWords.length < 2) {
      return window.YaSubtitleNormalizeText(text);
    }
    const output = [];
    for (const word of rawWords) {
      const clean = word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
      const prev = output.length ? output[output.length - 1].toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "") : "";
      if (clean && clean === prev && clean.length > 2) {
        continue;
      }
      output.push(word);
    }
    return output.join(" ");
  }

  function removeRepeatedTail(text) {
    let rawWords = wordsOf(removeRepeatedWords(text));
    for (let index = 0; index < rawWords.length; index += 1) {
      for (let size = Math.min(8, Math.floor((rawWords.length - index) / 2)); size >= 2; size -= 1) {
        const left = rawWords.slice(index, index + size).join(" ").toLowerCase();
        const right = rawWords.slice(index + size, index + size * 2).join(" ").toLowerCase();
        if (left === right) {
          rawWords.splice(index + size, size);
          index = Math.max(-1, index - 1);
          break;
        }
      }
    }
    for (let size = Math.min(12, Math.floor(rawWords.length / 2)); size >= 3; size -= 1) {
      const tail = rawWords.slice(-size).join(" ").toLowerCase();
      for (let start = 0; start <= rawWords.length - size * 2; start += 1) {
        const chunk = rawWords.slice(start, start + size).join(" ").toLowerCase();
        if (chunk === tail) {
          rawWords = rawWords.slice(0, rawWords.length - size);
          return rawWords.join(" ");
        }
      }
    }
    return rawWords.join(" ");
  }

  function stripOverlapPrefix(previousText, nextText) {
    const previous = wordsOf(previousText);
    const next = wordsOf(nextText);
    if (previous.length < 4 || next.length < 4) {
      return nextText;
    }
    const max = Math.min(24, previous.length, next.length);
    for (let size = max; size >= 4; size -= 1) {
      const prevTail = previous.slice(previous.length - size).join(" ").toLowerCase();
      const nextHead = next.slice(0, size).join(" ").toLowerCase();
      if (prevTail === nextHead) {
        const stripped = next.slice(size).join(" ");
        return stripped && wordsOf(stripped).length >= 4 ? stripped : nextText;
      }
    }
    return nextText;
  }

  function resetLiveContext(reason) {
    lastRawText = "";
    lastSentText = "";
    pendingFragment = "";
    pendingFragmentAt = 0;
    cdpLastText = "";
    cdpLastLines = [];
    cdpLastWindow = "";
    cdpSegment = "";
    cdpSegmentStartedAt = 0;
    cdpSegmentUpdatedAt = 0;
    translationQueue.length = 0;
    recentTextKeys.clear();
    sourceSeenKeys.clear();
    clearCdpSegment();
    if (segmenter) {
      segmenter.reset();
    }
    if (youtubeStitcher) {
      youtubeStitcher.reset();
    }
    translator.resetContext();
    debugPanel.update({ queue: 0, skipped: reason || "context reset" });
  }

  function cleanSourceForTranslation(text) {
    let value = collapseRepeatedSentences(text);
    value = removeRepeatedTail(value);
    // Collapse non-adjacent phrase repeats the rolling-window stitch can
    // leave behind on YouTube CC (e.g. "A B C ... A B C"). removeRepeatedTail
    // only handles adjacent repeats; this catches the separated ones.
    value = collapseRepeatedPhrases(value);
    value = stripOverlapPrefix(lastSentText, value);
    return window.YaSubtitleNormalizeText(value);
  }

  function appendSlidingWindow(previousWindow, segment, currentWindow) {
    const current = window.YaSubtitleNormalizeText(currentWindow);
    if (!current) {
      return { segment, changed: false };
    }
    if (!previousWindow) {
      return { segment: current, changed: true };
    }
    if (previousWindow === current || segment.endsWith(current)) {
      return { segment, changed: false };
    }

    const previousWords = wordsOf(previousWindow);
    const currentWords = wordsOf(current);
    const maxOverlap = Math.min(previousWords.length, currentWords.length);
    let overlap = 0;
    for (let size = maxOverlap; size > 0; size -= 1) {
      const prevTail = previousWords.slice(previousWords.length - size).join(" ").toLowerCase();
      const currHead = currentWords.slice(0, size).join(" ").toLowerCase();
      if (prevTail === currHead) {
        overlap = size;
        break;
      }
    }

    if (overlap > 0) {
      const suffix = currentWords.slice(overlap).join(" ");
      return {
        segment: suffix ? `${segment} ${suffix}` : segment,
        changed: Boolean(suffix)
      };
    }

    if (current.length > previousWindow.length && current.includes(previousWindow)) {
      return { segment: current, changed: current !== segment };
    }

    return { segment: current, changed: current !== segment, reset: true };
  }

  function linesLookLikeTokenParts(lines, fullText) {
    if (!Array.isArray(lines) || lines.length < 3) {
      return false;
    }
    const normalizedLines = lines.map((line) => window.YaSubtitleNormalizeText(line)).filter(Boolean);
    if (normalizedLines.length < 3) {
      return false;
    }
    const shortLines = normalizedLines.filter((line) => wordsOf(line).length <= 2).length;
    const joined = window.YaSubtitleNormalizeText(normalizedLines.join(" "));
    const normalizedFull = window.YaSubtitleNormalizeText(fullText);
    return shortLines / normalizedLines.length >= 0.75 && (!normalizedFull || joined === normalizedFull);
  }

  function handleCdpText(text, lines = []) {
    let normalizedLines = Array.isArray(lines)
      ? lines.map((line) => window.YaSubtitleNormalizeText(line)).filter(Boolean)
      : [];
    const normalized = window.YaSubtitleNormalizeText(text || normalizedLines.join("\n"));
    if (!normalized) {
      return;
    }
    const useLegacyCdpSegmentation = linesLookLikeTokenParts(normalizedLines, normalized);
    if (useLegacyCdpSegmentation) {
      normalizedLines = [];
    }
    const now = Date.now();
    if (lastAnySubtitleAt && now - lastAnySubtitleAt > getContextResetGapMs()) {
      resetLiveContext("context gap");
    }
    if (lastAnySubtitleAt && now - lastAnySubtitleAt > 5000) {
      clearCdpSegment();
      window.clearTimeout(cdpSegmentTimer);
      if (segmenter) {
        segmenter.reset();
      }
    }
    lastAnySubtitleAt = now;
    publishInputActivity(normalized);

    if (segmenter && !useLegacyCdpSegmentation) {
      const commits = normalizedLines.length > 1 ? segmenter.pushLines(normalizedLines, now) : segmenter.push(normalized, now);
      if (commits.length) {
        const lastCommit = commits[commits.length - 1];
        setState(State.LISTENING, { en: lastCommit, segmenter: "commit" });
      } else {
        setState(State.LISTENING, { en: normalized, segmenter: "read" });
      }
      for (const commit of commits) {
        enqueueTranslation(commit);
      }
      return;
    }

    const merged = appendSlidingWindow(cdpLastWindow, cdpSegment, normalized);
    cdpLastWindow = normalized;
    if (!cdpSegmentStartedAt || merged.reset) {
      cdpSegmentStartedAt = Date.now();
    }
    if (merged.changed) {
      cdpSegmentUpdatedAt = Date.now();
    }
    cdpSegment = merged.segment.slice(-settings.maxInputChars);

    if (merged.changed) {
      setState(State.LISTENING, { en: cdpSegment });
    }

    window.clearTimeout(cdpSegmentTimer);
    scheduleCdpSegmentFlush();
  }

  function scheduleCdpSegmentFlush() {
    const now = Date.now();
    const age = now - (cdpSegmentStartedAt || now);
    const stableFor = now - (cdpSegmentUpdatedAt || now);
    const words = wordsOf(cdpSegment);
    const complete = isSentenceBoundary(cdpSegment) && !looksIncomplete(cdpSegment);

    let delay = settings.qualityStableMs;
    if (complete) {
      delay = settings.fastPunctuationDebounceMs;
    } else if (words.length >= 26 && !looksIncomplete(cdpSegment) && !shouldDropChunk(cdpSegment)) {
      delay = 250;
    } else if (age >= settings.qualityMaxWaitMs && !shouldWaitForFullerSentence(cdpSegment, age) && !looksIncomplete(cdpSegment) && !shouldDropChunk(cdpSegment)) {
      delay = 100;
    } else if (hasHardIncompleteTail(cdpSegment)) {
      delay = Math.max(settings.qualityStableMs, 2200);
    } else if (looksIncomplete(cdpSegment)) {
      delay = Math.max(settings.qualityStableMs, 2600);
    }

    if (stableFor >= settings.qualityStableMs && !looksIncomplete(cdpSegment) && !shouldDropChunk(cdpSegment)) {
      delay = Math.min(delay, 100);
    }

    cdpSegmentTimer = window.setTimeout(flushCdpSegment, delay);
  }

  function flushCdpSegment() {
    const text = window.YaSubtitleNormalizeText(cdpSegment);
    if (!text || text === lastSentText) {
      return;
    }
    const now = Date.now();
    const age = now - cdpSegmentStartedAt;
    const forceByAge = age >= settings.qualityMaxWaitMs;
    if (shouldWaitForFullerSentence(text, age)) {
      scheduleCdpSegmentFlush();
      return;
    }
    if (looksIncomplete(text) && !forceByAge) {
      if (text && Date.now() - cdpSegmentStartedAt < settings.qualityMaxWaitMs + 2500) {
        scheduleCdpSegmentFlush();
      }
      return;
    }
    const split = splitFirstCompleteSentence(text);
    let toTranslate = split.head || text;
    if (pendingFragment) {
      const pendingAge = now - pendingFragmentAt;
      if (pendingAge > FRAGMENT_STALE_MS) {
        pendingFragment = "";
        pendingFragmentAt = 0;
      } else if (pendingAge <= FRAGMENT_JOIN_MAX_MS && isLikelyContinuation(toTranslate)) {
        toTranslate = window.YaSubtitleNormalizeText(`${pendingFragment} ${toTranslate}`);
        pendingFragment = "";
        pendingFragmentAt = 0;
      } else if (isSentenceBoundary(toTranslate) && !looksIncomplete(toTranslate)) {
        pendingFragment = "";
        pendingFragmentAt = 0;
      }
    }
    if (isHoldableFragment(toTranslate) && !split.tail) {
      if (!pendingFragment || overlapRatio(pendingFragment, toTranslate) < 0.75 || toTranslate.length > pendingFragment.length) {
        pendingFragment = toTranslate;
        pendingFragmentAt = now;
        debugPanel.update({ pending: pendingFragment });
      }
      clearCdpSegment();
      return;
    }
    if (shouldDropChunk(toTranslate)) {
      cdpSegment = split.head ? split.tail : text;
      cdpLastWindow = cdpSegment;
      if (cdpSegment && Date.now() - cdpSegmentStartedAt < settings.qualityMaxWaitMs + 4500) {
        scheduleCdpSegmentFlush();
      } else {
        clearCdpSegment();
      }
      return;
    }
    enqueueTranslation(toTranslate);
    cdpSegment = split.head ? split.tail : "";
    cdpLastWindow = cdpSegment;
    cdpSegmentStartedAt = cdpSegment ? Date.now() : 0;
    cdpSegmentUpdatedAt = cdpSegmentStartedAt;
    if (cdpSegment) {
      scheduleCdpSegmentFlush();
    }
  }

  let lastSeenMemoryResetAt = 0;
  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    if (Number(settings.qualityMaxWaitMs) < 5600) {
      settings.qualityMaxWaitMs = 5600;
    }
    debugPanel.setEnabled(settings.debug);
    debugPanel.update({ selectedModel: settings.ollamaModel || "" });
    overlay.updateSettings(settings);
    translator.updateSettings(settings);
    if (segmenter) {
      segmenter.updateSettings(settings);
    }
    const resetAt = Number(patch && patch.__memoryResetAt) || 0;
    if (resetAt && resetAt !== lastSeenMemoryResetAt) {
      lastSeenMemoryResetAt = resetAt;
      resetLiveContext("manual reset");
      overlay.hideNow();
    }
  }

  window.YaTranslatorSettings.onChanged(updateSettings);
  debugPanel.setEnabled(settings.debug);
  setState(State.INIT, { hook: "waiting", selectedModel: settings.ollamaModel || "" });

  window.addEventListener("ya-translator-hook-ready", () => {
    hookSeen = true;
    debugPanel.update({ hook: "ready" });
  });
  window.addEventListener("ya-translator-shadow-ready", () => {
    debugPanel.update({ shadow: "opened by hook" });
  });
  window.addEventListener("ya-translator-shadow-error", (event) => {
    debugPanel.update({ shadow: "hook error", error: event.detail && event.detail.message });
  });

  function enqueueTranslation(text) {
    if (!settings.enabled || !text || text.length < settings.minChars || text === lastSentText) {
      return;
    }
    const committedAt = Date.now();
    const clipped = cleanSourceForTranslation(text).slice(0, settings.maxInputChars);
    rememberSourceSeen(text, committedAt);
    const firstSeenAt = firstSeenFor(clipped) || firstSeenFor(text) || committedAt;
    if (isUnsafeFinalFragment(clipped)) {
      debugPanel.update({ queue: translationQueue.length, skipped: "unfinished" });
      return;
    }
    if (wasRecentlySent(clipped)) {
      debugPanel.update({ queue: translationQueue.length, skipped: "duplicate" });
      return;
    }
    const tail = translationQueue[translationQueue.length - 1];
    const tailText = tail && tail.text ? tail.text : "";
    if (translationQueue.some((item) => item.text === clipped) || tailText === clipped || lastSentText === clipped) {
      return;
    }
    if (overlapRatio(lastSentText, clipped) > 0.72) {
      return;
    }
    if (tailText && overlapRatio(tailText, clipped) > 0.72) {
      if (clipped.length > tailText.length) {
        translationQueue[translationQueue.length - 1] = {
          text: clipped,
          telemetry: { firstSeenAt, committedAt, enqueuedAt: Date.now() }
        };
      }
      return;
    }
    if (tailText && clipped.startsWith(tailText) && clipped.length - tailText.length < 24) {
      translationQueue[translationQueue.length - 1] = {
        text: clipped,
        telemetry: { firstSeenAt, committedAt, enqueuedAt: Date.now() }
      };
      return;
    }
    if (!translationInProgress) {
      translationQueue.length = 0;
    }
    markRecentlySent(clipped);
    translationQueue.push({
      text: clipped,
      telemetry: { firstSeenAt, committedAt, enqueuedAt: Date.now() }
    });
    while (translationQueue.length > MAX_TRANSLATION_QUEUE) {
      translationQueue.shift();
    }
    lastTranslationActivityAt = Date.now();
    processTranslationQueue();
  }

  async function processTranslationQueue() {
    if (translationInProgress) {
      return;
    }
    const item = translationQueue.shift();
    if (!item || !item.text) {
      return;
    }
    const text = item.text;
    const telemetry = item.telemetry || {};
    translationInProgress = true;
    lastTranslationActivityAt = Date.now();
    lastSentText = text;
    markRecentlySent(text);

    if (settings.mockMode) {
      lastTranslation = `[mock] ${text}`;
      overlay.show({ translated: lastTranslation, original: text });
      debugPanel.update({ en: text, ru: lastTranslation, backend: "extension mock", queue: translationQueue.length });
      translationInProgress = false;
      processTranslationQueue();
      return;
    }

    try {
      debugPanel.update({ requestedModel: settings.ollamaModel || "" });
      const result = await translator.translate(text, telemetry);
      lastTranslation = result.translation || "";
      lastTranslationActivityAt = Date.now();
      overlay.show({ translated: lastTranslation, original: text });
      translator.publishSubtitle({
        original: text,
        translation: lastTranslation,
        backend: result.backend,
        model: result.model,
        latency_ms: result.latency_ms,
        telemetry
      });
      debugPanel.update({
        en: text,
        ru: lastTranslation,
        backend: result.backend,
        model: result.model,
        latencyMs: result.latency_ms,
        queue: translationQueue.length,
        error: ""
      });
    } catch (error) {
      const message = error && error.name === "AbortError" ? "Translation timeout or superseded" : String(error.message || error);
      unmarkRecentlySent(text);
      if (lastSentText === text) {
        lastSentText = "";
      }
      debugPanel.update({ error: message, queue: translationQueue.length });
      if (settings.showOriginal) {
        overlay.show({ translated: "", original: text });
      }
    } finally {
      translationInProgress = false;
      lastTranslationActivityAt = Date.now();
      processTranslationQueue();
    }
  }

  async function fetchCdpText() {
    if (!settings.enableCdpFallback || cdpBusy) {
      return { text: "", lines: [] };
    }
    cdpBusy = true;
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => abortController.abort(), 7000);
    try {
      const host = window.location.hostname || "";
      const response = await fetch(`${settings.cdpReaderUrl.replace(/\/$/, "")}/subtitles?url_contains=${encodeURIComponent(host)}`, {
        cache: "no-store",
        signal: abortController.signal
      });
      if (!response.ok) {
        throw new Error(`CDP reader HTTP ${response.status}`);
      }
      const data = await response.json();
      debugPanel.update({ cdp: data.latency_ms !== undefined ? `${data.latency_ms} ms` : "ok" });
      if (data.text) {
        cdpLastText = data.text;
        cdpLastLines = Array.isArray(data.lines) ? data.lines : [];
        cdpLastSeenAt = Date.now();
        return { text: data.text, lines: cdpLastLines };
      }
      if (cdpLastText && Date.now() - cdpLastSeenAt < 2500) {
        return { text: cdpLastText, lines: cdpLastLines };
      }
      return { text: "", lines: [] };
    } catch (error) {
      debugPanel.update({ cdp: "unavailable", error: error.message || String(error) });
      return { text: "", lines: [] };
    } finally {
      window.clearTimeout(timeout);
      cdpBusy = false;
    }
  }

  function scheduleTranslation(text) {
    window.clearTimeout(stableTimer);
    let delay = isFastPunctuation(text) ? settings.fastPunctuationDebounceMs : settings.debounceMs;
    if (looksIncomplete(text)) {
      delay = Math.max(delay, 2600);
    }
    stableTimer = window.setTimeout(() => enqueueTranslation(text), delay);
  }

  function scheduleTick() {
    if (tickScheduled) {
      return;
    }
    tickScheduled = true;
    window.setTimeout(() => {
      tickScheduled = false;
      tick();
    }, 150);
  }

  function handleText(text) {
    const normalized = window.YaSubtitleNormalizeText(text);
    if (!normalized || normalized === lastRawText) {
      return;
    }
    const now = Date.now();
    if (lastAnySubtitleAt && now - lastAnySubtitleAt > getContextResetGapMs()) {
      resetLiveContext("context gap");
    }
    lastAnySubtitleAt = now;
    lastRawText = normalized;
    publishInputActivity(normalized);

    // Route live reads (YouTube CC, open-shadow Yandex) through the same
    // sliding-window segmenter the CDP path uses. Readers deliver a rolling
    // caption window; the segmenter stitches the overlaps and commits whole
    // sentences. This keeps multi-word terms intact (e.g. "Liquid Glass"
    // was split across windows and mistranslated as "жидкость"/"позвоните")
    // and removes overlapping/fragmented chunks and mid-sentence capitals.
    if (liveSource) {
      const commits = liveSource.push(normalized, now);
      if (commits.length) {
        setState(State.LISTENING, { en: commits[commits.length - 1], segmenter: "commit" });
      } else {
        setState(State.LISTENING, { en: normalized, segmenter: "read" });
      }
      for (const commit of commits) {
        enqueueTranslation(commit);
      }
      return;
    }

    // Fallback when the segmenter is unavailable: legacy naive debounce path.
    const prevWords = lastSentText.split(/\s+/).filter(Boolean).length;
    const nextWords = normalized.split(/\s+/).filter(Boolean).length;
    const isMeaningfulBoundary = /[.!?]$/.test(lastSentText.trim()) || nextWords + 2 < prevWords;
    if (lastSentText && !normalized.includes(lastSentText) && isMeaningfulBoundary) {
      enqueueTranslation(lastSentText);
    }
    setState(State.LISTENING, { en: normalized });
    scheduleTranslation(normalized);
  }

  async function tick() {
    const hookReady = document.documentElement && document.documentElement.getAttribute("data-ya-translator-hook-ready") === "1";
    if (hookReady) {
      hookSeen = true;
      debugPanel.update({ hook: "ready" });
    }

    const { text, status } = reader.read();
    debugPanel.update(status);

    // CDP fallback only makes sense for the Yandex reader (it works around
    // closed shadow roots in the Yandex subtitle widget). For YouTube CC
    // there is no closed shadow root, so skip it.
    const usingYouTubeReader = reader instanceof (window.YouTubeSubtitleReader || function () {});

    // Diagnostics (debug only): capture each distinct raw YouTube CC read so
    // we can rebuild the real rolling-window sequence for segmenter work.
    // Does not touch translation behavior.
    if (settings.debug && usingYouTubeReader && text && text !== lastCapturedRead) {
      lastCapturedRead = text;
      translator.captureRawRead(text, "youtube");
    }

    if (!text && settings.enableCdpFallback && !usingYouTubeReader) {
      const cdpResult = await fetchCdpText();
      if (cdpResult.text) {
        setState(State.READY, { shadow: "closed; using CDP", error: "" });
        handleCdpText(cdpResult.text, cdpResult.lines);
        return;
      }
    }

    if (!text) {
      if (state !== State.IDLE) {
        idleSince = Date.now();
        if (Date.now() - lastAnySubtitleAt > 5000) {
          clearCdpSegment();
          window.clearTimeout(cdpSegmentTimer);
          if (liveSource) {
            const commits = liveSource.flush(Date.now());
            for (const commit of commits) {
              if (looksIncomplete(commit) || wordsOf(commit).length < 6) {
                continue;
              }
              enqueueTranslation(commit);
            }
            liveSource.reset();
          }
          pendingFragment = "";
          pendingFragmentAt = 0;
        }
        const closedShadow = status.shadow === "closed or unavailable";
        const error = closedShadow && !settings.enableCdpFallback ? "Reload page required: closed shadow root already exists" : "";
        setState(State.IDLE, { error });
      }
      const idleMs = Date.now() - idleSince;
      const hasPendingWork = translationInProgress || translationQueue.length > 0 || Boolean(cdpSegment) || Boolean(pendingFragment);
      const recentlyActive = Date.now() - lastTranslationActivityAt < settings.hideAfterSilenceMs;
      if (lastTranslation && idleMs >= settings.hideAfterSilenceMs && !hasPendingWork && !recentlyActive) {
        overlay.hideNow();
      }
      return;
    }

    if (state === State.INIT || state === State.IDLE || state === State.ERROR) {
      setState(State.READY, { error: "" });
    }

    handleText(text);
  }

  function start() {
    window.setTimeout(() => {
      if (!hookSeen) {
        debugPanel.update({ hook: "bootstrap/fallback injected" });
        injectMainWorldFallback();
      }
    }, 300);

    window.setInterval(scheduleTick, settings.reconnectIntervalMs);
    tick();
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
