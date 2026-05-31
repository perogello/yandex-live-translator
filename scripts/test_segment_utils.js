// Unit tests for the pure text predicates extracted from content.js into
// extension/src/segment-utils.js. These gate ingestion quality (which
// fragments are unsafe to send, which to drop, sentence boundaries, overlap).
// Loaded in a vm sandbox with the same normalizer the extension uses.

const fs = require("fs");
const vm = require("vm");

const code = fs.readFileSync("extension/src/segment-utils.js", "utf8");
const ctx = {
  window: { YaSubtitleNormalizeText: (t) => String(t || "").replace(/\s+/g, " ").trim() },
  console,
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const U = ctx.window.YaSegmentUtils;

let failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${name}: got ${a}, expected ${e}`);
    failed += 1;
  } else {
    console.log(`OK ${name}`);
  }
}

// isFastPunctuation / isSentenceBoundary
eq("fast punctuation period", U.isFastPunctuation("Hello."), true);
eq("fast punctuation comma", U.isFastPunctuation("Hello,"), true);
eq("fast punctuation none", U.isFastPunctuation("Hello there"), false);
eq("sentence boundary question", U.isSentenceBoundary("Really?"), true);
eq("sentence boundary none", U.isSentenceBoundary("Really now"), false);

// looksIncomplete (weak trailing word)
eq("incomplete weak tail 'the'", U.looksIncomplete("we are building the"), true);
eq("incomplete trailing comma", U.looksIncomplete("first, second,"), true);
eq("complete plain tail", U.looksIncomplete("we are building today"), false);

// hasHardIncompleteTail (strong fragment markers)
eq("hard tail 'going to'", U.hasHardIncompleteTail("we are going to"), true);
eq("hard tail none", U.hasHardIncompleteTail("we shipped it"), false);

// wordsOf / normalizedWords
eq("wordsOf trims and splits", U.wordsOf("  a  b c "), ["a", "b", "c"]);
eq("normalizedWords lowercases and strips", U.normalizedWords("Liquid-Glass, OK!"), ["liquid", "glass", "ok"]);

// overlapRatio (aligned word overlap)
eq("overlapRatio identical", U.overlapRatio("liquid glass material", "liquid glass material"), 1);
eq("overlapRatio empty", U.overlapRatio("", "anything"), 0);

// splitFirstCompleteSentence
eq("split first sentence", U.splitFirstCompleteSentence("One. Two later"), { head: "One.", tail: "Two later" });
eq("split no boundary", U.splitFirstCompleteSentence("no end here"), { head: "", tail: "no end here" });

// isLikelyContinuation
eq("continuation lowercase start", U.isLikelyContinuation("and then we move"), true);
eq("continuation capital new sentence", U.isLikelyContinuation("Apple shipped it."), false);

// isUnsafeFinalFragment
eq("unsafe tiny fragment", U.isUnsafeFinalFragment("and with"), true);
eq("safe complete sentence", U.isUnsafeFinalFragment("We shipped the new model today."), false);

// shouldDropChunk
eq("drop too-short chunk", U.shouldDropChunk("and we"), true);
eq("keep good sentence", U.shouldDropChunk("We shipped the new model to developers today."), false);

// isHoldableFragment
eq("hold short fragment", U.isHoldableFragment("just a moment"), true);
eq("do not hold complete sentence", U.isHoldableFragment("We shipped the new model to developers today."), false);

if (failed > 0) {
  console.error(`\n${failed} segment-utils test(s) failed`);
  process.exit(1);
}
console.log("\nall segment-utils tests passed");
