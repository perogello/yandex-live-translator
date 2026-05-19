(function () {
  "use strict";

  // YouTube CC is plain DOM. Read only caption nodes, never broad player text:
  // player menus can temporarily contain strings such as "English - CC".
  const CONTAINER_SELECTORS = [
    ".ytp-caption-window-container",
    ".caption-window",
    ".ytp-caption-window-bottom",
  ];
  const LINE_SELECTOR = ".caption-visual-line";
  const SEGMENT_SELECTOR = ".ytp-caption-segment, .captions-text > span";
  const NON_SPEECH_CUE_RE = /\[(?:APPLAUSE|MUSIC|LAUGHTER|LAUGHS|CHEERING|SPEAKING [^\]]+|FOREIGN LANGUAGE|INAUDIBLE|SILENCE)\]/gi;
  const SPEAKER_ONLY_RE = /^[A-Z][A-Z .'-]{1,32}:\s*$/;
  const UI_ONLY_RE = /^(?:Auto-translate|Subtitles?|Captions?|CC|Options|Settings|Playback speed|Quality|Русский|Английский|Субтитры|Настройки|Качество)(?:\s*[:：-].*)?$/i;

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripUiNoise(text) {
    return normalizeText(text)
      .replace(/(?:^|\s)(?:Английский|English)\s*(?:[-–—]\s*)?CC\s*(?:\([^)]*\)\s*)?(?:Для\s+настройки\s+нажмите\s+на\s+значок\s*)?/gi, " ")
      .replace(/(?:^|\s)(?:Английский|English)\s*\((?:создано\s+автоматически|auto-generated)\)\s*(?:Для\s+настройки\s+нажмите\s+на\s+значок\s*)?/gi, " ")
      .replace(/\s*(?:Для\s+настройки\s+нажмите\s+на\s+значок|click\s+the\s+settings\s+icon)\s*/gi, " ")
      .replace(NON_SPEECH_CUE_RE, "")
      .trim();
  }

  function wordKey(value) {
    return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  }

  function collapseRepeatedRuns(text) {
    let words = normalizeText(text).split(/\s+/).filter(Boolean);
    let changed = true;
    while (changed) {
      changed = false;
      const maxRun = Math.min(12, Math.floor(words.length / 2));
      for (let size = maxRun; size >= 3 && !changed; size -= 1) {
        for (let index = 0; index + size * 2 <= words.length; index += 1) {
          const left = words.slice(index, index + size).map(wordKey).join(" ");
          const right = words.slice(index + size, index + size * 2).map(wordKey).join(" ");
          if (left && left === right) {
            words.splice(index + size, size);
            changed = true;
            break;
          }
        }
      }
    }
    return words.join(" ");
  }

  function cleanCaptionText(text) {
    const value = collapseRepeatedRuns(stripUiNoise(text));
    if (!value || UI_ONLY_RE.test(value) || SPEAKER_ONLY_RE.test(value)) {
      return "";
    }
    return value;
  }

  function visibleElement(node) {
    if (!node) return false;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
    if (window.getComputedStyle) {
      const style = window.getComputedStyle(node);
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
        return false;
      }
    }
    if (node.getClientRects && node.getClientRects().length === 0) {
      return false;
    }
    return true;
  }

  function readCaptionLine(node) {
    const segments = [...node.querySelectorAll(SEGMENT_SELECTOR)].filter(visibleElement);
    if (segments.length > 0) {
      return cleanCaptionText(segments.map((segment) => cleanCaptionText(segment.textContent || "")).filter(Boolean).join(" "));
    }
    return cleanCaptionText(node.textContent || "");
  }

  function readContainer(container) {
    if (!container) return "";

    const lineNodes = [...container.querySelectorAll(LINE_SELECTOR)].filter(visibleElement);
    if (lineNodes.length > 0) {
      return normalizeText(lineNodes.map(readCaptionLine).filter(Boolean).join("\n"));
    }

    const segments = [...container.querySelectorAll(SEGMENT_SELECTOR)].filter(visibleElement);
    if (segments.length > 0) {
      return cleanCaptionText(segments.map((segment) => cleanCaptionText(segment.textContent || "")).filter(Boolean).join(" "));
    }

    return "";
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
  if (!window.YaSubtitleNormalizeText) {
    window.YaSubtitleNormalizeText = normalizeText;
  }
})();
