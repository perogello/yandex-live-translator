// A/B: replay a log's raw_read corpus through the YouTubeStitcher and compare
// against the log's ACTUAL committed translations (raw_en), which already went
// through the live pipeline (segmenter + cleanup). Measures seam overlap,
// mid-sentence continuations, and content coverage (no lost text).
//
// Usage: node scripts/ab_youtube_stitcher.js <log.jsonl>

const fs = require("fs");
const vm = require("vm");

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: node scripts/ab_youtube_stitcher.js <log.jsonl>");
  process.exit(1);
}

// Sandbox with normalizer + segment-utils + stitcher.
const ctx = {
  console,
  module: { exports: {} },
  window: { YaSubtitleNormalizeText: (t) => String(t || "").replace(/\s+/g, " ").trim() },
};
ctx.module = { exports: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("extension/src/segment-utils.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync("extension/src/youtube-stitcher.js", "utf8"), ctx);
const YouTubeStitcher = ctx.window.YouTubeStitcher;

const reads = [];
const liveCommits = [];
for (const line of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.event === "raw_read" && e.text) reads.push([e.text, e.client_read_ms || 0]);
  else if (e.event === "translate") liveCommits.push(e.raw_en || "");
}

// Run stitcher over the corpus.
const seg = new YouTubeStitcher({});
const stitched = [];
let now = reads.length ? reads[0][1] : 0;
for (const [t, ts] of reads) {
  now = ts || now + 300;
  for (const c of seg.push(t, now)) stitched.push(c);
}
for (const c of seg.flush(now + 9000)) stitched.push(c);

const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);
function seam(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; i++) {
    const a = words(arr[i - 1]), b = words(arr[i]);
    let best = 0;
    for (let k = 1; k <= Math.min(a.length, b.length); k++) {
      if (a.slice(-k).join(" ") === b.slice(0, k).join(" ")) best = k;
    }
    if (best >= 4) n++;
  }
  return n;
}
function cont(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; i++) {
    const p = arr[i - 1].trim(), c = arr[i].trim();
    if (p && c && !/[.!?]$/.test(p) && /^[a-z]/.test(c)) n++;
  }
  return n;
}
function internalRepeat(arr) {
  let g = 0;
  for (const s of arr) {
    const w = words(s);
    let f = false;
    for (let size = 5; size >= 3 && !f; size--) {
      const seen = {};
      for (let j = 0; j + size <= w.length; j++) {
        const ph = w.slice(j, j + size).join(" ");
        if (seen[ph] !== undefined && j - seen[ph] >= size) { f = true; break; }
        seen[ph] = j;
      }
    }
    if (f) g++;
  }
  return g;
}
function report(name, arr) {
  console.log(`${name}: ${arr.length} commits`);
  console.log(`   seam>=4w: ${seam(arr)} (${(100 * seam(arr) / arr.length).toFixed(0)}%)`);
  console.log(`   continuations: ${cont(arr)} (${(100 * cont(arr) / arr.length).toFixed(0)}%)`);
  console.log(`   internal-repeat: ${internalRepeat(arr)} (${(100 * internalRepeat(arr) / arr.length).toFixed(1)}%)`);
}

// Content coverage: distinct word bag of each side (proxy for "no content lost").
function bag(arr) {
  const m = new Map();
  for (const s of arr) for (const w of words(s)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}
function coverage(a, b) {
  // fraction of distinct words in `a` that also appear in `b`
  const bb = bag(b);
  let have = 0, total = 0;
  for (const w of bag(a).keys()) { total++; if (bb.has(w)) have++; }
  return total ? have / total : 1;
}

console.log(`corpus: ${reads.length} raw reads\n`);
report("BASELINE (live commits)", liveCommits);
console.log();
report("STITCHER (new)", stitched);
console.log();
console.log(`content coverage baseline->stitcher: ${(100 * coverage(liveCommits, stitched)).toFixed(1)}% (stitcher contains this share of baseline's distinct words)`);
console.log(`content coverage stitcher->baseline: ${(100 * coverage(stitched, liveCommits)).toFixed(1)}%`);
console.log("\n-- stitcher sample 40-52 --");
for (const c of stitched.slice(40, 52)) console.log("  •", c.slice(0, 78));
