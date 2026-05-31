// Unit tests for the overlay-side near-duplicate detection that decides
// whether an incoming translated row repeats what is already shown/queued.
// This guards against the visible repeats the operator reported, without
// touching the DOM-heavy animation code.

const fs = require("fs");
const vm = require("vm");

const code = fs.readFileSync("extension/src/overlay.js", "utf8");
const ctx = { window: {}, document: { createElement: () => ({}) }, console };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const Overlay = ctx.window.YaTranslatorOverlay;
// areNearDuplicates is a pure method; call it on a bare instance.
const o = Object.create(Overlay.prototype);

let failed = 0;
function check(name, a, b, expected) {
  const actual = o.areNearDuplicates(a, b);
  if (actual !== expected) {
    console.error(`FAIL ${name}: areNearDuplicates(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${actual}, expected ${expected}`);
    failed += 1;
    return;
  }
  console.log(`OK ${name}`);
}

// Exact and trivial cases
check("identical rows are duplicates", "Привет как дела", "Привет как дела", true);
check("empty is never a duplicate", "", "что-то", false);
check("both empty -> false", "", "", false);

// Revisions: a shorter row fully inside a longer one (ASR/segmenter growth)
check("shorter row contained in longer", "Мы строим будущее", "Мы строим будущее сегодня", true);
check("longer row contains shorter", "Это Liquid Glass материал прозрачный", "Liquid Glass материал", true);

// Genuinely different content must NOT be merged away
check("unrelated sentences are not duplicates", "Совсем другая фраза здесь", "Кошка спит на тёплом окне", false);
check("same topic but different facts", "Цена девятнадцать миллиардов токенов", "Скорость выросла в десять раз", false);

// Case/punctuation insensitivity
check("case and punctuation ignored", "Liquid Glass — это материал!", "liquid glass это материал", true);

if (failed > 0) {
  console.error(`\n${failed} overlay test(s) failed`);
  process.exit(1);
}
console.log("\nall overlay tests passed");
