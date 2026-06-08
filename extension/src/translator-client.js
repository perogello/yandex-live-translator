(function () {
  "use strict";

  // Send a backend request through the background service worker (see
  // background.js for why: Local Network Access blocks loopback fetches from
  // the page context). Returns parsed JSON on success, throws on failure.
  function bgFetch(url, method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      try {
        chrome.runtime.sendMessage(
          { type: "yatr-fetch", url, method, body, timeoutMs },
          (resp) => {
            if (chrome.runtime.lastError) {
              done(reject, new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!resp) {
              done(reject, new Error("no response from extension worker"));
              return;
            }
            if (!resp.ok) {
              done(reject, new Error(resp.error || `backend HTTP ${resp.status}`));
              return;
            }
            done(resolve, resp.data);
          }
        );
      } catch (error) {
        done(reject, error);
      }
    });
  }

  class TranslatorClient {
    constructor(settings) {
      this.settings = settings;
    }

    updateSettings(settings) {
      this.settings = { ...this.settings, ...settings };
    }

    _url(path) {
      return `${this.settings.backendUrl.replace(/\/$/, "")}${path}`;
    }

    async translate(text, telemetry = {}) {
      const requestTimeoutMs = Math.max(Number(this.settings.requestTimeoutMs) || 0, 8000);
      const requestStartedAt = Date.now();
      const data = await bgFetch(this._url("/translate"), "POST", {
        text,
        source_lang: "en",
        target_lang: "ru",
        model: this.settings.ollamaModel || undefined,
        profile: this.settings.contextProfile || undefined,
        prompt_style: this.settings.promptStyle || undefined,
        client_first_seen_ms: Number(telemetry.firstSeenAt) || 0,
        client_committed_ms: Number(telemetry.committedAt) || 0,
        client_enqueued_ms: Number(telemetry.enqueuedAt) || 0,
        client_request_started_ms: requestStartedAt
      }, requestTimeoutMs);
      return { ...(data || {}), stale: false };
    }

    async publishSubtitle({ original, translation, backend, model, latency_ms, telemetry }) {
      try {
        await bgFetch(this._url("/subtitle"), "POST", {
          original: original || "",
          translation: translation || "",
          backend: backend || "",
          model: model || "",
          latency_ms: Number(latency_ms) || 0,
          client_first_seen_ms: Number(telemetry && telemetry.firstSeenAt) || 0,
          client_committed_ms: Number(telemetry && telemetry.committedAt) || 0,
          client_enqueued_ms: Number(telemetry && telemetry.enqueuedAt) || 0,
          client_overlay_shown_ms: Date.now()
        }, 8000);
      } catch (_) {
        // External overlay publishing is optional; translation overlay should keep working.
      }
    }

    async publishActivity({ original, pending_for_sec }) {
      try {
        await bgFetch(this._url("/activity"), "POST", {
          original: original || "",
          pending_for_sec: Number(pending_for_sec) || 8
        }, 8000);
      } catch (_) {
        // Activity heartbeat is best-effort; translation must not depend on it.
      }
    }

    async captureRawRead(text, source) {
      // Diagnostics only (captureRawReads flag): record a raw caption read.
      try {
        await bgFetch(this._url("/debug/raw-read"), "POST", {
          text: text || "", source: source || "", ts: Date.now()
        }, 8000);
      } catch (_) {
        // Best-effort; never affects translation.
      }
    }

    async resetContext() {
      try {
        await bgFetch(this._url("/context/reset"), "POST", {}, 8000);
      } catch (_) {
        // Context reset is best-effort; translation must keep working.
      }
    }
  }

  window.YaTranslatorClient = TranslatorClient;
})();
