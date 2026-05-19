(function () {
  "use strict";

  class SubtitleOverlay {
    constructor(settings) {
      this.settings = settings;
      this.node = null;
      this.viewport = null;
      this.track = null;
      this.hideTimer = 0;
      this.removeTimer = 0;
      this.lines = [];
      this.pendingRows = [];
      this.lastRenderedText = "";
      this.lastMessageKey = "";
      this.lastMessageAt = 0;
      this.animating = false;
      this.rowTimer = 0;
      this.lastRowStartedAt = 0;
      this.host = null;
      this.boundRefreshHost = () => this.refreshHost();
    }

    updateSettings(settings) {
      this.settings = { ...this.settings, ...settings };
      this.applyStyle();
    }

    getHost() {
      return document.fullscreenElement || document.documentElement || document.body;
    }

    ensure() {
      const host = this.getHost();
      if (!host) {
        return;
      }
      if (this.node) {
        this.refreshHost();
        return;
      }
      this.node = document.createElement("div");
      this.node.id = "ya-translator-overlay";
      this.node.setAttribute("aria-live", "polite");

      this.viewport = document.createElement("div");
      this.viewport.className = "ya-translator-overlay-viewport";

      this.track = document.createElement("div");
      this.track.className = "ya-translator-overlay-track";

      this.viewport.appendChild(this.track);
      this.node.appendChild(this.viewport);
      host.appendChild(this.node);
      this.host = host;
      document.addEventListener("fullscreenchange", this.boundRefreshHost);
      this.applyStyle();
    }

    refreshHost() {
      if (!this.node) {
        return;
      }
      const host = this.getHost();
      if (host && this.node.parentNode !== host) {
        host.appendChild(this.node);
        this.host = host;
      }
    }

    applyStyle() {
      if (!this.node) {
        return;
      }
      const opacity = Math.max(0, Math.min(1, Number(this.settings.backgroundOpacity)));
      this.node.style.setProperty("--ya-translator-font-size", `${this.settings.fontSize}px`);
      this.node.style.setProperty("--ya-translator-bottom", `${this.settings.bottomOffset}vh`);
      this.node.style.setProperty("--ya-translator-max-width", `${this.settings.maxWidth}vw`);
      this.node.style.setProperty("--ya-translator-bg", `rgba(0, 0, 0, ${opacity})`);
    }

    show({ translated, original }) {
      if (!this.settings.overlayEnabled) {
        this.hideNow();
        return;
      }
      this.ensure();
      this.refreshHost();
      window.clearTimeout(this.hideTimer);
      window.clearTimeout(this.removeTimer);

      const parts = [];
      if (this.settings.showTranslated && translated) {
        parts.push(translated);
      }
      if (this.settings.showOriginal && original) {
        parts.push(original);
      }

      const cleanedText = this.cleanDisplayText(parts.join(" "));
      if (cleanedText && cleanedText !== this.lastRenderedText) {
        this.pushMessage(cleanedText);
        this.lastRenderedText = cleanedText;
      }
      this.node.classList.toggle("is-visible", Boolean(cleanedText));
    }

    cleanDisplayText(text) {
      return String(text || "")
        .replace(/(\.{3}|…|вЂ¦)+/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    splitDisplayLines(text) {
      const value = this.cleanDisplayText(text);
      const maxWidth = Math.max(260, this.getTextWidthLimit());
      if (this.measureText(value) <= maxWidth) {
        return [value];
      }

      const words = value.split(/\s+/);
      const lines = [];
      let current = "";
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (this.measureText(next) > maxWidth && current) {
          lines.push(current);
          current = word;
          continue;
        }
        current = next;
      }
      if (current) {
        lines.push(current);
      }
      return lines;
    }

    getTextWidthLimit() {
      const nodeWidth = this.node ? this.node.clientWidth : 920;
      return Math.max(260, nodeWidth - 56);
    }

    measureText(text) {
      if (!this.measureCanvas) {
        this.measureCanvas = document.createElement("canvas");
      }
      const context = this.measureCanvas.getContext("2d");
      const fontSize = Math.max(18, Number(this.settings.fontSize) || 32);
      context.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
      return context.measureText(String(text || "")).width;
    }

    fitWords(words, maxWidth) {
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (this.measureText(next) > maxWidth && line) {
          break;
        }
        line = next;
      }
      return line;
    }

    getRowDisplayMs() {
      const current = this.lines[this.lines.length - 1] || "";
      const queued = this.pendingRows[0] || "";
      const text = current.length >= queued.length ? current : queued;
      const base = 1500;
      const byLength = Math.min(2600, base + text.length * 18);
      return this.pendingRows.length > 3 ? Math.max(1750, byLength) : byLength;
    }

    pushMessage(text) {
      const messageLines = this.splitDisplayLines(text);
      const messageKey = messageLines.join("\n");
      const now = Date.now();
      if (messageKey === this.lastMessageKey && now - this.lastMessageAt < 45000) {
        return;
      }
      this.lastMessageKey = messageKey;
      this.lastMessageAt = now;
      const lastKey = this.lines.slice(-2).join("\n");
      if (lastKey === messageKey) {
        return;
      }
      if (lastKey && this.areNearDuplicates(lastKey, messageKey)) {
        this.lines = messageKey.length > lastKey.length ? messageLines : this.lines.slice(-2);
        this.renderStatic();
        return;
      }

      const pendingKey = this.pendingRows.join("\n");
      if (pendingKey && this.areNearDuplicates(pendingKey, messageKey)) {
        this.pendingRows = messageLines;
        this.processRowQueue();
        return;
      }

      if (this.pendingRows.length > 0 && this.lines.length > 0) {
        const combinedKey = [...this.lines.slice(-1), ...this.pendingRows].join("\n");
        if (this.areNearDuplicates(combinedKey, messageKey)) {
          this.pendingRows = messageLines;
          this.processRowQueue();
          return;
        }
      }

      this.pendingRows.push(...messageLines);
      if (this.pendingRows.length > 4) {
        this.pendingRows = this.pendingRows.slice(-4);
      }
      this.processRowQueue();
    }

    processRowQueue() {
      if (this.animating) {
        return;
      }
      window.clearTimeout(this.rowTimer);
      const elapsed = Date.now() - this.lastRowStartedAt;
      const minDisplayMs = this.getRowDisplayMs();
      if (this.lastRowStartedAt && elapsed < minDisplayMs) {
        this.rowTimer = window.setTimeout(() => this.processRowQueue(), minDisplayMs - elapsed);
        return;
      }
      const next = this.pendingRows.shift();
      if (!next) {
        return;
      }
      this.pushLine(next);
    }

    pushLine(text) {
      if (this.lines[this.lines.length - 1] === text) {
        this.processRowQueue();
        return;
      }
      if (this.lines.length > 0 && this.areNearDuplicates(this.lines[this.lines.length - 1], text)) {
        this.lines[this.lines.length - 1] = text.length > this.lines[this.lines.length - 1].length ? text : this.lines[this.lines.length - 1];
        this.renderStatic();
        this.processRowQueue();
        return;
      }

      this.lines.push(text);
      this.lastRowStartedAt = Date.now();
      this.renderAnimated();
    }

    areNearDuplicates(a, b) {
      const left = String(a || "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
      const right = String(b || "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
      if (!left.length || !right.length) {
        return false;
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
      return best > 0.76;
    }

    createRow(text) {
      const row = document.createElement("div");
      row.className = "ya-translator-overlay-row";
      row.textContent = text;
      return row;
    }

    renderStatic() {
      const visible = this.lines.slice(-2);
      this.track.innerHTML = "";
      if (visible.length === 1) {
        this.track.appendChild(this.createRow(""));
      }
      for (const line of visible) {
        this.track.appendChild(this.createRow(line));
      }
      this.track.classList.remove("is-sliding");
      this.track.style.transform = "translateY(0)";
    }

    renderAnimated() {
      if (this.animating) {
        this.renderStatic();
        this.lines = this.lines.slice(-2);
        return;
      }

      const visible = this.lines.slice(-3);
      if (visible.length < 3) {
        this.renderStatic();
        window.setTimeout(() => this.processRowQueue(), 0);
        return;
      }

      this.animating = true;
      this.track.innerHTML = "";
      for (const line of visible) {
        this.track.appendChild(this.createRow(line));
      }
      this.track.classList.remove("is-sliding");
      this.track.style.transform = "translateY(0)";

      window.requestAnimationFrame(() => {
        this.track.classList.add("is-sliding");
        this.track.style.transform = "translateY(calc(var(--ya-translator-row-height) * -1))";
      });

      window.setTimeout(() => {
        this.lines = this.lines.slice(-2);
        this.animating = false;
        this.renderStatic();
        this.processRowQueue();
      }, 230);
    }

    scheduleHide(delayMs) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.hideNow(), delayMs);
    }

    hideNow() {
      if (this.node) {
        this.node.classList.remove("is-visible");
      }
    }
  }

  window.YaTranslatorOverlay = SubtitleOverlay;
})();
