const fs = require("fs");
const vm = require("vm");

class FakeElement {
  constructor(classes = [], text = "", children = []) {
    this.classes = new Set(classes);
    this._text = text;
    this.children = children;
    this.attributes = {};
    for (const child of this.children) {
      child.parentNode = this;
    }
  }

  get textContent() {
    return [this._text, ...this.children.map((child) => child.textContent)].join("");
  }

  getAttribute(name) {
    return this.attributes[name] || "";
  }

  getClientRects() {
    return [{}];
  }

  matches(selector) {
    selector = selector.trim();
    if (selector === ".captions-text > span") {
      return this.parentNode && this.parentNode.classes.has("captions-text") && this.classes.has("span");
    }
    if (selector.startsWith(".")) {
      return this.classes.has(selector.slice(1));
    }
    return selector === "span" && this.classes.has("span");
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim());
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (parts.some((part) => child.matches(part))) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

function segment(text) {
  return new FakeElement(["ytp-caption-segment"], text);
}

function line(...children) {
  return new FakeElement(["caption-visual-line"], "", children);
}

function makeReader(root) {
  const code = fs.readFileSync("extension/src/subtitle-reader-youtube.js", "utf8");
  const fakeWindow = {
    location: { hostname: "www.youtube.com" },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const fakeDocument = {
    querySelector: (selector) => root.matches(selector) ? root : root.querySelector(selector),
  };
  vm.runInNewContext(code, { window: fakeWindow, document: fakeDocument, console });
  return new fakeWindow.YouTubeSubtitleReader();
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${name}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`OK ${name}`);
}

{
  const menu = new FakeElement(["captions-text"], "", [
    new FakeElement(["span"], "Английский - CC (English) Для настройки нажмите на значок"),
  ]);
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    menu,
    line(segment("while model prices are coming down significantly.")),
  ]);
  assertEqual("ignore youtube settings ui", makeReader(root).read().text, "while model prices are coming down significantly.");
}

{
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    line(segment("Computer use is part of a broader set of Computer use is part of a broader set of tools")),
  ]);
  assertEqual("collapse adjacent repeated caption run", makeReader(root).read().text, "Computer use is part of a broader set of tools");
}

{
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    line(segment("[APPLAUSE]")),
    line(segment("CAMILLA: [SPEAKING SPANISH]")),
  ]);
  assertEqual("skip non speech cues", makeReader(root).read().text, "");
}

{
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    line(segment("English (auto-generated) Для настройки нажмите на значок We have shifted the frontier itself.")),
  ]);
  assertEqual("strip mixed ui prefix", makeReader(root).read().text, "We have shifted the frontier itself.");
}

{
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    line(segment("Stepping back, we think of agents as systems Английский (создано автоматически) Для настройки нажмите на значок")),
  ]);
  assertEqual("strip mixed ui suffix", makeReader(root).read().text, "Stepping back, we think of agents as systems");
}

{
  const root = new FakeElement(["ytp-caption-window-container"], "", [
    line(segment("English text can be translated safely.")),
  ]);
  assertEqual("preserve real sentence starting with English", makeReader(root).read().text, "English text can be translated safely.");
}
