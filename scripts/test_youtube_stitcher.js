// Unit tests for the YouTube CC stitcher: it must reconstruct one continuous
// transcript from the rolling-scroll window and commit WHOLE sentences with
// no seam/overlap and no lost content.

const fs = require("fs");
const vm = require("vm");

const ctx = {
  console,
  module: { exports: {} },
  window: { YaSubtitleNormalizeText: (t) => String(t || "").replace(/\s+/g, " ").trim() },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("extension/src/segment-utils.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync("extension/src/youtube-stitcher.js", "utf8"), ctx);
const YouTubeStitcher = ctx.window.YouTubeStitcher;

let failed = 0;
function run(seq) {
  const s = new YouTubeStitcher({});
  const out = [];
  let t = 0;
  for (const r of seq) { t += 600; out.push(...s.push(r, t)); }
  out.push(...s.flush(t + 9000));
  return out;
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`); failed += 1; }
  else console.log(`OK ${name}`);
}

// Growth: words appended at the end, commit on each sentence end.
eq("commit whole sentences on growth",
  run(["We shipped", "We shipped the model.", "the model. It works great.", "It works great."]),
  ["We shipped the model.", "It works great."]);

// Front-scroll + a sentence whose tail re-appears in later windows (the real
// "June 27th" reorder case) must produce ONE clean sentence, no seam.
eq("reconstruct across front-scroll, no seam",
  run([
    "This incredible Apple original film",
    "This incredible Apple original film premieres in theaters",
    "incredible Apple original film premieres in theaters on June 27th,",
    "premieres in theaters on June 27th, and we can't wait for you to see it.",
    "and we can't wait for you to see it. F1 is thrilling.",
    "F1 is thrilling."
  ]),
  [
    "This incredible Apple original film premieres in theaters on June 27th, and we can't wait for you to see it.",
    "F1 is thrilling."
  ]);

// Multi-word terms stay intact across the window boundary.
eq("keep multi-word term intact",
  run(["Liquid Glass is a", "Liquid Glass is a new material.", "a new material. It refracts light."]),
  ["Liquid Glass is a new material.", "It refracts light."]);

// A duplicate read (no new info) must not produce a second commit.
eq("duplicate read does not double-commit",
  run(["It works great.", "It works great.", "It works great."]),
  ["It works great."]);

// No sentence boundary, short tail -> nothing committed until flush (patient).
eq("patient: no premature fragment commit",
  run(["we are building the next"]),
  []);

if (failed > 0) {
  console.error(`\n${failed} youtube-stitcher test(s) failed`);
  process.exit(1);
}
console.log("\nall youtube-stitcher tests passed");
