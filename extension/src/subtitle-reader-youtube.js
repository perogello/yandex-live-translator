(function () {
  "use strict";

  // YouTube renders captions as plain DOM (no shadow root), under several
  // possible container classes depending on the player skin / embed mode.
  // .ytp-caption-segment is the per-line span used in the standard web player.
  // .captions-text wraps a group of segments. We try a few selectors so the
  // reader keeps working through minor YouTube UI changes.
  const CONTAINER_SELECTORS = [
    ".ytp-caption-window-container",
    ".caption-window",
    ".ytp-caption-window-bottom",
  ];
  const SEGMENT_SELECTOR = ".ytp-caption-segment, .captions-text span, .caption-visual-line";

  function normalizeText(text) {
    return String(text || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readContainer(container) {
    if (!container) return "";
    const segments = container.querySelectorAll(SEGMENT_SELECTOR);
    if (segments.length === 0) {
      return normalizeText(container.textContent || "");
    }
    const lines = [];
    let line = [];
    for (const span of segments) {
      const txt = normalizeText(span.textContent || "");
      if (!txt) continue;
      // YouTube splits a line into multiple <span class="ytp-caption-segment">
      // children. Each row is usually wrapped by something that contains
      // <br>, but in practice concatenating with spaces and collapsing is
      // good enough — the segmenter on our side handles word boundaries.
      line.push(txt);
    }
    if (line.length) lines.push(line.join(" "));
    return normalizeText(lines.join("\n"));
  }

  class YouTubeSubtitleReader {
    constructor() {
      this.lastStatus = {};
    }

    findContainer() {
      for (const sel of CONTAINER_SELECTORS) {
        const node = document.querySelector(sel);
        if (node) return node;
      }
      return null;
    }

    read() {
      const host = (window.location.hostname || "").toLowerCase();
      const looksLikeYouTube = host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com") || host === "youtu.be";
      const container = this.findContainer();
      if (!container) {
        this.lastStatus = {
          widget: looksLikeYouTube ? "missing (enable CC in player)" : "not-youtube",
          shadow: "n/a",
        };
        return { text: "", status: this.lastStatus };
      }
      const text = readContainer(container);
      this.lastStatus = {
        widget: "found",
        shadow: "n/a",
        subtitles: text ? "found" : "empty",
      };
      return { text, status: this.lastStatus };
    }
  }

  window.YouTubeSubtitleReader = YouTubeSubtitleReader;
  // Reuse the same normalizer the Yandex reader exports, but expose a
  // fallback in case the Yandex reader script is not loaded before us.
  if (!window.YaSubtitleNormalizeText) {
    window.YaSubtitleNormalizeText = normalizeText;
  }
})();
