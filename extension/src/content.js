(async function () {
  "use strict";

  if (window.__yaTranslatorContentStarted) {
    try {
      console.log("[YaST/dbg] content.js skipped second init in same window", {
        url: window.location.href,
        firstInitAt: window.__yaTranslatorContentStartedAt || "unknown"
      });
    } catch (e) {}
    return;
  }
  window.__yaTranslatorContentStarted = true;
  window.__yaTranslatorContentStartedAt = new Date().toISOString();
  try {
    console.log("[YaST/dbg] content.js init", {
      url: window.location.href,
      at: window.__yaTranslatorContentStartedAt
    });
  } catch (e) {}

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

  let settings = await window.YaTranslatorSettings.load();
  if (Number(settings.qualityMaxWaitMs) < 5600) {
    settings.qualityMaxWaitMs = 5600;
  }
  const debugPanel = new window.YaTranslatorDebugPanel();
  const overlay = new window.YaTranslatorOverlay(settings);
  const reader = new window.YaSubtitleReader();
  const translator = new window.YaTranslatorClient(settings);
  const segmenter = window.YaSubtitleSegmenter ? new window.YaSubtitleSegmenter(settings) : null;

  // Diagnostic log helper. Only fires when `settings.debug` is on
  // (Options -> "Показать debug-панель"). Each call is one console.log line
  // prefixed with [YaST/dbg]. Used to trace enqueueTranslation decisions so
  // duplicate-translation root causes can be identified from DevTools.
  function dbg(...args) {
    if (settings && settings.debug) {
      try { console.log("[YaST/dbg]", ...args); } catch (e) {}
    }
  }
  function dbgText(t) {
    if (!t) return "";
    return t.length > 80 ? t.slice(0, 80) + "..." : t;
  }

  let state = State.INIT;
  let lastRawText = "";
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
  // sessionStartedAt is set when the very first subtitle is seen, and
  // also whenever a long silence triggers a context reset. While the
  // warmup window is active, enqueueTranslation and scheduleTranslation
  // loosen four guards (minChars, isUnsafeFinalFragment, debounce delay,
  // shouldDropChunk) so the opening phrase of a stream is not silently
  // dropped. See README/docs/app-overview.md for the rationale.
  let sessionStartedAt = 0;
  let warmupFirstSeen = "";
  let warmupFirstSeenAt = 0;
  const WARMUP_DURATION_MS = 5000;
  const WARMUP_FIRST_FLUSH_DELAY_MS = 200;
  const WARMUP_FIRST_FLUSH_MAX_AGE_MS = 1500;
  function isWarmupActive() {
    return sessionStartedAt && (Date.now() - sessionStartedAt) < WARMUP_DURATION_MS;
  }
  function markFreshSessionStart(now, reason, snapshotText = "") {
    sessionStartedAt = now;
    warmupFirstSeen = "";
    warmupFirstSeenAt = 0;
    if (settings && settings.debug) {
      try { console.log("[YaST/dbg] warmup-start", { reason, now }); } catch (e) {}
    }
    if (snapshotText) {
      captureWarmupFirstSeen(snapshotText, now);
    }
  }
  function captureWarmupFirstSeen(text, now) {
    if (warmupFirstSeen || !text) return;
    warmupFirstSeen = text;
    warmupFirstSeenAt = now;
    // Flush the captured snapshot quickly. The regular debounce keeps resetting
    // on every Yandex DOM update, so without this snapshot the very first words
    // get scrolled out of the sliding window before they ever reach the server.
    window.setTimeout(() => {
      if (!warmupFirstSeen) return;
      if (Date.now() - warmupFirstSeenAt > WARMUP_FIRST_FLUSH_MAX_AGE_MS) {
        warmupFirstSeen = "";
        return;
      }
      const snapshot = warmupFirstSeen;
      warmupFirstSeen = "";
      enqueueTranslation(snapshot, "warmup-first-flush");
    }, WARMUP_FIRST_FLUSH_DELAY_MS);
  }
  const translationQueue = [];
  let translationInProgress = false;
  const FRAGMENT_JOIN_MAX_MS = 8000;
  const FRAGMENT_STALE_MS = 10000;
  const HARD_FRAGMENT_STALE_MS = 6500;
  const SOFT_FRAGMENT_STALE_MS = 8200;
  const RECENT_TEXT_TTL_MS = 45000;
  const MAX_TRANSLATION_QUEUE = 2;
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

  function isFastPunctuation(text) {
    return /[.!?,;:]$/.test(text.trim());
  }

  function looksIncomplete(text) {
    const value = text.trim().toLowerCase();
    if (!value) {
      return true;
    }
    const words = value.split(/\s+/);
    const last = words[words.length - 1].replace(/[^\w']+$/g, "");
    const weakEndings = new Set([
      "a",
      "an",
      "the",
      "to",
      "of",
      "and",
      "or",
      "but",
      "with",
      "for",
      "from",
      "in",
      "on",
      "at",
      "as",
      "such",
      "whether",
      "probably",
      "maybe",
      "will",
      "we'll",
      "we",
      "i",
      "my",
      "they",
      "that",
      "this",
      "those",
      "these",
      "because",
      "absolutely",
      "possibly",
      "probably",
      "actually",
      "spent",
      "eventually",
      "southern",
      "entire",
      "reflecting",
      "showcasing",
      "visiting",
      "continuing",
      "preserved",
      "valued",
      "farmers",
      "cabbages",
      "ingredient",
      "represent",
      "buying",
      "more",
      "less",
      "costs",
      "between",
      "above",
      "lose",
      "serve",
      "widespread",
      "retired",
      "destabilize",
      "approving",
      "contract",
      "contracts",
      "ownership",
      "subsidies",
      "accountable",
      "framework",
      "recommendations",
      "ban",
      "easy",
      "now",
      "you",
      "gorgeous",
      "consistent",
      "celebrates",
      "captures",
      "settings",
      "actions",
      "content",
      "experience",
      "moments",
      "whole",
      "power",
      "aio",
      "mod",
      "mode",
      "capabilities",
      "complex",
      "tools",
      "twos",
      "linking",
      "helping",
      "our",
      "live",
      "material",
      "drape",
      "billions",
      "fifty",
      "million",
      "developers",
      "per",
      "pod",
      "every",
      "using",
      "turning",
      "two",
      "point",
      "products",
      "last",
      "ten",
      "new",
      "weight",
      "really"
    ]);
    return weakEndings.has(last) || /[,—-]\s*$/.test(value);
  }

  function hasHardIncompleteTail(text) {
    const value = text.trim().toLowerCase();
    if (!value) {
      return true;
    }
    const words = value.split(/\s+/);
    const last = words[words.length - 1].replace(/[^\w']+$/g, "");
    const lastTwo = words.slice(-2).join(" ").replace(/[^\w' ]+$/g, "");
    const hardTailWords = new Set([
      "a",
      "an",
      "the",
      "to",
      "of",
      "and",
      "or",
      "but",
      "with",
      "for",
      "from",
      "in",
      "on",
      "at",
      "as",
      "that",
      "which",
      "who",
      "when",
      "where",
      "because",
      "make",
      "making",
      "screen",
      "high",
      "low",
      "more",
      "less",
      "new",
      "next",
      "every",
      "all",
      "our",
      "your",
      "their",
      "this",
      "these",
      "those",
      "seventeen",
      "get",
      "say",
      "safe",
      "start",
      "stop",
      "reclaim",
      "remind",
      "reflect",
      "show",
      "announced",
      "introduce",
      "bringing",
      "keeping",
      "unlock",
      "enabling"
    ]);
    return hardTailWords.has(last) || /\b(android|ios|gemini|chrome|pixel|iphone|ipad|mac|search)\s*-\s*[a-z0-9]+[,]?$/.test(value) || /\b(but make|with screen|that can|that will|to make|able to|going to|want to|need to|high in|low in|let's say|so let's)$/.test(lastTwo);
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

  function isUnsafeFinalFragment(text) {
    const value = window.YaSubtitleNormalizeText(text);
    const words = wordsOf(value);
    if (!value || isSentenceBoundary(value)) {
      return false;
    }
    if (hasHardIncompleteTail(value) || looksIncomplete(value)) {
      return true;
    }
    if (words.length <= 6 && (isLikelyContinuation(value) || /^[a-z]/.test(value))) {
      return true;
    }
    return words.length <= 10 && /^(and|or|but|so|with|without|for|from|to|into|about|like|including|using|bringing|keeping|enabling|unlocking)\b/i.test(value);
  }

  function isSentenceBoundary(text) {
    return /[.!?]\s*$/.test(text.trim());
  }

  function splitFirstCompleteSentence(text) {
    const value = window.YaSubtitleNormalizeText(text);
    const match = value.match(/^(.+?[.!?])(?:\s+(.+))?$/);
    if (!match) {
      return { head: "", tail: value };
    }
    return {
      head: match[1].trim(),
      tail: (match[2] || "").trim()
    };
  }

  function wordsOf(text) {
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function normalizedWords(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  // Overlap-suppression for the sliding window: if the new EN literally starts
  // with the words that ended the previously SENT EN, clip that shared prefix.
  // Yandex live subtitles emit a sliding window that re-shows the tail of the
  // previous fragment at the head of the next one — without this clip the
  // viewer sees the same Russian text twice within a couple of seconds.
  //
  // Conservative thresholds (chosen so the function never makes things worse):
  //  - overlap must be at least 4 words long (no false hits on common words);
  //  - at least 3 words must remain in the tail. Earlier we required 6, but on
  //    real broadcasts a typical sliding-window fragment is 8–10 words with a
  //    6–7-word overlap, which leaves only a 2–4-word tail. Requiring 6+ word
  //    tail blocked the majority of legitimate clips. 3 words is enough for
  //    the model: it keeps a context window of recent translations, so a short
  //    tail still gets translated coherently;
  //  - overlap is a strict ordered word-by-word match (suffix of A == prefix of B),
  //    not a bag-of-words ratio;
  //  - cap on the overlap length keeps the algorithm cheap and avoids matching
  //    pathological cases where a long phrase happens to repeat.
  // If any condition fails, the original text is returned unchanged.
  const OVERLAP_CLIP_MIN_OVERLAP_WORDS = 4;
  const OVERLAP_CLIP_MIN_TAIL_WORDS = 3;
  const OVERLAP_CLIP_MAX_OVERLAP_WORDS = 12;
  function clipOverlapPrefix(prevEn, newEn) {
    if (!prevEn || !newEn) return newEn;
    const prevWords = wordsOf(prevEn);
    const newWords = wordsOf(newEn);
    if (prevWords.length < OVERLAP_CLIP_MIN_OVERLAP_WORDS) return newEn;
    if (newWords.length < OVERLAP_CLIP_MIN_OVERLAP_WORDS + OVERLAP_CLIP_MIN_TAIL_WORDS) return newEn;
    const normalize = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
    const prevNorm = prevWords.map(normalize);
    const newNorm = newWords.map(normalize);
    const maxK = Math.min(prevNorm.length, newNorm.length - OVERLAP_CLIP_MIN_TAIL_WORDS, OVERLAP_CLIP_MAX_OVERLAP_WORDS);
    for (let k = maxK; k >= OVERLAP_CLIP_MIN_OVERLAP_WORDS; k -= 1) {
      let match = true;
      for (let i = 0; i < k; i += 1) {
        if (prevNorm[prevNorm.length - k + i] !== newNorm[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        return newWords.slice(k).join(" ");
      }
    }
    return newEn;
  }

  function overlapRatio(a, b) {
    const left = normalizedWords(a);
    const right = normalizedWords(b);
    if (!left.length || !right.length) {
      return 0;
    }
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    let best = 0;
    for (let i = 0; i <= longer.length - shorter.length; i += 1) {
      let same = 0;
      for (let j = 0; j < shorter.length; j += 1) {
        if (longer[i + j] === shorter[j]) {
          same += 1;
        }
      }
      best = Math.max(best, same / shorter.length);
    }
    return best;
  }

  function shouldDropChunk(text) {
    const value = window.YaSubtitleNormalizeText(text).toLowerCase();
    const words = normalizedWords(value);
    if (!value || words.length < 4) {
      return true;
    }

    if (words.length < 6 && looksIncomplete(value)) {
      return true;
    }

    if (/\b(that|because|when|where|which|who|with|without|from|into|about|on|to|and|or|but|we|they|i)\s*$/.test(value)) {
      return true;
    }

    if (/\bthat\s+the\s*$/.test(value) || /\bclear\s+about\s+the\s+facts\s+that\b/.test(value)) {
      return true;
    }

    if (/\b(that|which|who|where|when|while|as|so|because|if)\s+(you|we|they|it|this|that|your|our|the|a|an)?\s*$/.test(value)) {
      return true;
    }

    const weakTailPhrases = [
      /\bjust\s+swipe$/,
      /\btakes\s+advantage\s+of\s+the\s+gorgeous$/,
      /\byour\s+albums,\s+and\s+easy$/,
      /\bthree\s+d\s+effect\s+that\s+you$/,
      /\bthe\s+stunning\s+three\s+d\s+effect\s+that\s+you$/,
      /\bimportant\s+controls\s+now$/,
      /\ba\s+space\s+that\s+celebrates$/,
      /\bspecial\s+moments$/,
      /\bfor\s+a\s+consistent$/,
      /\bconsistent\s+expressive\s+experience\s+while\s+you\s+drive$/,
      /\bwhile\s+creating\s+a\s+more\s+immersive\s+experience$/,
      /\bflow\s+edge\s+to\s+edge$/,
      /\bfloat\s+above\s+the\s+webpage$/,
      /\bfront\s+and\s+center$/,
      /\bliquid\s+glass\s+controls\s+fluidly\s+reveal\s+other\s+actions$/,
      /\bour\s+aio$/,
      /\ban?\s+all\s+new\s+ai\s+mod$/,
      /\bcoming\s+to\s+everyone\s+in\s+the\s+u$/,
      /\bin\s+our\s+biggest\s+markets\s+like\s+the\s+u$/,
      /\bsince\s+launching\s+at\s+io\s+last$/,
      /\baio\s+(views|overviews)\s+are\s+driving\s+over\s+ten$/,
      /\bplaces\s+i've\s+never\s+been\s+before\s+and\s+meet\s+new$/,
      /\byou\s+can\s+bring\s+your$/,
      /\bi\s+love\s+sharing\s+my\.?$/,
      /\bto\s+how\s+you\s+actually\s+express\s+yourself\.?$/,
      /\bpopular\s+apps\s+like\s+gboard,\s+youtube,\s+and\s+gmail\.?$/,
      /\bmany\s+of\s+our\s+users\s+say\s+they\s+want\s+stronger\s+controls\s+that\s+help\s+stop\s+them\s+from\s+turning\.?$/,
      /\bgives\s+me\s+a\s+moment\s+of\s+pause\b.*\bwhy\s+am\s+i\s+really\.?$/,
      /\band\s+lately,\s+there's\s+been$/,
      /\bwhere\s+more\s+of\s+the\s+weight\s+of$/,
      /\bto\s+share\s+a\s+whole$/,
      /\bthe\s+same\s+models\s+that\s+power\s+ai\s+mode\s+to\s+power$/,
      /\bdeeper\s+research,\s+complex$/,
      /\bsearch\s+helps\s+me\s+skip\s+a\s+bunch\s+of\s+steps,\s+linking$/,
      /\bsearch\s+live\s+to\s+the\s+ultimate\s+test,\s+helping\s+us\s+and\s+our$/,
      /\bwhich\s+has\s+over\s+fifty$/,
      /\bthe\s+was\s+most\s+comprehensive\s+set\s+of\s+products$/,
      /\bai\s+module\s+is\s+able\s+to\s+show\s+how\s+this\s+material$/,
      /\band\s+today,\s+gemini\s+two$/,
      /\bthat'?s\s+about\s+a\s+fifty$/,
      /\btoday,\s+over\s+seven\s+million\s+developers$/,
      /\boutput\s+tokens\s+generated\s+per\s+second,\s+all$/,
      /\bmodels\s+of\s+the\s+top\s+models\s+on\s+the\b.*$/,
      /\bwe\s+are\s+bringing\s+project\s+mariners'?$/,
      /\bit\s+integrates\s+with\s+github\s+and\s+works\s+on\s+its$/,
      /\bwith\s+access\s+to\s+twos,\s+they\s+can\s+take$/,
      /\bwill\s+fold\s+and\s+stretch\s+and\s+drape$/,
      /\bstate\s+-?\s*of\s+-?\s*the\s+-?\s*art\b.*\bvisualize\s+how\s+billions$/,
      /\bfrom\s+one\s+place\s+to\s+another,\s+sometimes\s+we\s+would\s+lose$/,
      /\byou\s+know\s+how\s+much\s+they\s+serve$/,
      /\band\s+buying\s+more$/,
      /\bsourcing\s+less\s+from\s+local\s+producers,\s+and\s+buying\s+more$/,
      /\bwhich\s+costs(?:\s+just)?$/,
      /\bsomething\s+that\s+represent$/,
      /\bthe\s+main\s+ingredient$/,
      /\bon\s+top\s+of\s+competition,\s+farmers$/,
      /\bonce\s+that\s+happens,\s+cabbages$/,
      /\banywhere\s+between$/,
      /\brealibrate\s+the\s+relationship\s+between$/,
      /\bcalled\s+\w+\s+from\b.*\band\s+probably\s+the\s+most$/,
      /\bthe\s+most$/,
      /\bcould\s+be\s+widespread$/,
      /\bshould\s+continue\s+to\s+be\s+preserved\s+and\s+valued$/,
      /\bable\s+to\s+employe?\s+retired$/,
      /\btelevision\s+shows\s+like\b.*\band$/,
      /\b(or\s+){1,2}fox,\s+and$/,
      /\bwhich\s+of\s+course\s+means\s+more\s+contracts?$/,
      /\bmalign\s+and\s+an?\s+aggressive\s+behavior\s+and\s+destabilize$/,
      /\bwho\s+are\s+approving$/,
      /\bif\s+you\s+would\s+have\s+a\s+ban$/,
      /\boutlined\s+a\s+number\s+of\s+recommendations$/,
      /\bhas\s+bombed\s+or\s+invaded$/
    ];

    if (weakTailPhrases.some((pattern) => pattern.test(value))) {
      return true;
    }

    if (words.length < 12 && /\b(continuing|reflecting|showcasing|visiting|preserved|valued|farmers|cabbages|ingredient|represent|widespread|between|above|retired|destabilize|approving|recommendations|ban|easy|now|you|gorgeous|consistent|celebrates|captures|settings|actions|content|experience|moments|whole|power|aio|mod|mode|capabilities|complex|tools|twos|linking|helping|our|live|material|drape|billions|fifty|million|developers|per|pod|every|using|two|point|products|last|ten|new|weight)$/.test(value)) {
      return true;
    }

    const badFragments = [
      /^and as i've\b/,
      /^the art on\b/,
      /^output tokens generated\b/,
      /^and also,?\s+we were absolutely\b/,
      /^also,?\s+we were absolutely\b/,
      /^the response on\b/,
      /^response to the u\b/,
      /^negotiations$/,
      /^particularly i think\b/,
      /^they need to find\b/,
      /^we heard from our\b/,
      /^to get to negotiations\b/,
      /^this is the azira user\b/
    ];

    return badFragments.some((pattern) => pattern.test(value));
  }

  function isLikelyContinuation(text) {
    const raw = window.YaSubtitleNormalizeText(text);
    const value = raw.toLowerCase();
    if (!value) {
      return false;
    }
    if (/^[a-z]/.test(raw)) {
      return true;
    }
    return /^(currently|use|using|uses|used|watch|car|glasses|phone|popular|apps|a real|the real|real|based on|with|without|where|which|that|who|when|while|because|to|for|from|into|about|like|including|and|but|so|or|it|they|we|you|this|these|those|same|another|more|less)\b/.test(value);
  }

  function isHoldableFragment(text) {
    const value = window.YaSubtitleNormalizeText(text).toLowerCase();
    if (!value) {
      return false;
    }
    const words = wordsOf(value);
    if (words.length < 4) {
      return true;
    }
    if (isSentenceBoundary(value) && words.length >= 7 && !looksIncomplete(value)) {
      return false;
    }
    if (looksIncomplete(value)) {
      return true;
    }
    if (words.length <= 7 && !isSentenceBoundary(value)) {
      return true;
    }
    return /^(and now i'?m wondering|and now i am wondering|and lately|where more of|currently use|currently using|a real impact)\b/.test(value);
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
    if (sourceSeenKeys.has(key)) {
      return sourceSeenKeys.get(key);
    }
    let bestSeenAt = 0;
    let bestWords = 0;
    for (const [seenKey, seenAt] of sourceSeenKeys.entries()) {
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
    translator.resetContext();
    debugPanel.update({ queue: 0, skipped: reason || "context reset" });
  }

  function cleanSourceForTranslation(text) {
    let value = collapseRepeatedSentences(text);
    value = removeRepeatedTail(value);
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
    if (!lastAnySubtitleAt) {
      markFreshSessionStart(now, "firstEver-cdp", normalized);
    } else if (now - lastAnySubtitleAt > getContextResetGapMs()) {
      markFreshSessionStart(now, "longSilence-cdp", normalized);
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
        enqueueTranslation(commit, "cdp-segmenter-commit");
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
    if (!isWarmupActive() && shouldDropChunk(toTranslate)) {
      cdpSegment = split.head ? split.tail : text;
      cdpLastWindow = cdpSegment;
      if (cdpSegment && Date.now() - cdpSegmentStartedAt < settings.qualityMaxWaitMs + 4500) {
        scheduleCdpSegmentFlush();
      } else {
        clearCdpSegment();
      }
      return;
    }
    enqueueTranslation(toTranslate, "cdp-legacy-flush");
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

  function enqueueTranslation(text, origin = "unknown") {
    const warmup = isWarmupActive();
    const effectiveMinChars = warmup ? Math.min(settings.minChars, 4) : settings.minChars;
    if (!settings.enabled || !text || text.length < effectiveMinChars || text === lastSentText) {
      if (settings.debug) {
        const reason = !settings.enabled ? "disabled" :
                       !text ? "empty" :
                       text.length < effectiveMinChars ? "tooShort" :
                       "sameAsLastSent";
        dbg("skip", { origin, reason, text: dbgText(text), warmup });
      }
      return;
    }
    const committedAt = Date.now();
    let clipped = cleanSourceForTranslation(text).slice(0, settings.maxInputChars);
    const clippedAfterOverlap = clipOverlapPrefix(lastSentText, clipped);
    if (clippedAfterOverlap !== clipped) {
      const removed = clipped.slice(0, clipped.length - clippedAfterOverlap.length).trim();
      dbg("clipped-overlap", { origin, removed: dbgText(removed), kept: dbgText(clippedAfterOverlap) });
      clipped = clippedAfterOverlap;
    }
    rememberSourceSeen(text, committedAt);
    const firstSeenAt = firstSeenFor(clipped) || firstSeenFor(text) || committedAt;
    dbg("try", { origin, text: dbgText(clipped), qLen: translationQueue.length, inProgress: translationInProgress, warmup });
    if (!warmup && isUnsafeFinalFragment(clipped)) {
      dbg("skip", { origin, reason: "unsafeFinalFragment", text: dbgText(clipped) });
      debugPanel.update({ queue: translationQueue.length, skipped: "unfinished" });
      return;
    }
    if (wasRecentlySent(clipped)) {
      dbg("skip", { origin, reason: "recentlySent45s", text: dbgText(clipped) });
      debugPanel.update({ queue: translationQueue.length, skipped: "duplicate" });
      return;
    }
    const tail = translationQueue[translationQueue.length - 1];
    const tailText = tail && tail.text ? tail.text : "";
    if (translationQueue.some((item) => item.text === clipped) || tailText === clipped || lastSentText === clipped) {
      dbg("skip", { origin, reason: "alreadyInQueue", text: dbgText(clipped) });
      return;
    }
    if (overlapRatio(lastSentText, clipped) > 0.72) {
      dbg("skip", { origin, reason: "overlapWithLastSent>0.72", text: dbgText(clipped) });
      return;
    }
    if (tailText && overlapRatio(tailText, clipped) > 0.72) {
      if (clipped.length > tailText.length) {
        dbg("replaceTail", { origin, reason: "overlapWithTail>0.72", text: dbgText(clipped) });
        translationQueue[translationQueue.length - 1] = {
          text: clipped,
          telemetry: { firstSeenAt, committedAt, enqueuedAt: Date.now() }
        };
      } else {
        dbg("skip", { origin, reason: "overlapWithTail>0.72 (shorter)", text: dbgText(clipped) });
      }
      return;
    }
    if (tailText && clipped.startsWith(tailText) && clipped.length - tailText.length < 24) {
      dbg("replaceTail", { origin, reason: "extendsTailBy<24", text: dbgText(clipped) });
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
    dbg("enqueued", { origin, text: dbgText(clipped), qLen: translationQueue.length + 1 });
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
    dbg("POST /translate", { text: dbgText(text), qLeft: translationQueue.length });

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
    // Warmup: just after a fresh start or after a long silence the Yandex
    // sliding window is short-lived. If we wait the usual debounce, the
    // opening fragment gets shifted out before we send it. Force the fast
    // debounce so the first line reaches the server while it's still in
    // the DOM.
    if (isWarmupActive()) {
      delay = Math.min(delay, settings.fastPunctuationDebounceMs);
    }
    stableTimer = window.setTimeout(() => enqueueTranslation(text, "dom-stable-timer"), delay);
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
    if (normalized && normalized !== lastRawText) {
      const now = Date.now();
      if (lastAnySubtitleAt && now - lastAnySubtitleAt > getContextResetGapMs()) {
        resetLiveContext("context gap");
      }
      if (!lastAnySubtitleAt) {
        markFreshSessionStart(now, "firstEver-dom", normalized);
      } else if (now - lastAnySubtitleAt > getContextResetGapMs()) {
        markFreshSessionStart(now, "longSilence-dom", normalized);
      }
      lastAnySubtitleAt = now;
      const prevWords = lastRawText.split(/\s+/).filter(Boolean).length;
      const nextWords = normalized.split(/\s+/).filter(Boolean).length;
      const isMeaningfulBoundary = /[.!?]$/.test(lastRawText.trim()) || nextWords + 2 < prevWords;
      if (lastRawText && !normalized.includes(lastRawText) && lastRawText !== lastSentText && isMeaningfulBoundary) {
        enqueueTranslation(lastRawText, "dom-raw-boundary");
      }
      lastRawText = normalized;
      publishInputActivity(normalized);
      setState(State.LISTENING, { en: normalized });
      scheduleTranslation(normalized);
    }
  }

  async function tick() {
    const hookReady = document.documentElement && document.documentElement.getAttribute("data-ya-translator-hook-ready") === "1";
    if (hookReady) {
      hookSeen = true;
      debugPanel.update({ hook: "ready" });
    }

    const { text, status } = reader.read();
    debugPanel.update(status);

    if (!text && settings.enableCdpFallback) {
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
          if (segmenter) {
            const commits = segmenter.flush(Date.now());
            for (const commit of commits) {
              if (looksIncomplete(commit) || wordsOf(commit).length < 6) {
                continue;
              }
              enqueueTranslation(commit, "shadow-close-flush");
            }
            segmenter.reset();
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
