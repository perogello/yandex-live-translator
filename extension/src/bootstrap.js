(function () {
  "use strict";

  function inject() {
    if (!document.documentElement || document.documentElement.dataset.yaTranslatorBootstrapInjected) {
      return;
    }
    document.documentElement.dataset.yaTranslatorBootstrapInjected = "1";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/injected.js");
    script.async = false;
    script.onload = () => script.remove();
    document.documentElement.appendChild(script);
  }

  inject();
})();
