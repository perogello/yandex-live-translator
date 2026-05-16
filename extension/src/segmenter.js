(function () {
  "use strict";

  const WEAK_END_WORDS = new Set([
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
    "get",
    "say",
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
    "enabling",
    "generation",
    "information",
    "summary",
    "everything",
    "something",
    "anything",
    "everyone",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "hundred",
    "thousand",
    "million",
    "billion",
    "trillion",
    "more",
    "new",
    "all",
    "our",
    "your",
    "their",
    "this",
    "these",
    "those"
  ]);

  const CONTINUATION_START = /^(and|but|so|or|which|that|who|when|where|while|because|then|now|also|this|these|those|it|they|we|you|with|without|for|from|to|into|about|like|including|using|bringing|keeping|enabling|unlocking)\b/i;

  function normalize(text) {
    if (window.YaSubtitleNormalizeText) {
      return window.YaSubtitleNormalizeText(text);
    }
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function wordsOf(text) {
    return normalize(text).split(/\s+/).filter(Boolean);
  }

  function wordKey(text) {
    return normalize(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  }

  function cleanRepeatedWords(text) {
    const words = wordsOf(text);
    if (words.length < 2) {
      return normalize(text);
    }
    const output = [];
    for (const word of words) {
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
    let words = wordsOf(cleanRepeatedWords(text));
    for (let index = 0; index < words.length; index += 1) {
      for (let size = Math.min(8, Math.floor((words.length - index) / 2)); size >= 2; size -= 1) {
        const left = words.slice(index, index + size).join(" ").toLowerCase();
        const right = words.slice(index + size, index + size * 2).join(" ").toLowerCase();
        if (left === right) {
          words.splice(index + size, size);
          index = Math.max(-1, index - 1);
          break;
        }
      }
    }
    for (let size = Math.min(12, Math.floor(words.length / 2)); size >= 3; size -= 1) {
      const tail = words.slice(-size).join(" ").toLowerCase();
      for (let start = 0; start <= words.length - size * 2; start += 1) {
        const chunk = words.slice(start, start + size).join(" ").toLowerCase();
        if (chunk === tail) {
          words = words.slice(0, words.length - size);
          return words.join(" ");
        }
      }
    }
    return words.join(" ");
  }

  function endsSentence(text) {
    return /[.!?]\s*$/.test(normalize(text));
  }

  function startsLowercase(text) {
    return /^[a-z]/.test(normalize(text));
  }

  function lastWord(text) {
    const words = wordsOf(text);
    if (!words.length) {
      return "";
    }
    return words[words.length - 1].toLowerCase().replace(/[^\w']+$/g, "");
  }

  function looksWeakTail(text) {
    const value = normalize(text).toLowerCase();
    const words = wordsOf(value);
    if (!value || !words.length) {
      return true;
    }
    const last = lastWord(value);
    const lastTwo = words.slice(-2).join(" ").replace(/[^\w' ]+$/g, "");
    return (
      WEAK_END_WORDS.has(last) ||
      /[,—-]\s*$/.test(value) ||
      /\b(so let's|let's say|but make|with screen|that can|that will|to make|able to|going to|want to|need to|high in|low in|get new|build the|next generation|benefit from what)$/.test(lastTwo)
    );
  }

  function isUnsafeFinalFragment(text) {
    const value = normalize(text);
    const lower = value.toLowerCase();
    const words = wordsOf(value);
    if (!value || endsSentence(value)) {
      return false;
    }
    if (looksWeakTail(value)) {
      return true;
    }
    if (words.length <= 6 && (startsLowercase(value) || CONTINUATION_START.test(value))) {
      return true;
    }
    return words.length <= 10 && /^(and|or|but|so|with|without|for|from|to|into|about|like|including|using|bringing|keeping|enabling|unlocking)\b/i.test(lower);
  }

  function appendSlidingWindow(previousWindow, segment, currentWindow) {
    const current = removeRepeatedTail(currentWindow);
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
        segment: suffix ? removeRepeatedTail(`${segment} ${suffix}`) : segment,
        changed: Boolean(suffix),
        reset: false
      };
    }

    if (current.length > previousWindow.length && current.includes(previousWindow)) {
      return { segment: removeRepeatedTail(current), changed: current !== segment, reset: false };
    }

    return { segment: current, changed: current !== segment, reset: true };
  }

  function splitAtSentence(text) {
    const value = normalize(text);
    const match = value.match(/^(.+?[.!?])(?:\s+(.+))?$/);
    if (!match) {
      return null;
    }
    return { commit: match[1].trim(), rest: (match[2] || "").trim() };
  }

  function splitAtSafeClause(text) {
    const value = normalize(text);
    const words = wordsOf(value);
    if (words.length < 14) {
      return null;
    }

    const separators = [",", ";", ":"];
    let bestIndex = -1;
    for (const sep of separators) {
      const index = value.lastIndexOf(sep);
      if (index > bestIndex) {
        bestIndex = index;
      }
    }
    if (bestIndex <= 24 || bestIndex > value.length - 18) {
      return null;
    }

    const head = value.slice(0, bestIndex + 1).trim();
    const rest = value.slice(bestIndex + 1).trim();
    if (wordsOf(head).length < 8 || wordsOf(rest).length < 4) {
      return null;
    }
    return { commit: head, rest };
  }

  function findStablePrefix(previous, current) {
    const left = wordsOf(previous);
    const right = wordsOf(current);
    const max = Math.min(left.length, right.length);
    let count = 0;
    while (count < max && left[count].toLowerCase() === right[count].toLowerCase()) {
      count += 1;
    }
    if (count < 6) {
      return "";
    }
    return right.slice(0, count).join(" ");
  }

  class SubtitleSegmenter {
    constructor(settings = {}) {
      this.settings = settings;
      this.lastWindow = "";
      this.previousWindow = "";
      this.segment = "";
      this.segmentStartedAt = 0;
      this.segmentUpdatedAt = 0;
      this.pendingFragment = "";
      this.pendingAt = 0;
      this.lastCommitKey = "";
    }

    updateSettings(settings) {
      this.settings = { ...this.settings, ...settings };
    }

    reset() {
      this.lastWindow = "";
      this.previousWindow = "";
      this.segment = "";
      this.segmentStartedAt = 0;
      this.segmentUpdatedAt = 0;
      this.pendingFragment = "";
      this.pendingAt = 0;
    }

    pushLines(rawLines, now = Date.now()) {
      const lines = (Array.isArray(rawLines) ? rawLines : [])
        .map((line) => normalize(line))
        .filter(Boolean);
      if (!lines.length) {
        return [];
      }

      return this.push(lines.join(" "), now);
    }

    push(rawText, now = Date.now()) {
      const current = removeRepeatedTail(rawText);
      if (!current) {
        return [];
      }

      const previousSegment = this.segment;
      const previousWindow = this.lastWindow;
      const merged = appendSlidingWindow(this.lastWindow, this.segment, current);
      const commits = [];

      if (merged.reset && previousSegment) {
        this.segment = previousSegment;
        const boundaryCommit = this._maybeCommit(now, { resetBoundary: true });
        if (boundaryCommit) {
          commits.push(boundaryCommit);
        }
      }

      this.previousWindow = previousWindow;
      this.lastWindow = current;
      if (!this.segmentStartedAt || merged.reset) {
        this.segmentStartedAt = now;
      }
      if (merged.changed) {
        this.segmentUpdatedAt = now;
      }
      this.segment = removeRepeatedTail(merged.segment).slice(-(Number(this.settings.maxInputChars) || 1200));

      let guard = 0;
      while (guard < 2) {
        guard += 1;
        const commit = this._maybeCommit(now);
        if (!commit) {
          break;
        }
        commits.push(commit);
      }
      return commits;
    }

    flush(now = Date.now()) {
      const commit = this._maybeCommit(now, { force: true });
      return commit ? [commit] : [];
    }

    _maybeCommit(now, options = {}) {
      const text = normalize(this.segment);
      if (!text) {
        return "";
      }

      const age = now - (this.segmentStartedAt || now);
      const stableFor = now - (this.segmentUpdatedAt || now);
      const sentence = splitAtSentence(text);
      let commit = "";
      let rest = "";

      const sentenceStable = sentence && this.previousWindow && normalize(this.previousWindow).includes(sentence.commit);
      if (sentence && this._canCommitSentence(sentence.commit, age, stableFor, { ...options, stableKnown: sentenceStable })) {
        commit = sentence.commit;
        rest = sentence.rest;
      } else {
        const safeClause = splitAtSafeClause(text);
        const stablePrefix = this.previousWindow ? findStablePrefix(this.previousWindow, text) : "";
        const candidate = safeClause || (stablePrefix ? { commit: stablePrefix, rest: text.slice(stablePrefix.length).trim() } : null);

        if (candidate && this._canCommit(candidate.commit, age, stableFor, { partial: true })) {
          commit = candidate.commit;
          rest = candidate.rest;
        } else if (this._canCommit(text, age, stableFor, options)) {
          commit = text;
          rest = "";
        }
      }

      commit = this._joinPending(commit, now);
      commit = normalize(commit);
      if (!commit || !this._isUsefulCommit(commit)) {
        if (endsSentence(text)) {
          return "";
        }
        this._holdIfUseful(text, now);
        return "";
      }

      const key = wordKey(commit);
      if (key && key === this.lastCommitKey) {
        this.segment = rest;
        this._resetTimingForRest(now);
        return "";
      }

      this.lastCommitKey = key;
      this.segment = normalize(rest);
      this._resetTimingForRest(now);
      return commit;
    }

    _canCommit(text, age, stableFor, options = {}) {
      const value = normalize(text);
      const words = wordsOf(value);
      if (!value || words.length < 4) {
        return false;
      }
      if (endsSentence(value) && words.length >= 5) {
        return this._canCommitSentence(value, age, stableFor, options);
      }
      if (looksWeakTail(value)) {
        return false;
      }
      if (options.force && isUnsafeFinalFragment(value)) {
        return false;
      }
      if (options.partial) {
        return words.length >= 8 && stableFor >= 700 && !CONTINUATION_START.test(value);
      }
      if (words.length < 8 && !options.force) {
        return false;
      }
      if (words.length >= 22 && stableFor >= 500) {
        return true;
      }
      if (words.length >= 16 && age >= 1800 && stableFor >= 650) {
        return true;
      }
      if (words.length >= 12 && age >= 3200 && stableFor >= 800) {
        return true;
      }
      const maxWait = Math.max(5600, Number(this.settings.qualityMaxWaitMs) || 5600);
      if (age >= maxWait && stableFor >= 800 && words.length >= 9) {
        return true;
      }
      if (age >= 7600 && words.length >= 7 && !looksWeakTail(value)) {
        return true;
      }
      return false;
    }

    _canCommitSentence(text, age, stableFor, options = {}) {
      const value = normalize(text);
      const words = wordsOf(value);
      if (!value || !endsSentence(value)) {
        return false;
      }
      if (options.stableKnown && words.length >= 5 && !looksWeakTail(value)) {
        return true;
      }
      if (words.length >= 7) {
        return stableFor >= 250 || options.force || options.resetBoundary;
      }
      if (words.length >= 6 && !looksWeakTail(value)) {
        return stableFor >= 450 || options.force || options.resetBoundary;
      }
      if (words.length >= 5 && !looksWeakTail(value)) {
        return stableFor >= 900 || options.force || options.resetBoundary;
      }
      if (options.force && words.length >= 5 && !startsLowercase(value) && !CONTINUATION_START.test(value)) {
        return true;
      }
      if (options.resetBoundary && words.length >= 5 && !startsLowercase(value) && !looksWeakTail(value)) {
        return true;
      }
      return false;
    }

    _joinPending(commit, now) {
      const current = normalize(commit);
      if (!this.pendingFragment) {
        return current;
      }
      const pendingKey = wordKey(this.pendingFragment);
      const currentKey = wordKey(current);
      if (currentKey === pendingKey || currentKey.startsWith(`${pendingKey} `)) {
        this.pendingFragment = "";
        this.pendingAt = 0;
        return current;
      }
      const pendingAge = now - this.pendingAt;
      if (pendingAge > 10000) {
        this.pendingFragment = "";
        this.pendingAt = 0;
        return current;
      }
      if (CONTINUATION_START.test(current) || /^[a-z]/.test(current)) {
        const joined = normalize(`${this.pendingFragment} ${current}`);
        this.pendingFragment = "";
        this.pendingAt = 0;
        return joined;
      }
      return current;
    }

    _holdIfUseful(text, now) {
      const words = wordsOf(text);
      if (words.length >= 2 && words.length <= 10) {
        this.pendingFragment = normalize(text);
        this.pendingAt = now;
        this.segment = "";
        this._resetTimingForRest(now);
      }
    }

    _isUsefulCommit(text) {
      const words = wordsOf(text);
      if (words.length < 4) {
        return endsSentence(text) && words.length >= 3;
      }
      if (words.length < 6 && looksWeakTail(text)) {
        return false;
      }
      return true;
    }

    _resetTimingForRest(now) {
      if (this.segment) {
        this.segmentStartedAt = now;
        this.segmentUpdatedAt = now;
        this.lastWindow = this.segment;
      } else {
        this.segmentStartedAt = 0;
        this.segmentUpdatedAt = 0;
        this.lastWindow = "";
      }
    }
  }

  window.YaSubtitleSegmenter = SubtitleSegmenter;
})();
