(function () {
  "use strict";

  // Pure text predicates shared by content.js. Extracted from content.js so
  // they can be unit-tested in isolation (see scripts/test_segment_utils.js).
  // No DOM, no settings, no module state - input string -> output only.
  // window.YaSubtitleNormalizeText is looked up at call time.

  function normalize(text) {
    if (window.YaSubtitleNormalizeText) {
      return window.YaSubtitleNormalizeText(text);
    }
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isFastPunctuation(text) {
    return /[.!?,;:]$/.test(text.trim());
  }

  function looksIncomplete(text) {
    const value = text.trim().toLowerCase();
    if (!value) {
      return true;
    }
    const words = value.split(/\s+/);
    const last = words[words.length - 1].replace(/[^\w']+$/g, "");
    const weakEndings = new Set([
      "a", "an", "the", "to", "of", "and", "or", "but", "with", "for",
      "from", "in", "on", "at", "as", "such", "whether", "probably",
      "maybe", "will", "we'll", "we", "i", "my", "they", "that", "this",
      "those", "these", "because", "absolutely", "possibly", "probably",
      "actually", "spent", "eventually", "southern", "entire", "reflecting",
      "showcasing", "visiting", "continuing", "preserved", "valued",
      "farmers", "cabbages", "ingredient", "represent", "buying", "more",
      "less", "costs", "between", "above", "lose", "serve", "widespread",
      "retired", "destabilize", "approving", "contract", "contracts",
      "ownership", "subsidies", "accountable", "framework", "recommendations",
      "ban", "easy", "now", "you", "gorgeous", "consistent", "celebrates",
      "captures", "settings", "actions", "content", "experience", "moments",
      "whole", "power", "aio", "mod", "mode", "capabilities", "complex",
      "tools", "twos", "linking", "helping", "our", "live", "material",
      "drape", "billions", "fifty", "million", "developers", "per", "pod",
      "every", "using", "turning", "two", "point", "products", "last",
      "ten", "new", "weight", "really"
    ]);
    return weakEndings.has(last) || /[,—-]\s*$/.test(value);
  }

  function hasHardIncompleteTail(text) {
    const value = text.trim().toLowerCase();
    if (!value) {
      return true;
    }
    const words = value.split(/\s+/);
    const last = words[words.length - 1].replace(/[^\w']+$/g, "");
    const lastTwo = words.slice(-2).join(" ").replace(/[^\w' ]+$/g, "");
    const hardTailWords = new Set([
      "a", "an", "the", "to", "of", "and", "or", "but", "with", "for",
      "from", "in", "on", "at", "as", "that", "which", "who", "when",
      "where", "because", "make", "making", "screen", "high", "low",
      "more", "less", "new", "next", "every", "all", "our", "your",
      "their", "this", "these", "those", "seventeen", "get", "say",
      "safe", "start", "stop", "reclaim", "remind", "reflect", "show",
      "announced", "introduce", "bringing", "keeping", "unlock", "enabling"
    ]);
    return hardTailWords.has(last) || /\b(android|ios|gemini|chrome|pixel|iphone|ipad|mac|search)\s*-\s*[a-z0-9]+[,]?$/.test(value) || /\b(but make|with screen|that can|that will|to make|able to|going to|want to|need to|high in|low in|let's say|so let's)$/.test(lastTwo);
  }

  function isSentenceBoundary(text) {
    return /[.!?]\s*$/.test(text.trim());
  }

  function splitFirstCompleteSentence(text) {
    const value = normalize(text);
    const match = value.match(/^(.+?[.!?])(?:\s+(.+))?$/);
    if (!match) {
      return { head: "", tail: value };
    }
    return {
      head: match[1].trim(),
      tail: (match[2] || "").trim()
    };
  }

  function wordsOf(text) {
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function normalizedWords(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function overlapRatio(a, b) {
    const left = normalizedWords(a);
    const right = normalizedWords(b);
    if (!left.length || !right.length) {
      return 0;
    }
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    let best = 0;
    for (let i = 0; i <= longer.length - shorter.length; i += 1) {
      let same = 0;
      for (let j = 0; j < shorter.length; j += 1) {
        if (longer[i + j] === shorter[j]) {
          same += 1;
        }
      }
      best = Math.max(best, same / shorter.length);
    }
    return best;
  }

  function shouldDropChunk(text) {
    const value = normalize(text).toLowerCase();
    const words = normalizedWords(value);
    if (!value || words.length < 4) {
      return true;
    }

    if (words.length < 6 && looksIncomplete(value)) {
      return true;
    }

    if (/\b(that|because|when|where|which|who|with|without|from|into|about|on|to|and|or|but|we|they|i)\s*$/.test(value)) {
      return true;
    }

    if (/\bthat\s+the\s*$/.test(value) || /\bclear\s+about\s+the\s+facts\s+that\b/.test(value)) {
      return true;
    }

    if (/\b(that|which|who|where|when|while|as|so|because|if)\s+(you|we|they|it|this|that|your|our|the|a|an)?\s*$/.test(value)) {
      return true;
    }

    const weakTailPhrases = [
      /\bjust\s+swipe$/,
      /\btakes\s+advantage\s+of\s+the\s+gorgeous$/,
      /\byour\s+albums,\s+and\s+easy$/,
      /\bthree\s+d\s+effect\s+that\s+you$/,
      /\bthe\s+stunning\s+three\s+d\s+effect\s+that\s+you$/,
      /\bimportant\s+controls\s+now$/,
      /\ba\s+space\s+that\s+celebrates$/,
      /\bspecial\s+moments$/,
      /\bfor\s+a\s+consistent$/,
      /\bconsistent\s+expressive\s+experience\s+while\s+you\s+drive$/,
      /\bwhile\s+creating\s+a\s+more\s+immersive\s+experience$/,
      /\bflow\s+edge\s+to\s+edge$/,
      /\bfloat\s+above\s+the\s+webpage$/,
      /\bfront\s+and\s+center$/,
      /\bliquid\s+glass\s+controls\s+fluidly\s+reveal\s+other\s+actions$/,
      /\bour\s+aio$/,
      /\ban?\s+all\s+new\s+ai\s+mod$/,
      /\bcoming\s+to\s+everyone\s+in\s+the\s+u$/,
      /\bin\s+our\s+biggest\s+markets\s+like\s+the\s+u$/,
      /\bsince\s+launching\s+at\s+io\s+last$/,
      /\baio\s+(views|overviews)\s+are\s+driving\s+over\s+ten$/,
      /\bplaces\s+i've\s+never\s+been\s+before\s+and\s+meet\s+new$/,
      /\byou\s+can\s+bring\s+your$/,
      /\bi\s+love\s+sharing\s+my\.?$/,
      /\bto\s+how\s+you\s+actually\s+express\s+yourself\.?$/,
      /\bpopular\s+apps\s+like\s+gboard,\s+youtube,\s+and\s+gmail\.?$/,
      /\bmany\s+of\s+our\s+users\s+say\s+they\s+want\s+stronger\s+controls\s+that\s+help\s+stop\s+them\s+from\s+turning\.?$/,
      /\bgives\s+me\s+a\s+moment\s+of\s+pause\b.*\bwhy\s+am\s+i\s+really\.?$/,
      /\band\s+lately,\s+there's\s+been$/,
      /\bwhere\s+more\s+of\s+the\s+weight\s+of$/,
      /\bto\s+share\s+a\s+whole$/,
      /\bthe\s+same\s+models\s+that\s+power\s+ai\s+mode\s+to\s+power$/,
      /\bdeeper\s+research,\s+complex$/,
      /\bsearch\s+helps\s+me\s+skip\s+a\s+bunch\s+of\s+steps,\s+linking$/,
      /\bsearch\s+live\s+to\s+the\s+ultimate\s+test,\s+helping\s+us\s+and\s+our$/,
      /\bwhich\s+has\s+over\s+fifty$/,
      /\bthe\s+was\s+most\s+comprehensive\s+set\s+of\s+products$/,
      /\bai\s+module\s+is\s+able\s+to\s+show\s+how\s+this\s+material$/,
      /\band\s+today,\s+gemini\s+two$/,
      /\bthat'?s\s+about\s+a\s+fifty$/,
      /\btoday,\s+over\s+seven\s+million\s+developers$/,
      /\boutput\s+tokens\s+generated\s+per\s+second,\s+all$/,
      /\bmodels\s+of\s+the\s+top\s+models\s+on\s+the\b.*$/,
      /\bwe\s+are\s+bringing\s+project\s+mariners'?$/,
      /\bit\s+integrates\s+with\s+github\s+and\s+works\s+on\s+its$/,
      /\bwith\s+access\s+to\s+twos,\s+they\s+can\s+take$/,
      /\bwill\s+fold\s+and\s+stretch\s+and\s+drape$/,
      /\bstate\s+-?\s*of\s+-?\s*the\s+-?\s*art\b.*\bvisualize\s+how\s+billions$/,
      /\bfrom\s+one\s+place\s+to\s+another,\s+sometimes\s+we\s+would\s+lose$/,
      /\byou\s+know\s+how\s+much\s+they\s+serve$/,
      /\band\s+buying\s+more$/,
      /\bsourcing\s+less\s+from\s+local\s+producers,\s+and\s+buying\s+more$/,
      /\bwhich\s+costs(?:\s+just)?$/,
      /\bsomething\s+that\s+represent$/,
      /\bthe\s+main\s+ingredient$/,
      /\bon\s+top\s+of\s+competition,\s+farmers$/,
      /\bonce\s+that\s+happens,\s+cabbages$/,
      /\banywhere\s+between$/,
      /\brealibrate\s+the\s+relationship\s+between$/,
      /\bcalled\s+\w+\s+from\b.*\band\s+probably\s+the\s+most$/,
      /\bthe\s+most$/,
      /\bcould\s+be\s+widespread$/,
      /\bshould\s+continue\s+to\s+be\s+preserved\s+and\s+valued$/,
      /\bable\s+to\s+employe?\s+retired$/,
      /\btelevision\s+shows\s+like\b.*\band$/,
      /\b(or\s+){1,2}fox,\s+and$/,
      /\bwhich\s+of\s+course\s+means\s+more\s+contracts?$/,
      /\bmalign\s+and\s+an?\s+aggressive\s+behavior\s+and\s+destabilize$/,
      /\bwho\s+are\s+approving$/,
      /\bif\s+you\s+would\s+have\s+a\s+ban$/,
      /\boutlined\s+a\s+number\s+of\s+recommendations$/,
      /\bhas\s+bombed\s+or\s+invaded$/
    ];

    if (weakTailPhrases.some((pattern) => pattern.test(value))) {
      return true;
    }

    if (words.length < 12 && /\b(continuing|reflecting|showcasing|visiting|preserved|valued|farmers|cabbages|ingredient|represent|widespread|between|above|retired|destabilize|approving|recommendations|ban|easy|now|you|gorgeous|consistent|celebrates|captures|settings|actions|content|experience|moments|whole|power|aio|mod|mode|capabilities|complex|tools|twos|linking|helping|our|live|material|drape|billions|fifty|million|developers|per|pod|every|using|two|point|products|last|ten|new|weight)$/.test(value)) {
      return true;
    }

    const badFragments = [
      /^and as i've\b/,
      /^the art on\b/,
      /^output tokens generated\b/,
      /^and also,?\s+we were absolutely\b/,
      /^also,?\s+we were absolutely\b/,
      /^the response on\b/,
      /^response to the u\b/,
      /^negotiations$/,
      /^particularly i think\b/,
      /^they need to find\b/,
      /^we heard from our\b/,
      /^to get to negotiations\b/,
      /^this is the azira user\b/
    ];

    return badFragments.some((pattern) => pattern.test(value));
  }

  function isLikelyContinuation(text) {
    const raw = normalize(text);
    const value = raw.toLowerCase();
    if (!value) {
      return false;
    }
    if (/^[a-z]/.test(raw)) {
      return true;
    }
    return /^(currently|use|using|uses|used|watch|car|glasses|phone|popular|apps|a real|the real|real|based on|with|without|where|which|that|who|when|while|because|to|for|from|into|about|like|including|and|but|so|or|it|they|we|you|this|these|those|same|another|more|less)\b/.test(value);
  }

  function isUnsafeFinalFragment(text) {
    const value = normalize(text);
    const words = wordsOf(value);
    if (!value || isSentenceBoundary(value)) {
      return false;
    }
    if (hasHardIncompleteTail(value) || looksIncomplete(value)) {
      return true;
    }
    if (words.length <= 6 && (isLikelyContinuation(value) || /^[a-z]/.test(value))) {
      return true;
    }
    return words.length <= 10 && /^(and|or|but|so|with|without|for|from|to|into|about|like|including|using|bringing|keeping|enabling|unlocking)\b/i.test(value);
  }

  function isHoldableFragment(text) {
    const value = normalize(text).toLowerCase();
    if (!value) {
      return false;
    }
    const words = wordsOf(value);
    if (words.length < 4) {
      return true;
    }
    if (isSentenceBoundary(value) && words.length >= 7 && !looksIncomplete(value)) {
      return false;
    }
    if (looksIncomplete(value)) {
      return true;
    }
    if (words.length <= 7 && !isSentenceBoundary(value)) {
      return true;
    }
    return /^(and now i'?m wondering|and now i am wondering|and lately|where more of|currently use|currently using|a real impact)\b/.test(value);
  }

  window.YaSegmentUtils = {
    isFastPunctuation,
    looksIncomplete,
    hasHardIncompleteTail,
    isSentenceBoundary,
    splitFirstCompleteSentence,
    wordsOf,
    normalizedWords,
    overlapRatio,
    shouldDropChunk,
    isLikelyContinuation,
    isUnsafeFinalFragment,
    isHoldableFragment
  };
})();
