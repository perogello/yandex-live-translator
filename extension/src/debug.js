(function () {
  "use strict";

  class DebugPanel {
    constructor() {
      this.enabled = false;
      this.state = {};
      this.node = null;
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (!this.enabled) {
        this.remove();
        return;
      }
      this.ensure();
      this.render();
    }

    update(patch) {
      this.state = { ...this.state, ...patch };
      if (this.enabled) {
        this.ensure();
        this.render();
      }
    }

    ensure() {
      if (this.node || !document.documentElement) {
        return;
      }
      this.node = document.createElement("div");
      this.node.id = "ya-translator-debug";
      document.documentElement.appendChild(this.node);
    }

    remove() {
      if (this.node) {
        this.node.remove();
        this.node = null;
      }
    }

    render() {
      if (!this.node) {
        return;
      }
      const rows = [
        ["state", this.state.state],
        ["hook", this.state.hook],
        ["widget", this.state.widget],
        ["shadow", this.state.shadow],
        ["cdp", this.state.cdp],
        ["selected model", this.state.selectedModel],
        ["requested model", this.state.requestedModel],
        ["backend", this.state.backend],
        ["response model", this.state.model],
        ["latency", this.state.latencyMs ? `${this.state.latencyMs} ms` : ""],
        ["EN", this.state.en],
        ["RU", this.state.ru],
        ["error", this.state.error]
      ];
      this.node.textContent = rows
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    }
  }

  window.YaTranslatorDebugPanel = DebugPanel;
})();
