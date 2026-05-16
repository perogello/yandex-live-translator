(function () {
  "use strict";

  const WIDGET_SELECTOR = "ya-asr-subtitles-widget";
  const SUBTITLES_SELECTOR = "ya-asr-subtitles";
  const LINE_SELECTOR = "ya-asr-subtitles-line";
  const TOKEN_SELECTOR = "ya-asr-subtitles-token[translatable], ya-asr-subtitles-token";

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function queryDeep(root, selector, maxDepth = 8) {
    if (!root || maxDepth < 0) {
      return null;
    }
    if (root.querySelector) {
      const found = root.querySelector(selector);
      if (found) {
        return found;
      }
      const all = root.querySelectorAll("*");
      for (const element of all) {
        if (element.shadowRoot) {
          const nested = queryDeep(element.shadowRoot, selector, maxDepth - 1);
          if (nested) {
            return nested;
          }
        }
      }
    }
    return null;
  }

  function readToken(token) {
    const root = token.shadowRoot;
    if (!root) {
      return normalizeText(token.textContent);
    }
    const span = root.querySelector("span");
    return normalizeText(span ? span.textContent : root.textContent);
  }

  function readLine(line) {
    const root = line.shadowRoot;
    if (!root) {
      return normalizeText(line.textContent);
    }
    const tokens = Array.from(root.querySelectorAll(TOKEN_SELECTOR));
    if (tokens.length === 0) {
      return normalizeText(root.textContent);
    }
    return normalizeText(tokens.map(readToken).filter(Boolean).join(" "));
  }

  class SubtitleReader {
    constructor() {
      this.lastStatus = {};
    }

    findWidget() {
      return document.querySelector(WIDGET_SELECTOR);
    }

    findSubtitles(widget) {
      if (!widget) {
        return null;
      }
      const root = widget.shadowRoot || widget.__yaTranslatorOpenShadowRoot || null;
      if (!root) {
        this.lastStatus = { widget: "found", shadow: "closed or unavailable" };
        return null;
      }
      const subtitles = root.querySelector(SUBTITLES_SELECTOR) || queryDeep(root, SUBTITLES_SELECTOR, 3);
      this.lastStatus = {
        widget: "found",
        shadow: "open",
        subtitles: subtitles ? "found" : "missing"
      };
      return subtitles;
    }

    read() {
      const widget = this.findWidget();
      if (!widget) {
        this.lastStatus = { widget: "missing", shadow: "" };
        return { text: "", status: this.lastStatus };
      }

      const subtitles = this.findSubtitles(widget);
      if (!subtitles || !subtitles.shadowRoot) {
        return { text: "", status: this.lastStatus };
      }

      const container = subtitles.shadowRoot.querySelector("#lines-container") || subtitles.shadowRoot;
      const lines = Array.from(container.querySelectorAll(LINE_SELECTOR)).map(readLine).filter(Boolean);
      const text = normalizeText(lines.join("\n"));
      return { text, status: this.lastStatus };
    }
  }

  window.YaSubtitleReader = SubtitleReader;
  window.YaSubtitleNormalizeText = normalizeText;
})();
