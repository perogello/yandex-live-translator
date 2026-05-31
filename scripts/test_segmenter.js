const fs = require("fs");
const vm = require("vm");

const code = fs.readFileSync("extension/src/segmenter.js", "utf8");
const context = {
  console,
  window: {
    YaSubtitleNormalizeText: (text) => String(text || "").replace(/\s+/g, " ").trim()
  }
};

vm.createContext(context);
vm.runInContext(code, context);

const Segmenter = context.window.YaSubtitleSegmenter;

function runCase(name, events, expected) {
  const segmenter = new Segmenter({ qualityMaxWaitMs: 4800, maxInputChars: 1200 });
  let now = 0;
  const outputs = [];
  for (const [text, advance] of events) {
    now += advance;
    outputs.push(...segmenter.push(text, now));
  }
  outputs.push(...segmenter.flush(now + 9000));
  const actual = outputs.join(" | ");
  if (actual !== expected) {
    console.error(`FAIL ${name}`);
    console.error(` expected: ${expected}`);
    console.error(` actual:   ${actual}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${name}`);
}

runCase(
  "hold short prefix until full sentence",
  [
    ["So let's say i get", 1000],
    ["So let's say i get rudely interrupted by an unknown caller right in the middle of my presentation.", 2600]
  ],
  "So let's say i get rudely interrupted by an unknown caller right in the middle of my presentation."
);

runCase(
  "hold weak what tail",
  [
    ["We want everyone to benefit from what", 2000],
    ["We want everyone to benefit from what Gemini can do.", 5200]
  ],
  "We want everyone to benefit from what Gemini can do."
);

runCase(
  "hold next generation tail",
  [
    ["You're using it to debug code, get new insights and build the next generation", 5000],
    ["You're using it to debug code, get new insights and build the next generation of apps.", 6500]
  ],
  "You're using it to debug code, get new insights and build the next generation of apps."
);

runCase(
  "hold continuation start",
  [
    ["And we are encouraged", 3000],
    ["And we are encouraged by the progress we are seeing.", 5000]
  ],
  "And we are encouraged by the progress we are seeing."
);

runCase(
  "wait for numeric tail",
  [
    ["You open your phone, trust to check the weather, and forty five", 5000],
    ["You open your phone, trust to check the weather, and forty five minutes later, you're scrolling with no clue how you got there.", 2500]
  ],
  "You open your phone, trust to check the weather, and forty five minutes later, you're scrolling with no clue how you got there."
);

runCase(
  "remove repeated tail from live asr",
  [
    ["and take photos with ten x optical quality. And and take photos with ten x optical quality.", 1000],
    ["and take photos with ten x optical quality. And and take photos with ten x optical quality.", 1800]
  ],
  "and take photos with ten x optical quality."
);

runCase(
  "remove adjacent repeated phrase from live asr",
  [
    ["pixel eight introduces a whole set of new features of new features that make it easier than ever to get great photos.", 1000],
    ["pixel eight introduces a whole set of new features of new features that make it easier than ever to get great photos.", 1800]
  ],
  "pixel eight introduces a whole set of new features that make it easier than ever to get great photos."
);

runCase(
  "commit long stable fragment earlier",
  [
    ["pixel eight introduces a whole set of new features that make it easier than ever to get great photos", 1000],
    ["pixel eight introduces a whole set of new features that make it easier than ever to get great photos", 2600]
  ],
  "pixel eight introduces a whole set of new features that make it easier than ever to get great photos"
);

runCase(
  "do not flush unfinished article tail",
  [["It's available in the", 9000]],
  ""
);

runCase(
  "do not flush trailing conjunction",
  [["Now, these are nice, but", 9000]],
  ""
);

runCase(
  "do not flush continuation preposition",
  [["with Gemini by your side", 9000]],
  ""
);

// Regression: YouTube CC delivers a rolling window where the front drops off
// and the back grows, so a multi-word term ("liquid glass") arrives split
// across windows. The segmenter must stitch the overlap and commit the term
// intact, otherwise the model mistranslates "liquid"/"call" in isolation
// ("жидкость" / "позвоните"). See 2026-05-31 project-memory entry.
runCase(
  "stitch rolling window so multi-word term stays intact",
  [
    ["And it starts with an entirely new expressive material we call", 1000],
    ["an entirely new expressive material we call liquid", 1600],
    ["expressive material we call liquid glass.", 2200],
    ["Liquid glass is translucent and behaves just like glass.", 4000]
  ],
  "And it starts with an entirely new expressive material we call liquid glass. | Liquid glass is translucent and behaves just like glass."
);

{
  const segmenter = new Segmenter({ qualityMaxWaitMs: 4800, maxInputChars: 1200 });
  const outputs = [];
  outputs.push(...segmenter.pushLines(["fully in our gemini era.", "Before we get into it, i want to reflect"], 1000));
  outputs.push(...segmenter.pushLines(["Before we get into it, i want to reflect on this moment we are in.", "We've been investing in ai for more than a decade."], 2600));
  outputs.push(...segmenter.pushLines(["Before we get into it, i want to reflect on this moment we are in.", "We've been investing in ai for more than a decade."], 3300));
  const actual = outputs.join(" | ");
  const expected = "fully in our gemini era. | Before we get into it, i want to reflect on this moment we are in. | We've been investing in ai for more than a decade.";
  if (actual !== expected) {
    console.error("FAIL two-line window must not cross-contaminate");
    console.error(` expected: ${expected}`);
    console.error(` actual:   ${actual}`);
    process.exitCode = 1;
  } else {
    console.log("OK two-line window must not cross-contaminate");
  }
}
