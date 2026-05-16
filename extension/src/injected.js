(function () {
  "use strict";

  if (window.__yaTranslatorAttachShadowHooked) {
    return;
  }
  window.__yaTranslatorAttachShadowHooked = true;
  if (document.documentElement) {
    document.documentElement.setAttribute("data-ya-translator-hook-ready", "1");
  }

  const originalAttachShadow = Element.prototype.attachShadow;

  function notify(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function shouldForceOpen(tagName) {
    return (
      tagName === "YA-ASR-SUBTITLES-WIDGET" ||
      (tagName.startsWith("YA-") && tagName.includes("SUBTITLE"))
    );
  }

  Element.prototype.attachShadow = function patchedAttachShadow(init) {
    const tagName = this && this.tagName ? this.tagName.toUpperCase() : "";
    const options = init && typeof init === "object" ? init : { mode: "open" };

    if (!shouldForceOpen(tagName)) {
      return originalAttachShadow.call(this, init);
    }

    try {
      const root = originalAttachShadow.call(this, { ...options, mode: "open" });
      Object.defineProperty(this, "__yaTranslatorOpenShadowRoot", {
        value: root,
        configurable: true
      });
      this.setAttribute("data-ya-translator-shadow", "open");
      notify("ya-translator-shadow-ready", { tagName });
      return root;
    } catch (error) {
      notify("ya-translator-shadow-error", {
        tagName,
        message: error && error.message ? error.message : String(error)
      });
      throw error;
    }
  };

  notify("ya-translator-hook-ready", { targetTags: ["YA-ASR-SUBTITLES-WIDGET", "YA-*SUBTITLE*"] });
})();
