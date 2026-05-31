(function () {
  "use strict";

  class TranslatorClient {
    constructor(settings) {
      this.settings = settings;
    }

    updateSettings(settings) {
      this.settings = { ...this.settings, ...settings };
    }

    async translate(text, telemetry = {}) {
      const abortController = new AbortController();
      const requestTimeoutMs = Math.max(Number(this.settings.requestTimeoutMs) || 0, 8000);
      const timeout = window.setTimeout(() => abortController.abort(), requestTimeoutMs);
      const requestStartedAt = Date.now();

      try {
        const response = await fetch(`${this.settings.backendUrl.replace(/\/$/, "")}/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
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
          }),
          signal: abortController.signal
        });
        if (!response.ok) {
          throw new Error(`backend HTTP ${response.status}`);
        }
        const data = await response.json();
        return { ...data, stale: false };
      } finally {
        window.clearTimeout(timeout);
      }
    }

    async publishSubtitle({ original, translation, backend, model, latency_ms, telemetry }) {
      try {
        await fetch(`${this.settings.backendUrl.replace(/\/$/, "")}/subtitle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            original: original || "",
            translation: translation || "",
            backend: backend || "",
            model: model || "",
            latency_ms: Number(latency_ms) || 0,
            client_first_seen_ms: Number(telemetry && telemetry.firstSeenAt) || 0,
            client_committed_ms: Number(telemetry && telemetry.committedAt) || 0,
            client_enqueued_ms: Number(telemetry && telemetry.enqueuedAt) || 0,
            client_overlay_shown_ms: Date.now()
          })
        });
      } catch (_) {
        // External overlay publishing is optional; translation overlay should keep working.
      }
    }

    async publishActivity({ original, pending_for_sec }) {
      try {
        await fetch(`${this.settings.backendUrl.replace(/\/$/, "")}/activity`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            original: original || "",
            pending_for_sec: Number(pending_for_sec) || 8
          })
        });
      } catch (_) {
        // Activity heartbeat is best-effort; translation must not depend on it.
      }
    }

    async captureRawRead(text, source) {
      // Diagnostics only (debug flag): record a raw caption read so we can
      // rebuild real rolling-window sequences for segmenter work.
      try {
        await fetch(`${this.settings.backendUrl.replace(/\/$/, "")}/debug/raw-read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text || "", source: source || "", ts: Date.now() })
        });
      } catch (_) {
        // Best-effort; never affects translation.
      }
    }

    async resetContext() {
      try {
        await fetch(`${this.settings.backendUrl.replace(/\/$/, "")}/context/reset`, {
          method: "POST"
        });
      } catch (_) {
        // Context reset is best-effort; translation must keep working.
      }
    }
  }

  window.YaTranslatorClient = TranslatorClient;
})();
