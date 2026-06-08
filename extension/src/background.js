// Background service worker. All backend calls go through here instead of
// directly from the content script.
//
// Why: modern Chrome/Edge "Local Network Access" blocks a content script
// running in a public page origin (e.g. https://www.youtube.com) from
// fetching a loopback address (http://127.0.0.1:8765) — the request fails
// with "Permission was denied for this request to access the loopback
// address space". The extension service worker runs in the privileged
// extension context with host_permissions, so it can reach 127.0.0.1.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "yatr-fetch") {
    return false;
  }

  const { url, method, body, timeoutMs } = message;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(timeoutMs) || 20000));

  fetch(url, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: controller.signal,
  })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = null; }
      }
      sendResponse({ ok: res.ok, status: res.status, data });
    })
    .catch((err) => {
      sendResponse({ ok: false, status: 0, error: (err && err.message) ? err.message : String(err) });
    })
    .finally(() => clearTimeout(timeout));

  // Keep the message channel open for the async sendResponse above.
  return true;
});
