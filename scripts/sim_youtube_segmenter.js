// Replay a YouTube log's raw caption windows through the real SubtitleSegmenter
// to preview what routing YouTube through the segmenter would emit.
//
// The log's raw_en values are the naive-path outputs = the rolling caption
// windows at commit time. We feed them (with real timestamps) into the
// segmenter and print the commits it would produce instead.
//
// Usage: node scripts/sim_youtube_segmenter.js <log.jsonl>

const fs = require("fs");
const vm = require("vm");

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: node scripts/sim_youtube_segmenter.js <log.jsonl>");
  process.exit(1);
}

// Load the segmenter in a sandbox with a faithful normalizer.
const code = fs.readFileSync("extension/src/segmenter.js", "utf8");
const context = {
  console,
  window: {
    YaSubtitleNormalizeText: (t) =>
      String(t || "")
        .replace(/ /g, " ")
        .replace(/\s+/g, " ")
        .trim(),
  },
};
vm.createContext(context);
vm.runInContext(code, context);
const Segmenter = context.window.YaSubtitleSegmenter;

// Extract (raw_en, ts) windows from the log.
const windows = [];
for (const line of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.event !== "translate") continue;
  const en = (e.raw_en || e.text || "").trim();
  const ts = e.client_first_seen_ms || Date.parse(e.ts) || 0;
  if (en) windows.push([en, ts]);
}

const seg = new Segmenter({ qualityMaxWaitMs: 5600, qualityStableMs: 1200, maxInputChars: 1200 });
const commits = [];
let now = windows.length ? windows[0][1] : 0;
for (const [en, ts] of windows) {
  now = ts || now + 600;
  for (const c of seg.push(en, now)) commits.push(c);
}
for (const c of seg.flush(now + 9000)) commits.push(c);

// Metrics helpers
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);
function overlapCount(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; i++) {
    const a = words(arr[i - 1]), b = words(arr[i]);
    let best = 0;
    for (let k = 1; k <= Math.min(a.length, b.length); k++) {
      if (a.slice(-k).join(" ") === b.slice(0, k).join(" ")) best = k;
    }
    if (best >= 2) n++;
  }
  return n;
}
function contCount(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; i++) {
    const p = arr[i - 1].trim(), c = arr[i].trim();
    if (p && c && !/[.!?]$/.test(p) && /^[a-z]/.test(c)) n++;
  }
  return n;
}

const before = windows.map((w) => w[0]);
console.log(`BEFORE (naive path):  ${before.length} chunks`);
console.log(`  overlapping prev (>=2 words): ${overlapCount(before)} (${(100*overlapCount(before)/before.length).toFixed(0)}%)`);
console.log(`  mid-sentence continuations:   ${contCount(before)} (${(100*contCount(before)/before.length).toFixed(0)}%)`);
console.log();
console.log(`AFTER (segmenter):    ${commits.length} chunks`);
console.log(`  overlapping prev (>=2 words): ${overlapCount(commits)} (${(100*overlapCount(commits)/commits.length).toFixed(0)}%)`);
console.log(`  mid-sentence continuations:   ${contCount(commits)} (${(100*contCount(commits)/commits.length).toFixed(0)}%)`);
console.log();
console.log("=== sample AFTER commits (around the Liquid Glass area) ===");
const hit = commits.findIndex((c) => /liquid/i.test(c));
const start = Math.max(0, hit - 2);
for (const c of commits.slice(start, start + 12)) console.log("  •", c);
