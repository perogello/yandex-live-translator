(function () {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    backendUrl: "http://127.0.0.1:8765",
    ollamaModel: "translategemma:12b",
    contextProfile: "tech_keynote",
    promptStyle: "красивый",
    contextResetGapMs: 15000,
    cdpReaderUrl: "http://127.0.0.1:8766",
    enableCdpFallback: true,
    enabled: true,
    debug: false,
    mockMode: false,
    overlayEnabled: true,
    showOriginal: false,
    showTranslated: true,
    fontSize: 32,
    bottomOffset: 9,
    maxWidth: 82,
    backgroundOpacity: 0.72,
    debounceMs: 900,
    fastPunctuationDebounceMs: 450,
    qualityStableMs: 1200,
    qualityMaxWaitMs: 5600,
    minChars: 10,
    holdLastSubtitleMs: 2500,
    hideAfterSilenceMs: 6000,
    reconnectIntervalMs: 500,
    requestTimeoutMs: 20000,
    maxInputChars: 1200
  });

  function getStorage() {
    return chrome && chrome.storage && chrome.storage.sync ? chrome.storage.sync : null;
  }

  window.YaTranslatorSettings = {
    defaults: DEFAULT_SETTINGS,
    async load() {
      const storage = getStorage();
      if (!storage) {
        return { ...DEFAULT_SETTINGS };
      }
      return new Promise((resolve) => {
        storage.get(DEFAULT_SETTINGS, (items) => resolve({ ...DEFAULT_SETTINGS, ...items }));
      });
    },
    async save(patch) {
      const storage = getStorage();
      if (!storage) {
        return;
      }
      return new Promise((resolve) => storage.set(patch, resolve));
    },
    onChanged(callback) {
      if (!chrome || !chrome.storage || !chrome.storage.onChanged) {
        return;
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") {
          return;
        }
        const patch = {};
        for (const [key, value] of Object.entries(changes)) {
          patch[key] = value.newValue;
        }
        callback(patch);
      });
    }
  };
})();
