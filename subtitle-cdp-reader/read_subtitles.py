from __future__ import annotations

import argparse
import asyncio
import json
import itertools
import os
import sys
from dataclasses import dataclass

import httpx
import websockets


CDP_URL = os.environ.get("YA_CDP_URL", "http://127.0.0.1:9222")


@dataclass
class CdpTab:
    title: str
    url: str
    websocket_url: str


class CdpClient:
    def __init__(self, websocket_url: str):
        self.websocket_url = websocket_url
        self._ids = itertools.count(1)
        self._ws = None

    async def __aenter__(self):
        self._ws = await websockets.connect(self.websocket_url, max_size=None)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self._ws:
            await self._ws.close()

    async def call(self, method: str, params: dict | None = None) -> dict:
        message_id = next(self._ids)
        await self._ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            raw = await self._ws.recv()
            data = json.loads(raw)
            if data.get("id") == message_id:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error']}")
                return data.get("result", {})


JS_READ_SUBTITLES = r"""
(() => {
  const out = {
    href: location.href,
    hookReady: document.documentElement && document.documentElement.getAttribute('data-ya-translator-hook-ready'),
    widgets: [],
    text: '',
    lines: []
  };

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim();
  }

  function readToken(token) {
    const root = token.shadowRoot;
    if (!root) return normalize(token.textContent);
    const span = root.querySelector('span');
    return normalize(span ? span.textContent : root.textContent);
  }

  function readSubtitles(subtitles) {
    if (!subtitles || !subtitles.shadowRoot) return [];
    const container = subtitles.shadowRoot.querySelector('#lines-container') || subtitles.shadowRoot;
    const lines = [...container.querySelectorAll('ya-asr-subtitles-line')].map((line) => {
      const root = line.shadowRoot || line;
      const tokens = [...root.querySelectorAll('ya-asr-subtitles-token[translatable], ya-asr-subtitles-token')];
      return normalize(tokens.map(readToken).filter(Boolean).join(' ') || root.textContent);
    }).filter(Boolean);
    return lines;
  }

  for (const widget of document.querySelectorAll('ya-asr-subtitles-widget')) {
    const info = {
      tag: widget.tagName,
      hasShadowRoot: Boolean(widget.shadowRoot),
      attrs: [...widget.attributes].map((a) => `${a.name}=${a.value}`),
      textContent: normalize(widget.textContent)
    };
    if (widget.shadowRoot) {
      const subtitles = widget.shadowRoot.querySelector('ya-asr-subtitles');
      info.hasSubtitles = Boolean(subtitles);
      info.subtitleLines = readSubtitles(subtitles);
      info.subtitleText = normalize(info.subtitleLines.join('\n'));
      if (info.subtitleText) {
        out.lines = info.subtitleLines;
        out.text = info.subtitleText;
      }
    }
    out.widgets.push(info);
  }
  return out;
})()
"""


async def list_tabs(base_url: str) -> list[CdpTab]:
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(f"{base_url.rstrip('/')}/json")
        response.raise_for_status()
        tabs = []
        for item in response.json():
            ws = item.get("webSocketDebuggerUrl")
            if item.get("type") == "page" and ws:
                tabs.append(CdpTab(item.get("title", ""), item.get("url", ""), ws))
        return tabs


async def inspect_tab(tab: CdpTab) -> dict:
    async with CdpClient(tab.websocket_url) as cdp:
        await cdp.call("Runtime.enable")
        js_result = await cdp.call(
            "Runtime.evaluate",
            {
                "expression": JS_READ_SUBTITLES,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        data = js_result.get("result", {}).get("value", {})
        if data.get("text") or data.get("lines"):
            data["cdpPierce"] = {"skipped": True, "reason": "runtime-evaluate-found-text"}
            return data
        dom_data = await inspect_dom_pierce(cdp)
        data["cdpPierce"] = dom_data
        if not data.get("text") and dom_data.get("text"):
            data["text"] = dom_data["text"]
        if not data.get("lines") and dom_data.get("lines"):
            data["lines"] = dom_data["lines"]
        if not data.get("lines") and dom_data.get("textParts"):
            data["lines"] = dom_data["textParts"]
        return data


async def inspect_dom_pierce(cdp: CdpClient) -> dict:
    document = await cdp.call("DOM.getDocument", {"depth": -1, "pierce": True})
    root = document.get("root", {})
    matches: list[dict] = []
    text_parts: list[str] = []
    line_parts: dict[str, list[str]] = {}
    line_order: list[str] = []

    def walk(node: dict, ancestors: list[str], line_key: str | None = None) -> None:
        name = node.get("nodeName", "")
        value = node.get("nodeValue", "")
        current = ancestors + ([name] if name else [])
        current_line_key = line_key
        if name == "YA-ASR-SUBTITLES-LINE":
            current_line_key = str(node.get("backendNodeId") or node.get("nodeId") or len(line_order))
            if current_line_key not in line_parts:
                line_parts[current_line_key] = []
                line_order.append(current_line_key)
        if name.startswith("YA-") and "SUBTITLE" in name:
            matches.append(
                {
                    "nodeName": name,
                    "nodeId": node.get("nodeId"),
                    "path": " > ".join(current[-8:]),
                }
            )
        if "#text" in name and any("SUBTITLE" in item for item in ancestors):
            clean = " ".join(value.split())
            if clean:
                if current_line_key:
                    line_parts.setdefault(current_line_key, []).append(clean)
                text_parts.append(clean)
        for key in ("children", "shadowRoots", "templateContent", "contentDocument"):
            child_value = node.get(key)
            if isinstance(child_value, list):
                for child in child_value:
                    walk(child, current, current_line_key)
            elif isinstance(child_value, dict):
                walk(child_value, current, current_line_key)

    walk(root, [])
    lines = [" ".join(line_parts[key]).strip() for key in line_order]
    lines = [line for line in lines if line]
    return {
        "matches": matches[:50],
        "text": "\n".join(lines).strip() or " ".join(text_parts).strip(),
        "lines": lines[:10],
        "textParts": text_parts[:50],
    }


async def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=CDP_URL)
    parser.add_argument("--url-contains", default="youtube")
    args = parser.parse_args()

    tabs = await list_tabs(args.base_url)
    if not tabs:
        print("No CDP tabs found")
        return 2

    for index, tab in enumerate(tabs):
        print(f"[{index}] {tab.title} | {tab.url}")

    candidates = [tab for tab in tabs if args.url_contains.lower() in tab.url.lower()]
    if not candidates:
        candidates = tabs

    for tab in candidates:
        print(f"\nInspecting: {tab.title} | {tab.url}")
        data = await inspect_tab(tab)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        if data.get("text"):
            return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
