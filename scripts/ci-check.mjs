#!/usr/bin/env node
/**
 * Zero-dependency AI-native CI gate for kilocean-translate.
 * Exit non-zero with clear messages on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ALLOWED_PERMISSIONS = new Set(["activeTab", "scripting", "storage"]);
const ALLOWED_HOSTS = new Set([
  "https://api.deepseek.com/*",
  "https://api.moonshot.cn/*",
]);
const JS_FILES = ["background.js", "content.js", "popup.js", "shared.js"];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`missing file: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    fail(`invalid JSON ${rel}: ${error.message}`);
    return null;
  }
}

function checkManifest() {
  const manifest = readJson("manifest.json");
  if (!manifest) {
    return;
  }

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, got ${JSON.stringify(manifest.manifest_version)}`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail("manifest.name is required");
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
    fail(`manifest.version must be semver-ish X.Y.Z, got ${JSON.stringify(manifest.version)}`);
  }
  if (!manifest.background?.service_worker) {
    fail("manifest.background.service_worker is required");
  }
  if (!manifest.action?.default_popup) {
    fail("manifest.action.default_popup is required");
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const perm of permissions) {
    if (!ALLOWED_PERMISSIONS.has(perm)) {
      fail(`disallowed permission: ${perm} (allowlist: ${[...ALLOWED_PERMISSIONS].join(", ")})`);
    }
  }
  for (const required of ALLOWED_PERMISSIONS) {
    if (!permissions.includes(required)) {
      fail(`missing required permission: ${required}`);
    }
  }

  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  if (!hosts.includes("https://api.deepseek.com/*")) {
    fail("host_permissions must include https://api.deepseek.com/*");
  }
  for (const host of hosts) {
    if (!ALLOWED_HOSTS.has(host)) {
      fail(`disallowed host_permission: ${host} (allowlist: ${[...ALLOWED_HOSTS].join(", ")})`);
    }
  }
}

function stripCommentsForScan(source) {
  // Remove block comments and line comments so we do not false-positive on them.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => `${p1}${" ".repeat(m.length - p1.length)}`);
}

function checkSyntax(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`missing JS file: ${rel}`);
    return;
  }

  const result = spawnSync(process.execPath, ["--check", full], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    fail(`syntax check failed for ${rel}: ${detail}`);
  }
}

function checkStaticBans(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    return;
  }
  const raw = fs.readFileSync(full, "utf8");
  const source = stripCommentsForScan(raw);

  if (/\beval\s*\(/.test(source)) {
    fail(`${rel}: forbidden pattern eval(`);
  }
  if (/\bnew\s+Function\s*\(/.test(source)) {
    fail(`${rel}: forbidden pattern new Function(`);
  }

  // Flag chrome.scripting.executeScript({ ... world: "MAIN" ... }) as unsafe.
  // Only when world MAIN is clearly present near executeScript usage.
  const execRe = /chrome\.scripting\.executeScript\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match;
  while ((match = execRe.exec(source)) !== null) {
    const opts = match[1];
    if (/\bworld\s*:\s*['"]MAIN['"]/.test(opts)) {
      fail(`${rel}: forbidden chrome.scripting.executeScript with world MAIN`);
    }
  }
}

function extractContentFunction(name) {
  // Pull a top-level (2-space indented) function body out of the content.js
  // IIFE so unit tests run the shipping implementation without exports.
  const source = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
  return match ? match[0] : null;
}


function checkParseTranslationPayload() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for parseTranslationPayload test: ${error.message}`);
    return;
  }
  const { parseTranslationPayload, hasMultiParagraphSource, countSourceParagraphUnits } = utils;
  if (typeof parseTranslationPayload !== "function") {
    fail("shared.js: parseTranslationPayload export missing");
    return;
  }
  if (typeof hasMultiParagraphSource !== "function") {
    fail("shared.js: hasMultiParagraphSource export missing");
    return;
  }
  if (typeof countSourceParagraphUnits !== "function") {
    fail("shared.js: countSourceParagraphUnits export missing");
    return;
  }

  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertThrows = (fn, label) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) {
      fail(`${label}: expected throw`);
    }
  };

  assertEqual(hasMultiParagraphSource("a\n\nb"), true, "hasMultiParagraphSource: blank-line");
  assertEqual(hasMultiParagraphSource("a\nb"), true, "hasMultiParagraphSource: single-newline lines");
  assertEqual(hasMultiParagraphSource("单段原文"), false, "hasMultiParagraphSource: single line");
  assertEqual(hasMultiParagraphSource(""), false, "hasMultiParagraphSource: empty");
  assertEqual(hasMultiParagraphSource("第一段\n \n第二段"), true, "hasMultiParagraphSource: whitespace-only blank line");
  assertEqual(hasMultiParagraphSource("第一段\r\n\r\n第二段"), true, "hasMultiParagraphSource: CRLF blank line");

  assertEqual(countSourceParagraphUnits("第一段\n\n第二段\n\n第三段"), 3, "countSourceParagraphUnits: blank-line paras");
  assertEqual(countSourceParagraphUnits("第一段\n第二段\n第三段"), 3, "countSourceParagraphUnits: single-newline lines");
  assertEqual(countSourceParagraphUnits("单段原文"), 1, "countSourceParagraphUnits: single line");
  assertEqual(countSourceParagraphUnits(""), 0, "countSourceParagraphUnits: empty");
  assertEqual(countSourceParagraphUnits("第一段\n \n第二段"), 2, "countSourceParagraphUnits: whitespace-only blank line paras");
  assertEqual(countSourceParagraphUnits("第一段\r\n\r\n第二段"), 2, "countSourceParagraphUnits: CRLF blank line paras");

  // expectedCount 1 + N>1 all-string + multi-paragraph source → join with \n\n
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段", "丙段"] }),
      1,
      "第一段\n\n第二段\n\n第三段"
    ),
    ["甲段\n\n乙段\n\n丙段"],
    "parseTranslationPayload: join N>1 when expectedCount===1 and source has \\n\\n"
  );

  // Normalized full-page path: paragraphs as single \n still recover (join with \n)
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段", "丙段"] }),
      1,
      "第一段\n第二段\n第三段"
    ),
    ["甲段\n乙段\n丙段"],
    "parseTranslationPayload: join N>1 on single-\\n multi-line source"
  );

  // Recovered entries are trimmed before joining so edge whitespace cannot
  // stack newlines/gaps around the separator.
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段\n", "\n乙段"] }),
      1,
      "第一段\n\n第二段"
    ),
    ["甲段\n\n乙段"],
    "parseTranslationPayload: trim recovered entries before \\n\\n join"
  );
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段  ", " 乙段"] }),
      1,
      "第一段\n第二段"
    ),
    ["甲段\n乙段"],
    "parseTranslationPayload: trim recovered entries before \\n join"
  );

  // Whitespace-only / CRLF blank lines still count as paragraph breaks: the
  // join must use \n\n, not collapse to a single \n.
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段"] }),
      1,
      "第一段\n \n第二段"
    ),
    ["甲段\n\n乙段"],
    "parseTranslationPayload: whitespace-only blank line joins with \\n\\n"
  );
  assertEqual(
    parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段"] }),
      1,
      "第一段\r\n\r\n第二段"
    ),
    ["甲段\n\n乙段"],
    "parseTranslationPayload: CRLF blank line joins with \\n\\n"
  );

  // Normalized blank-line counting must still fail closed on count mismatch
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段", "丙段"] }),
      1,
      "第一段\n \n第二段"
    ),
    "parseTranslationPayload: must not join on whitespace-only blank line with extra translations"
  );

  // Join recovery must only run when returned entry count matches source units
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段"] }),
      1,
      "第一段\n\n第二段\n\n第三段"
    ),
    "parseTranslationPayload: must not join when fewer translations than source units"
  );
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段", "丙段", "丁段"] }),
      1,
      "第一段\n\n第二段\n\n第三段"
    ),
    "parseTranslationPayload: must not join when more translations than source units"
  );

  // Empty / whitespace-only entries must not join — fall through to length mismatch
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["第一段译文", ""] }),
      1,
      "第一段\n\n第二段"
    ),
    "parseTranslationPayload: must not join empty-string entries in N>1 recovery"
  );
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["第一段译文", "   "] }),
      1,
      "第一段\n\n第二段"
    ),
    "parseTranslationPayload: must not join whitespace-only entries in N>1 recovery"
  );

  // expectedCount 1 + N>1 all-string but single-paragraph source → throws
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段"] }),
      1,
      "单段原文"
    ),
    "parseTranslationPayload: must not join without multi-paragraph source"
  );

  // Single-line source with N>1 extras must still reject (fail closed)
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲段", "乙段", "丙段"] }),
      1,
      "一整段没有换行的原文"
    ),
    "parseTranslationPayload: must not join single-line source with N>1 extras"
  );

  // expectedCount 1 + N>1 all-string with omitted sourceText → throws
  assertThrows(
    () => parseTranslationPayload(JSON.stringify({ translations: ["甲段", "乙段"] }), 1),
    "parseTranslationPayload: must not join when sourceText omitted"
  );

  // expectedCount 1 + exact 1 string → unchanged
  assertEqual(
    parseTranslationPayload(JSON.stringify({ translations: ["单段译文"] }), 1, "单段原文"),
    ["单段译文"],
    "parseTranslationPayload: single string passthrough"
  );

  // expectedCount 2 + 2 strings → ok
  assertEqual(
    parseTranslationPayload(JSON.stringify({ translations: ["一", "二"] }), 2),
    ["一", "二"],
    "parseTranslationPayload: matching multi-count"
  );

  // expectedCount 2 + 3 strings → throws
  assertThrows(
    () => parseTranslationPayload(JSON.stringify({ translations: ["一", "二", "三"] }), 2),
    "parseTranslationPayload: mismatch when expectedCount>1"
  );

  // expectedCount 1 + N>1 with a non-string item → throws
  assertThrows(
    () => parseTranslationPayload(
      JSON.stringify({ translations: ["甲", 2, "丙"] }),
      1,
      "甲\n\n乙\n\n丙"
    ),
    "parseTranslationPayload: non-string items must not join"
  );
}

function checkSegmentSplitLogic() {
  const splitFnSource = extractContentFunction("findSegmentSplitIndex");
  if (!splitFnSource) {
    fail("content.js: cannot extract findSegmentSplitIndex for split-logic test");
    return;
  }

  let findSegmentSplitIndex;
  try {
    findSegmentSplitIndex = new Function(`${splitFnSource}\nreturn findSegmentSplitIndex;`)();
  } catch (error) {
    fail(`content.js: findSegmentSplitIndex is not runnable standalone: ${error.message}`);
    return;
  }

  // Length < 2 cannot be split.
  if (findSegmentSplitIndex("") !== -1 || findSegmentSplitIndex("a") !== -1) {
    fail("findSegmentSplitIndex: length < 2 must return -1");
  }

  // \n\n paragraph break near mid wins: split right after the blank line.
  const paraText = `${"甲".repeat(2400)}\n\n${"乙".repeat(2400)}`;
  const paraAt = findSegmentSplitIndex(paraText);
  if (paraAt !== 2402 || !paraText.slice(0, paraAt).endsWith("\n\n")) {
    fail(`findSegmentSplitIndex: expected paragraph split at 2402, got ${paraAt}`);
  }

  // A single \n is preferred over a space.
  const lineText = `${"A".repeat(100)}\n${"B".repeat(50)} ${"C".repeat(50)}`;
  const lineAt = findSegmentSplitIndex(lineText);
  if (lineAt !== 101) {
    fail(`findSegmentSplitIndex: expected newline split at 101, got ${lineAt}`);
  }

  // Whitespace fallback still applies when no newline exists.
  const spaceText = `${"A".repeat(50)} ${"B".repeat(51)}`;
  const spaceAt = findSegmentSplitIndex(spaceText);
  if (spaceAt !== 51) {
    fail(`findSegmentSplitIndex: expected whitespace split at 51, got ${spaceAt}`);
  }

  // No whitespace at all: fall back to the midpoint.
  const denseAt = findSegmentSplitIndex("字".repeat(101));
  if (denseAt !== 51) {
    fail(`findSegmentSplitIndex: expected midpoint split at 51, got ${denseAt}`);
  }

  // Midpoint must never land between a UTF-16 surrogate pair (emoji).
  const emoji = "😀"; // one astral char = high+low surrogates
  const emojiText = `${"字".repeat(50)}${emoji}${"字".repeat(50)}`;
  const emojiAt = findSegmentSplitIndex(emojiText);
  const prevCode = emojiText.charCodeAt(emojiAt - 1);
  const currCode = emojiText.charCodeAt(emojiAt);
  const betweenPair =
    prevCode >= 0xD800 && prevCode <= 0xDBFF && currCode >= 0xDC00 && currCode <= 0xDFFF;
  if (betweenPair) {
    fail(`findSegmentSplitIndex: split ${emojiAt} lands between surrogate pair`);
  }
  if (emojiAt !== 50 && emojiAt !== 52) {
    fail(`findSegmentSplitIndex: expected emoji-safe split at 50 or 52, got ${emojiAt}`);
  }

  // Oversized X-style post (single ~9k span, \n\n paragraphs): recursive
  // pre-split must bisect BEFORE any request, keep every piece <= 5000, and
  // cut only on paragraph boundaries.
  const splitFn = extractContentFunction("translateSegmentTextWithSplit");
  if (!splitFn) {
    fail("content.js: cannot extract translateSegmentTextWithSplit for split-logic test");
    return;
  }
  const firstSplit = splitFn.indexOf("findSegmentSplitIndex");
  const firstRequest = splitFn.indexOf("requestSegmentTranslations");
  if (firstSplit < 0 || firstRequest < 0 || firstSplit > firstRequest) {
    fail("content.js: translateSegmentTextWithSplit must split oversized text before the first TRANSLATE_BATCH request");
  }

  const longPost = Array.from({ length: 60 }, (_, i) => `第${i}段${"内容".repeat(73)}`).join("\n\n");
  const splitIntoPieces = (text) => {
    if (text.length <= 5000) {
      return [text];
    }
    const at = findSegmentSplitIndex(text);
    if (at < 1 || at >= text.length) {
      return [text];
    }
    return [...splitIntoPieces(text.slice(0, at)), ...splitIntoPieces(text.slice(at))];
  };
  const pieces = splitIntoPieces(longPost);
  if (longPost.length <= 5000) {
    fail("split-logic fixture must be oversized");
  }
  if (pieces.length < 2) {
    fail("oversized text must be split into at least two pieces");
  }
  if (pieces.some((piece) => piece.length > 5000)) {
    fail(`oversized split produced a piece > 5000 chars (lengths: ${pieces.map((p) => p.length).join(",")})`);
  }
  if (pieces.join("") !== longPost) {
    fail("oversized split lost or duplicated characters");
  }
  if (pieces.slice(0, -1).some((piece) => !piece.endsWith("\n\n"))) {
    fail("oversized split did not respect \\n\\n paragraph boundaries");
  }
}


function checkJoinSplitTranslations() {
  const joinSrc = extractContentFunction("joinSplitTranslations");
  const delimSrc = extractContentFunction("isWhitespaceDelimitedTarget");
  if (!joinSrc || !delimSrc) {
    fail("content.js: cannot extract joinSplitTranslations / isWhitespaceDelimitedTarget");
    return;
  }

  let joinSplitTranslations;
  try {
    joinSplitTranslations = new Function(
      `${delimSrc}\n${joinSrc}\nreturn joinSplitTranslations;`
    )();
  } catch (error) {
    fail(`joinSplitTranslations extract failed: ${error.message}`);
    return;
  }

  const assertEqual = (actual, expected, label) => {
    if (actual !== expected) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  // Blank-line boundary from left trail must rejoin with \\n\\n (not collapse to \\n).
  assertEqual(
    joinSplitTranslations("甲", "乙", "甲\n\n", "乙", "zh"),
    "甲\n\n乙",
    "joinSplitTranslations: preserve blank-line boundary"
  );
  assertEqual(
    joinSplitTranslations("甲", "乙", "甲", "\n\n乙", "zh"),
    "甲\n\n乙",
    "joinSplitTranslations: preserve blank-line from right lead"
  );

  // Source blank-line must win over partial translated edge whitespace.
  assertEqual(
    joinSplitTranslations("甲\n", "乙", "甲\n\n", "乙", "zh"),
    "甲\n\n乙",
    "joinSplitTranslations: source blank-line wins over left translated trailing newline"
  );
  assertEqual(
    joinSplitTranslations("甲", "\n乙", "甲", "\n\n乙", "zh"),
    "甲\n\n乙",
    "joinSplitTranslations: source blank-line wins over right translated leading newline"
  );

  // Single newline boundary.
  assertEqual(
    joinSplitTranslations("甲", "乙", "甲\n", "乙", "zh"),
    "甲\n乙",
    "joinSplitTranslations: preserve single newline boundary"
  );

  // Space boundary.
  assertEqual(
    joinSplitTranslations("Hello", "world", "Hello ", "world", "en"),
    "Hello world",
    "joinSplitTranslations: space boundary"
  );

  // forceSplit: canSplit single-item fallback must bisect without re-requesting.
  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const splitFn = extractContentFunction("translateSegmentTextWithSplit");
  if (!splitFn || !/options\s*=\s*\{\s*\}/.test(splitFn) || !/options\.forceSplit/.test(splitFn)) {
    fail("content.js: translateSegmentTextWithSplit must accept options.forceSplit and bisect immediately");
  }
  // Single-item canSplit path must pass { forceSplit: true }.
  if (!/error\.canSplit\s*&&\s*batch\.length\s*===\s*1[\s\S]*?forceSplit:\s*true/.test(content)) {
    fail("content.js: canSplit single-item fallback must call translateSegmentTextWithSplit with forceSplit: true");
  }
  // >5000 proactive path must still call without forceSplit.
  if (!/batch\[0\]\.text\.length\s*>\s*5000[\s\S]*?translateSegmentTextWithSplit\(segment\.text,\s*runId,\s*runSettings\)/.test(content)) {
    fail("content.js: >5000 proactive path must call translateSegmentTextWithSplit without forceSplit");
  }
}

function checkJoinRawTextNodesNormalize() {
  const fnSource = extractContentFunction("joinRawTextNodes");
  if (!fnSource) {
    fail("content.js: cannot extract joinRawTextNodes for normalize test");
    return;
  }

  let joinRawTextNodes;
  try {
    joinRawTextNodes = new Function(`${fnSource}\nreturn joinRawTextNodes;`)();
  } catch (error) {
    fail(`joinRawTextNodes extract failed: ${error.message}`);
    return;
  }

  const assertEqual = (actual, expected, label) => {
    if (actual !== expected) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  // Single text node: normalize must keep blank-line paragraph breaks.
  assertEqual(
    joinRawTextNodes([{ data: "a\n\nb" }]),
    "a\n\nb",
    "joinRawTextNodes: preserve \\n\\n"
  );
  assertEqual(
    joinRawTextNodes([{ data: "a \n\n b" }]),
    "a\n\nb",
    "joinRawTextNodes: trim horizontal space around \\n\\n"
  );
  assertEqual(
    joinRawTextNodes([{ data: "hello   world" }]),
    "hello world",
    "joinRawTextNodes: collapse horizontal whitespace"
  );
}

function checkXLayoutHeuristics() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for X heuristic tests: ${error.message}`);
    return;
  }

  const { isAlreadyTargetLanguage, isSkippableText, isXHost, X_TRANSLATABLE_SELECTOR } = utils;
  if (typeof isAlreadyTargetLanguage !== "function") {
    fail("shared.js: isAlreadyTargetLanguage export missing");
    return;
  }
  if (typeof isSkippableText !== "function") {
    fail("shared.js: isSkippableText export missing");
    return;
  }
  if (typeof isXHost !== "function") {
    fail("shared.js: isXHost export missing");
    return;
  }
  if (
    typeof X_TRANSLATABLE_SELECTOR !== "string" ||
    !X_TRANSLATABLE_SELECTOR.includes("tweetText") ||
    !X_TRANSLATABLE_SELECTOR.includes("UserDescription")
  ) {
    fail("shared.js: X_TRANSLATABLE_SELECTOR must cover tweetText and UserDescription");
    return;
  }

  const assertTrue = (actual, label) => {
    if (actual !== true) {
      fail(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
  };
  const assertFalse = (actual, label) => {
    if (actual !== false) {
      fail(`${label}: expected false, got ${JSON.stringify(actual)}`);
    }
  };

  // Already-target-language detection ("宝玉宝玉" duplication).
  assertTrue(isAlreadyTargetLanguage("宝玉", "zh"), "isAlreadyTargetLanguage: '宝玉' zh skips");
  assertFalse(isAlreadyTargetLanguage("Hello world", "zh"), "isAlreadyTargetLanguage: 'Hello world' zh translates");
  assertFalse(isAlreadyTargetLanguage("你好", "en"), "isAlreadyTargetLanguage: '你好' en translates");
  // Full target codes and ja/ko script probes.
  assertTrue(isAlreadyTargetLanguage("今天天气很好", "zh-CN"), "isAlreadyTargetLanguage: zh-CN code skips Han text");
  assertTrue(isAlreadyTargetLanguage("今日は良い天気ですね", "ja"), "isAlreadyTargetLanguage: kana-bearing text skips for ja");
  assertTrue(isAlreadyTargetLanguage("안녕하세요", "ko"), "isAlreadyTargetLanguage: hangul text skips for ko");
  assertFalse(isAlreadyTargetLanguage(42, "en"), "isAlreadyTargetLanguage: non-string translates (fail open to other gates)");

  // Kana letters only: block punctuation (U+30FB ・ etc.) must never make
  // text count as Japanese.
  assertFalse(isAlreadyTargetLanguage("你好・世界", "ja"), "isAlreadyTargetLanguage: '你好・世界' ja translates (middle dot is not kana)");
  // Kana/hangul disqualify the Chinese shortcut: Han-heavy Japanese prose
  // must stay eligible for zh translation.
  assertFalse(isAlreadyTargetLanguage("今日は良い天気ですね", "zh-CN"), "isAlreadyTargetLanguage: Japanese prose translates to zh-CN");
  // Latin script alone cannot prove English — French/Spanish/German
  // paragraphs must stay eligible (conservative: never shortcut for en).
  assertFalse(isAlreadyTargetLanguage("Home", "en"), "isAlreadyTargetLanguage: 'Home' en translates (Latin script is not proof of English)");
  assertFalse(isAlreadyTargetLanguage("Bonjour le monde", "en"), "isAlreadyTargetLanguage: French translates for en");
  assertFalse(isAlreadyTargetLanguage("Hola mundo", "en"), "isAlreadyTargetLanguage: Spanish translates for en");
  assertFalse(isAlreadyTargetLanguage("Das ist ein deutscher Satz", "en"), "isAlreadyTargetLanguage: German translates for en");
  // Mixed-script text: every Unicode letter votes in the ratio denominator,
  // so a target-script minority amid Cyrillic/Arabic must fail open to
  // translation instead of being classified as already zh-CN / ja / ko.
  assertFalse(isAlreadyTargetLanguage("中文 Привет мир", "zh-CN"), "isAlreadyTargetLanguage: Han minority amid Cyrillic translates for zh-CN");
  assertFalse(isAlreadyTargetLanguage("かな Привет мир", "ja"), "isAlreadyTargetLanguage: kana minority amid Cyrillic translates for ja");
  assertFalse(isAlreadyTargetLanguage("한국어 مرحبا بالعالم", "ko"), "isAlreadyTargetLanguage: hangul minority amid Arabic translates for ko");
  // Strict no-foreign-letter rule: mixed-script text must never take the
  // shortcut even when the target-script share alone clears the ratio floor
  // ("한국어 Привет" is 3/9 Hangul >= 0.3; "かな test" is 2/6 kana >= 0.2).
  assertFalse(isAlreadyTargetLanguage("한국어 Привет", "ko"), "isAlreadyTargetLanguage: Hangul share clears ko floor but Cyrillic letters force translation");
  assertFalse(isAlreadyTargetLanguage("かな test", "ja"), "isAlreadyTargetLanguage: kana share clears ja floor but Latin letters force translation");
  // The prolonged sound mark is an allowed Japanese letter, not a foreign one.
  assertTrue(isAlreadyTargetLanguage("スーパー", "ja"), "isAlreadyTargetLanguage: kana word with prolonged marks skips for ja");

  // Skippable page chrome.
  assertTrue(isSkippableText("@karpathy"), "isSkippableText: @handle");
  assertTrue(isSkippableText("1.9K"), "isSkippableText: counter 1.9K");
  assertTrue(isSkippableText("12万"), "isSkippableText: counter 12万");
  assertTrue(isSkippableText("https://x.com/a"), "isSkippableText: bare URL");
  assertTrue(isSkippableText("Oct 12"), "isSkippableText: bare date Oct 12");
  assertTrue(isSkippableText("October 12, 2026"), "isSkippableText: bare date with full month name");
  assertTrue(isSkippableText("Sept 12"), "isSkippableText: bare date Sept abbreviation");
  assertTrue(isSkippableText("2h"), "isSkippableText: relative time 2h");
  assertFalse(isSkippableText("Hello world"), "isSkippableText: normal English sentence");
  assertFalse(isSkippableText("这是一句正常的话"), "isSkippableText: normal Chinese sentence");
  assertFalse(isSkippableText("Octopus live long lives"), "isSkippableText: month-prefixed real sentence");
  // Month regex must be word-bounded: ordinary words that merely start with
  // a month abbreviation stay translatable instead of being dropped as dates.
  assertFalse(isSkippableText("Market 12"), "isSkippableText: 'Market 12' is not a date");
  assertFalse(isSkippableText("Octopus 12"), "isSkippableText: 'Octopus 12' is not a date");
  assertFalse(isSkippableText("Decemberish 3"), "isSkippableText: 'Decemberish 3' is not a date");

  // X host gating.
  assertTrue(isXHost("x.com"), "isXHost: x.com");
  assertTrue(isXHost("twitter.com"), "isXHost: twitter.com");
  assertTrue(isXHost("mobile.twitter.com"), "isXHost: mobile.twitter.com");
  assertFalse(isXHost("example.com"), "isXHost: example.com");
  assertFalse(isXHost("notx.com"), "isXHost: notx.com must not match");
}

function checkXMutationScopeGate() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for X mutation scope test: ${error.message}`);
    return;
  }

  // Every pendingRoots queue site inside startObserving must route through
  // the X-scope predicate: out-of-scope churn (sidebar, counters, nav) can
  // never yield an eligible block, and queueing it would endlessly reset the
  // 450 ms debounce and pin state.phase at "translating" while export stays
  // locked.
  const observerSource = extractContentFunction("startObserving");
  if (!observerSource) {
    fail("content.js: cannot extract startObserving for mutation scope test");
    return;
  }
  const queueSites = (observerSource.match(/pendingRoots\.add\(/g) || []).length;
  const guardedSites = (observerSource.match(/isInXTranslatableMutationScope\(/g) || []).length;
  if (queueSites !== 3 || guardedSites < 3) {
    fail(
      `content.js: startObserving must gate all 3 pendingRoots.add sites (removal target, addedNodes, characterData) through isInXTranslatableMutationScope — found ${queueSites} queue sites, ${guardedSites} guards`
    );
    return;
  }

  const fnSource = extractContentFunction("isInXTranslatableMutationScope");
  if (!fnSource) {
    fail("content.js: cannot extract isInXTranslatableMutationScope for scope test");
    return;
  }

  const compile = (isXHost) => {
    try {
      return new Function(
        "IS_X_HOST",
        "Node",
        "Utils",
        `${fnSource}\nreturn isInXTranslatableMutationScope;`
      )(isXHost, { ELEMENT_NODE: 1, TEXT_NODE: 3 }, utils);
    } catch (error) {
      fail(`isInXTranslatableMutationScope extract failed: ${error.message}`);
      return null;
    }
  };

  const assertTrue = (actual, label) => {
    if (actual !== true) {
      fail(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
  };
  const assertFalse = (actual, label) => {
    if (actual !== false) {
      fail(`${label}: expected false, got ${JSON.stringify(actual)}`);
    }
  };

  // Minimal element stubs: closest() = ancestor-or-self selector hit,
  // querySelector() = descendant selector hit.
  const el = ({ closestResult = null, descendantResult = null, connected = true } = {}) => ({
    nodeType: 1,
    isConnected: connected,
    closest: () => closestResult,
    querySelector: () => descendantResult
  });
  const text = (parent) => ({ nodeType: 3, parentElement: parent });

  const onX = compile(true);
  if (!onX) {
    return;
  }
  // In scope: inside (or being) tweetText/UserDescription, or a subtree that
  // carries one (freshly inserted timeline article).
  assertTrue(onX(el({ closestResult: {} })), "X mutation scope: tweetText element itself is in scope");
  assertTrue(onX(el({ descendantResult: {} })), "X mutation scope: subtree containing tweetText is in scope");
  assertTrue(onX(text(el({ closestResult: {} }))), "X mutation scope: text node inside tweetText is in scope");
  // Out of scope: page chrome and detached roots must not queue work.
  assertFalse(onX(el()), "X mutation scope: sidebar chrome element is out of scope");
  assertFalse(onX(el({ connected: false })), "X mutation scope: detached element is out of scope");
  assertFalse(onX(text(el())), "X mutation scope: text node in chrome is out of scope");
  assertFalse(onX(text(null)), "X mutation scope: parentless text node is out of scope");

  // Off X the gate must stay open — other sites have no scope restriction.
  const offX = compile(false);
  if (!offX) {
    return;
  }
  assertTrue(offX(el()), "X mutation scope: non-X host keeps every root queueable");
}

function checkEnglishProfileDetection() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for English-profile tests: ${error.message}`);
    return;
  }
  const { looksLikeEnglish, isAlreadyTargetLanguage, isSameTranslation } = utils;
  if (typeof looksLikeEnglish !== "function") {
    fail("shared.js: looksLikeEnglish export missing");
    return;
  }
  if (typeof isSameTranslation !== "function") {
    fail("shared.js: isSameTranslation export missing");
    return;
  }

  const assertTrue = (actual, label) => {
    if (actual !== true) {
      fail(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
  };
  const assertFalse = (actual, label) => {
    if (actual !== false) {
      fail(`${label}: expected false, got ${JSON.stringify(actual)}`);
    }
  };

  // English bio sentences must be detected (target-en duplication fix).
  assertTrue(looksLikeEnglish("I build tools for the web and write about design."), "looksLikeEnglish: English bio sentence");
  assertTrue(looksLikeEnglish("Building tools for developers who care about speed and privacy."), "looksLikeEnglish: English bio sentence 2");
  assertTrue(looksLikeEnglish("We are a small team of makers based in Berlin."), "looksLikeEnglish: English bio sentence 3");

  // French / German / Spanish sentences must never be detected as English —
  // they have to keep translating for en targets (earlier review P1).
  assertFalse(looksLikeEnglish("Je m'appelle Marie et j'aime la lecture et la musique."), "looksLikeEnglish: French sentence");
  assertFalse(looksLikeEnglish("Ich arbeite als Softwareentwickler und trinke gern Kaffee."), "looksLikeEnglish: German sentence");
  assertFalse(looksLikeEnglish("Me gusta trabajar en proyectos libres y aprender cosas nuevas."), "looksLikeEnglish: Spanish sentence");
  assertFalse(looksLikeEnglish("Das ist ein deutscher Satz mit vielen Wörtern."), "looksLikeEnglish: accented German sentence");
  // Short / ambiguous text stays conservative: translate unless clearly English.
  assertFalse(looksLikeEnglish("Home"), "looksLikeEnglish: single noun without function words");
  assertFalse(looksLikeEnglish("Hola mundo"), "looksLikeEnglish: short Spanish");
  assertTrue(looksLikeEnglish("About me"), "looksLikeEnglish: short but clearly English");

  // isAlreadyTargetLanguage en behavior: English profile skips, everything
  // uncertain translates.
  assertTrue(
    isAlreadyTargetLanguage("I build tools for the web and write about design.", "en"),
    "isAlreadyTargetLanguage: English bio skips for en"
  );
  assertTrue(
    isAlreadyTargetLanguage("Building tools for developers who care about speed and privacy.", "en-US"),
    "isAlreadyTargetLanguage: English bio skips for en-* code"
  );
  assertFalse(
    isAlreadyTargetLanguage("Je m'appelle Marie et j'aime la lecture et la musique.", "en"),
    "isAlreadyTargetLanguage: French bio translates for en"
  );
  assertFalse(
    isAlreadyTargetLanguage("Ich arbeite als Softwareentwickler und trinke gern Kaffee.", "en"),
    "isAlreadyTargetLanguage: German bio translates for en"
  );
  assertFalse(
    isAlreadyTargetLanguage("Me gusta trabajar en proyectos libres y aprender cosas nuevas.", "en"),
    "isAlreadyTargetLanguage: Spanish bio translates for en"
  );
  assertFalse(isAlreadyTargetLanguage("Software engineer", "en"), "isAlreadyTargetLanguage: stopword-less short text stays conservative for en");

  // isSameTranslation: provider echoes must be recognized after normalization.
  assertTrue(isSameTranslation("Hello world.", "hello world"), "isSameTranslation: case + trailing punctuation");
  assertTrue(isSameTranslation("Hello   WORLD", "hello world…"), "isSameTranslation: whitespace collapse + ellipsis");
  assertTrue(isSameTranslation("甲\n\n乙", "甲\n 乙"), "isSameTranslation: newline collapse");
  assertTrue(isSameTranslation("你好，世界", "你好，世界。"), "isSameTranslation: CJK trailing punctuation");
  assertFalse(isSameTranslation("Hello", "Bonjour"), "isSameTranslation: different text");
  assertFalse(isSameTranslation("", ""), "isSameTranslation: empty never counts as same");
  assertFalse(isSameTranslation("Hello", ""), "isSameTranslation: empty output never counts as same");
}

function checkVersionBump() {
  const manifest = readJson("manifest.json");
  if (manifest && manifest.version !== "1.4.2") {
    fail(`manifest.version must be 1.4.2 for this release, got ${JSON.stringify(manifest.version)}`);
  }

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  if (!readme.includes("1.4.2")) {
    fail("README.md: version hint must mention 1.4.2");
  }

  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  if (!content.includes("Kilocean Translate 1.4.2")) {
    fail("content.js: export generator meta must carry the extension version 1.4.2");
  }
}

function checkSpaNavigationAndSelectionStatics() {
  const raw = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const source = stripCommentsForScan(raw);

  // Selection card persistence: a blank-page/outside press must not dismiss
  // the card — only ×, Escape, or a new selection replacing it may close it.
  const mousedownSrc = extractContentFunction("onSelectionMouseDown");
  if (!mousedownSrc) {
    fail("content.js: cannot extract onSelectionMouseDown for selection-card test");
    return;
  }
  if (/hideSelectionPanel\s*\(/.test(stripCommentsForScan(mousedownSrc))) {
    fail("content.js: onSelectionMouseDown must not hide the selection card (only ×/Escape/new selection close it)");
  }
  if (!/lastSelectionKey\s*=\s*""/.test(stripCommentsForScan(mousedownSrc))) {
    fail("content.js: onSelectionMouseDown must still reset lastSelectionKey for fresh gestures");
  }

  const maybeSrc = extractContentFunction("onSelectionMaybeTranslate");
  if (!maybeSrc) {
    fail("content.js: cannot extract onSelectionMaybeTranslate for selection-card test");
    return;
  }
  if (/hideSelectionPanel\s*\(/.test(stripCommentsForScan(maybeSrc))) {
    fail("content.js: collapsed/empty gesture must keep the selection card open (no hideSelectionPanel in onSelectionMaybeTranslate)");
  }

  // Dismissal surfaces stay intact: × button and Escape still hide the card.
  if (!/key === "Escape"[\s\S]{0,120}hideSelectionPanel\(\)/.test(source)) {
    fail("content.js: Escape must still hide the selection card");
  }
  if (!/querySelector\("\.close"\)[\s\S]{0,240}hideSelectionPanel\(\)/.test(source)) {
    fail("content.js: × close button must still hide the selection card");
  }

  // SPA URL-change handling exists (polling location.href, popstate assist).
  const watchSrc = extractContentFunction("setupSpaNavigationWatch");
  if (!watchSrc) {
    fail("content.js: setupSpaNavigationWatch missing (SPA URL change detection)");
    return;
  }
  if (!/popstate|setInterval/.test(watchSrc)) {
    fail("content.js: setupSpaNavigationWatch must poll location.href (optionally assisted by popstate)");
  }
  const checkSrc = extractContentFunction("checkSpaNavigation");
  if (!checkSrc || !/location\.href/.test(checkSrc) || !/handleSpaNavigation\(\)/.test(checkSrc)) {
    fail("content.js: checkSpaNavigation must compare location.href and route to handleSpaNavigation");
    return;
  }

  // Navigating away mid-translation aborts the old run without counting the
  // aborted requests as failures.
  const navSrc = extractContentFunction("handleSpaNavigation");
  if (!navSrc) {
    fail("content.js: handleSpaNavigation missing (SPA navigation abort + persistence)");
    return;
  }
  for (const needle of ["generation += 1", "workQueue = Promise.resolve()", "scheduleDynamicTranslation"]) {
    if (!navSrc.includes(needle)) {
      fail(`content.js: handleSpaNavigation must contain ${needle} (abort old run, keep session translating)`);
    }
  }
  if (!/state\.active/.test(navSrc)) {
    fail("content.js: handleSpaNavigation must be a no-op for inactive sessions (no auto-translate on fresh tabs/sites)");
  }
  const fallbackSrc = stripCommentsForScan(extractContentFunction("translateBatchWithFallback") || "");
  const staleGuards = (fallbackSrc.match(/runId !== generation/g) || []).length;
  if (staleGuards < 3) {
    fail("content.js: translateBatchWithFallback must keep stale-run guards so aborted requests are never counted as failures");
  }

  // X "Show more": a recorded block whose source text changed must have its
  // companion translation replaced (discard + re-queue), not duplicated —
  // and equivalent-text churn must not re-bill.
  const schedSrc = extractContentFunction("scheduleDynamicTranslation");
  if (!schedSrc) {
    fail("content.js: cannot extract scheduleDynamicTranslation for show-more test");
    return;
  }
  if (!/originalText/.test(schedSrc) || !/discardBlockRecord/.test(schedSrc)) {
    fail("content.js: scheduleDynamicTranslation must compare recorded originalText, then discard + re-queue changed blocks (Show more re-translation)");
  }

  // Same-translation skip at block insertion (no duplicate block when the
  // provider echoes the source).
  if (!/Utils\.isSameTranslation/.test(source)) {
    fail("content.js: block insertion must skip translations equal to their source via Utils.isSameTranslation");
  }
}

function main() {
  console.log("kilocean-translate ci-check");
  console.log(`root: ${ROOT}`);

  checkManifest();

  for (const file of JS_FILES) {
    checkSyntax(file);
    checkStaticBans(file);
  }

  checkSegmentSplitLogic();
  checkParseTranslationPayload();
  checkJoinSplitTranslations();
  checkJoinRawTextNodesNormalize();
  checkXLayoutHeuristics();
  checkXMutationScopeGate();
  checkEnglishProfileDetection();
  checkVersionBump();
  checkSpaNavigationAndSelectionStatics();

  if (errors.length > 0) {
    console.error("\nCI CHECK FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("OK: manifest, permissions, syntax, static bans, segment split logic, parseTranslationPayload, joinSplitTranslations, joinRawTextNodes, X layout heuristics, X mutation scope gate, English profile detection, version bump, SPA navigation + selection card statics");
  process.exit(0);
}

main();
