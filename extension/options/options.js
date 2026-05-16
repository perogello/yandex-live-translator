(async function () {
  "use strict";

  const fields = [
    "backendUrl",
    "ollamaModel",
    "contextProfile",
    "promptStyle",
    "contextResetGapMs",
    "cdpReaderUrl",
    "enableCdpFallback",
    "enabled",
    "overlayEnabled",
    "debug",
    "mockMode",
    "showTranslated",
    "showOriginal",
    "fontSize",
    "bottomOffset",
    "maxWidth",
    "backgroundOpacity",
    "debounceMs",
    "holdLastSubtitleMs",
    "hideAfterSilenceMs"
  ];

  const settings = await window.YaTranslatorSettings.load();

  for (const key of fields) {
    const node = document.getElementById(key);
    if (!node) {
      continue;
    }
    if (node.type === "checkbox") {
      node.checked = Boolean(settings[key]);
    } else {
      node.value = settings[key];
    }
  }

  const resetBtn = document.getElementById("resetContextBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const status = document.getElementById("status");
      try {
        const current = await window.YaTranslatorSettings.load();
        const url = (current.backendUrl || "http://127.0.0.1:8765").replace(/\/$/, "");
        const response = await fetch(`${url}/context/reset`, { method: "POST" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        await window.YaTranslatorSettings.save({ __memoryResetAt: Date.now() });
        status.textContent = "Память переводчика сброшена";
      } catch (error) {
        status.textContent = `Ошибка: ${error && error.message ? error.message : "не удалось"}`;
      }
      window.setTimeout(() => { status.textContent = ""; }, 3000);
    });
  }

  document.getElementById("save").addEventListener("click", async () => {
    const patch = {};
    for (const key of fields) {
      const node = document.getElementById(key);
      patch[key] = node.type === "checkbox" ? node.checked : node.value;
      if (node.type === "number") {
        patch[key] = Number(patch[key]);
      }
    }
    await window.YaTranslatorSettings.save(patch);
    const status = document.getElementById("status");
    status.textContent = "Saved";
    window.setTimeout(() => {
      status.textContent = "";
    }, 1600);
  });
})();
