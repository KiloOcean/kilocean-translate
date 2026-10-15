#!/usr/bin/env node
/**
 * Zero-dependency AI-native CI gate for kilocean-translate.
 * Exit non-zero with clear messages on failure.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // Italian must never be detected as English either: its masculine plural
  // article "i" is spelled exactly like the English pronoun "I", so a lone
  // hit proves nothing ("I problemi sociali" — 1.4.2 QA report).
  assertFalse(looksLikeEnglish("I problemi sociali"), "looksLikeEnglish: 'I problemi sociali' is Italian — single-letter 'I' alone is not English evidence");
  assertFalse(looksLikeEnglish("I problemi sociali continuano"), "looksLikeEnglish: Italian with the ambiguous 'I' article never clears the ratio either");
  assertFalse(looksLikeEnglish("A casa"), "looksLikeEnglish: 'A casa' is Romance — single-letter 'a' alone is not English evidence");
  // Italian function words veto the skip like every other Romance marker:
  // even with real English hits around them ("the team"), one "per"/"che"
  // means the block must keep translating for en.
  assertFalse(looksLikeEnglish("I problemi per the team"), "looksLikeEnglish: an Italian marker ('per') vetoes the skip even beside English hits");
  assertFalse(looksLikeEnglish("Che cosa vuoi fare"), "looksLikeEnglish: Italian sentence with 'che' veto");
  // Short / ambiguous text stays conservative: translate unless clearly English.
  assertFalse(looksLikeEnglish("Home"), "looksLikeEnglish: single noun without function words");
  assertFalse(looksLikeEnglish("Hola mundo"), "looksLikeEnglish: short Spanish");
  assertTrue(looksLikeEnglish("About me"), "looksLikeEnglish: short but clearly English");

  // Ambiguous function words (me/was/on/a/in exist in French/Spanish/German
  // too) must never prove English on their own, and any foreign marker word
  // must veto the shortcut outright (earlier review P1).
  assertFalse(looksLikeEnglish("Me gusta bailar"), "looksLikeEnglish: 'Me gusta bailar' is Spanish, ambiguous 'me' is not English evidence");
  assertFalse(looksLikeEnglish("Was nun"), "looksLikeEnglish: 'Was nun' is German, ambiguous 'was' is not English evidence");
  assertFalse(looksLikeEnglish("On arrive demain matin"), "looksLikeEnglish: 'On arrive demain matin' is French, ambiguous 'on' is not English evidence");
  assertFalse(looksLikeEnglish("On a un plan"), "looksLikeEnglish: 'On a un plan' is French, ambiguous 'on'/'a' plus foreign 'un' must not skip");
  assertFalse(looksLikeEnglish("In Berlin"), "looksLikeEnglish: 'In Berlin' — German-preposition 'in' alone is not English evidence");
  assertFalse(looksLikeEnglish("The team is here but die Leute warten"), "looksLikeEnglish: a single foreign marker ('die') vetoes the skip even when English words outnumber it");
  // Normal English keeps skipping: ambiguous words are simply ignored, the
  // remaining unambiguous hits still carry the sentence.
  assertTrue(looksLikeEnglish("The movie was great"), "looksLikeEnglish: English with ambiguous 'was' still detected");
  assertTrue(looksLikeEnglish("I am so happy about this"), "looksLikeEnglish: English with ambiguous 'a'-word context still detected");
  assertTrue(looksLikeEnglish("We are a small team of makers based in Berlin."), "looksLikeEnglish: English bio with ambiguous 'a'/'in' still detected");
  assertTrue(looksLikeEnglish("Was it good?"), "looksLikeEnglish: short English question with ambiguous 'was' still detected");

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
  assertFalse(
    isAlreadyTargetLanguage("I problemi sociali", "en"),
    "isAlreadyTargetLanguage: Italian translates for en (article 'I' is not the pronoun)"
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

function extractTopLevelFunction(fileRel, name) {
  // Pull a top-level (column 0) function body out of a classic script
  // (popup.js) so unit tests run the shipping implementation without exports.
  const source = fs.readFileSync(path.join(ROOT, fileRel), "utf8");
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  return match ? match[0] : null;
}

async function checkFetchTimeoutCoverage() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for fetch timeout tests: ${error.message}`);
    return;
  }

  const { fetchWithTimeout, isTimeoutError, FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MESSAGE } = utils;
  if (typeof fetchWithTimeout !== "function") {
    fail("shared.js: fetchWithTimeout export missing");
    return;
  }
  if (typeof isTimeoutError !== "function") {
    fail("shared.js: isTimeoutError export missing");
    return;
  }

  // Deadline constants: 30s translation batches (incl. selection), 15s test.
  if (FETCH_TIMEOUT_MS?.translation !== 30000) {
    fail(`fetch timeout: translation deadline must be 30000ms, got ${JSON.stringify(FETCH_TIMEOUT_MS?.translation)}`);
  }
  if (FETCH_TIMEOUT_MS?.connectionTest !== 15000) {
    fail(`fetch timeout: connection test deadline must be 15000ms, got ${JSON.stringify(FETCH_TIMEOUT_MS?.connectionTest)}`);
  }
  if (FETCH_TIMEOUT_MESSAGE !== "请求超时，请检查网络或稍后重试") {
    fail(`fetch timeout: user-facing message must be the exact Chinese timeout hint, got ${JSON.stringify(FETCH_TIMEOUT_MESSAGE)}`);
  }
  if (isTimeoutError(new Error("fetch failed")) || isTimeoutError(null)) {
    fail("isTimeoutError: ordinary errors must not be classified as timeouts");
  }

  // Static: every provider fetch in background.js routes through the timeout
  // helper — no bare fetch( call may remain.
  const background = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  const bareFetches = background.match(/(?<![\w.$])fetch\s*\(/g) || [];
  if (bareFetches.length > 0) {
    fail(`background.js: every provider fetch must go through DeepSeekTranslatorUtils.fetchWithTimeout (found ${bareFetches.length} bare fetch call)`);
  }
  if (!/fetchWithTimeout\s*\(/.test(background)) {
    fail("background.js: provider fetch must call DeepSeekTranslatorUtils.fetchWithTimeout");
  }
  if (!/isTimeoutError\s*\(/.test(background)) {
    fail("background.js: fetch error path must rethrow timeout errors verbatim via DeepSeekTranslatorUtils.isTimeoutError");
  }
  if (!/FETCH_TIMEOUT_MS\.connectionTest/.test(background)) {
    fail("background.js: TEST_CONNECTION must pass the 15s connection-test deadline into translateBatch");
  }
  if (!/FETCH_TIMEOUT_MS\.translation/.test(background)) {
    fail("background.js: translateBatch must default to the 30s translation deadline");
  }

  // Static: the helper's own fetch carries the abort signal and clears its
  // timer when the request settles.
  const shared = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "shared.js"), "utf8"));
  if (!/signal\s*:\s*controller\.signal/.test(shared)) {
    fail("shared.js: fetchWithTimeout must pass controller.signal into fetch");
  }
  if (!/clearTimeout\(/.test(shared)) {
    fail("shared.js: fetchWithTimeout must clear its abort timer");
  }
  if (/Object\.create\(\s*response\s*\)/.test(shared)) {
    fail("shared.js: fetchWithTimeout must not Object.create(response) — native Response getters throw \"Illegal invocation\" when read off a proxy");
  }

  // Static: content.js keeps counting request failures (timeouts included) as
  // state.failed with state.error for popup/toast surfacing — the stale-run
  // (SPA navigation) ignore must stay the only swallow path.
  const content = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"));
  if (!content.includes('new Error(response?.error || "翻译请求失败")')) {
    fail("content.js: TRANSLATE_BATCH error responses must propagate response.error so timeout messages reach state.error");
  }
  if (!/state\.error\s*=\s*error\.message/.test(content)) {
    fail("content.js: request failures must be recorded in state.error for popup/toast surfacing");
  }

  // Functional: a hanging provider fetch must abort after the deadline and
  // reject with the exact Chinese timeout message.
  // Node exits 0 when the event loop drains even with a pending promise, so a
  // helper whose abort path is broken would hang this check into a false
  // pass — race every functional await against a wall-clock watchdog.
  const originalFetch = globalThis.fetch;
  const WATCHDOG_MS = 2000;
  const settleOrFail = (promise, label) => {
    let settled = false;
    let watchdog = null;
    const guarded = promise.finally(() => {
      settled = true;
      if (watchdog !== null) {
        clearTimeout(watchdog);
      }
    });
    return Promise.race([
      guarded,
      new Promise((resolve) => {
        watchdog = setTimeout(() => {
          if (!settled) {
            fail(`fetchWithTimeout: ${label} — no settlement within ${WATCHDOG_MS}ms (abort path broken?)`);
          }
          resolve(undefined);
        }, WATCHDOG_MS);
      })
    ]);
  };
  const hangOnSignal = (signal) => new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      reject(abortError);
    });
  });
  try {
    globalThis.fetch = (url, options = {}) => hangOnSignal(options.signal);
    let hungRejected = false;
    try {
      await settleOrFail(
        fetchWithTimeout("https://api.deepseek.com/chat/completions", { method: "POST" }, 25),
        "hanging fetch must settle"
      );
    } catch (error) {
      hungRejected = true;
      if (error.message !== FETCH_TIMEOUT_MESSAGE) {
        fail(`fetchWithTimeout: hanging fetch must reject with the Chinese timeout message, got ${JSON.stringify(error.message)}`);
      }
      if (!isTimeoutError(error)) {
        fail("fetchWithTimeout: hanging fetch must reject with an error isTimeoutError recognizes");
      }
      if (error.canSplit !== false) {
        fail("fetchWithTimeout: timeout errors must keep canSplit false (bisecting would re-bill a hung endpoint)");
      }
    }
    if (!hungRejected) {
      fail("fetchWithTimeout: hanging fetch must reject after the deadline instead of pending forever");
    }

    // Ordinary network errors pass through unwrapped for caller-side handling.
    const networkError = new TypeError("fetch failed");
    globalThis.fetch = () => Promise.reject(networkError);
    try {
      await settleOrFail(
        fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 25),
        "rejecting fetch must settle"
      );
      fail("fetchWithTimeout: rejecting fetch must propagate the rejection");
    } catch (error) {
      if (isTimeoutError(error)) {
        fail("fetchWithTimeout: non-abort network errors must not be misreported as timeouts");
      }
    }

    // A stalled response body must abort too: the deadline stays armed until
    // the body is consumed.
    let capturedSignal = null;
    globalThis.fetch = (url, options = {}) => {
      capturedSignal = options.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => hangOnSignal(capturedSignal)
      });
    };
    const guarded = await settleOrFail(
      fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 25),
      "headers must arrive for the stalled-body case"
    );
    let bodyRejected = false;
    try {
      await settleOrFail(guarded.text(), "stalled body must settle");
    } catch (error) {
      bodyRejected = true;
      if (error.message !== FETCH_TIMEOUT_MESSAGE) {
        fail(`fetchWithTimeout: stalled body must reject with the Chinese timeout message, got ${JSON.stringify(error.message)}`);
      }
    }
    if (!bodyRejected) {
      fail("fetchWithTimeout: stalled response body must reject after the deadline instead of pending forever");
    }

    // Happy path: a fast response reads through the wrapper untouched.
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{\"translations\":[\"你好\"]}")
    });
    const fast = await settleOrFail(
      fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 25),
      "fast fetch must settle"
    );
    const fastBody = await settleOrFail(fast.text(), "fast body must settle");
    if (fastBody !== "{\"translations\":[\"你好\"]}") {
      fail(`fetchWithTimeout: fast response body must pass through the wrapper, got ${JSON.stringify(fastBody)}`);
    }

    // Regression (1.4.2): wrapping the Response via Object.create(response)
    // made ok/status/statusText/headers throw "Illegal invocation" in Chrome,
    // because those getters require the native receiver. The wrapper must
    // expose plain copied fields and working body readers on a real Response.
    globalThis.fetch = () => Promise.resolve(
      new Response(JSON.stringify({ a: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    const native = await settleOrFail(
      fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 25),
      "native Response fetch must settle"
    );
    if (native.ok !== true) {
      fail(`fetchWithTimeout: wrapper.ok must mirror the native Response, got ${JSON.stringify(native.ok)}`);
    }
    if (native.status !== 201) {
      fail(`fetchWithTimeout: wrapper.status must mirror the native Response, got ${JSON.stringify(native.status)}`);
    }
    if (typeof native.statusText !== "string") {
      fail(`fetchWithTimeout: wrapper.statusText must be read eagerly without Illegal invocation, got ${String(native.statusText)}`);
    }
    const contentType = native.headers?.get?.("Content-Type");
    if (contentType !== "application/json") {
      fail(`fetchWithTimeout: wrapper.headers.get must work on the copied Headers, got ${JSON.stringify(contentType)}`);
    }
    const nativeJson = await settleOrFail(native.json(), "native json() must settle");
    if (JSON.stringify(nativeJson) !== JSON.stringify({ a: 1 })) {
      fail(`fetchWithTimeout: wrapper.json() must parse the native body, got ${JSON.stringify(nativeJson)}`);
    }

    globalThis.fetch = () => Promise.resolve(new Response("hello native body", { status: 200 }));
    const nativeText = await settleOrFail(
      fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 25),
      "native text() fetch must settle"
    );
    const textResult = await settleOrFail(nativeText.text(), "native text() must settle");
    if (textResult !== "hello native body") {
      fail(`fetchWithTimeout: wrapper.text() must read the native body, got ${JSON.stringify(textResult)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Popup path: the verbatim timeout message must survive toFriendlyPageError
  // and the connection-test / page-status errors surface error.message /
  // status.error without rewriting.
  const friendlySrc = extractTopLevelFunction("popup.js", "toFriendlyPageError");
  if (!friendlySrc) {
    fail("popup.js: cannot extract toFriendlyPageError for timeout-message test");
    return;
  }
  let toFriendlyPageError;
  try {
    toFriendlyPageError = new Function(`${friendlySrc}\nreturn toFriendlyPageError;`)();
  } catch (error) {
    fail(`popup.js: toFriendlyPageError is not runnable standalone: ${error.message}`);
    return;
  }
  if (toFriendlyPageError({ message: FETCH_TIMEOUT_MESSAGE }) !== FETCH_TIMEOUT_MESSAGE) {
    fail("popup.js: toFriendlyPageError must surface the timeout message verbatim");
  }
  const popup = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"));
  if (!/setStatus\("连接失败",\s*error\.message/.test(popup)) {
    fail("popup.js: connection-test failure must surface error.message");
  }
  if (!/setStatus\("翻译失败",\s*status\.error/.test(popup)) {
    fail("popup.js: page translation failure must surface status.error");
  }
}

// Build a sandboxed instance of background.js's real provider/request code
// (consts + loadSettings + translateBatch + friendly-error helpers) against
// an injected chrome.storage stub, so functional tests run the shipping
// implementation without a service worker.
function buildBackgroundHarness(utils) {
  const source = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const headEnd = source.indexOf("/** @type {Map");
  const busyMatch = source.match(/^const PROVIDER_BUSY_MESSAGE = "(?:[^"\\]|\\.)*";$/m);
  // Async-aware extractor: extractTopLevelFunction would drop the `async`
  // modifier on translateBatch and leave its awaits invalid.
  const extractFn = (name) => {
    const match = source.match(new RegExp(`(?:async\\s+)?function ${name}\\([\\s\\S]*?\\n\\}`));
    return match ? match[0] : null;
  };
  const fnNames = [
    "translateBatch",
    "getFriendlyApiError",
    "isProviderBusyResponse",
    "getProviderBusyMessage",
    "isContentRunCancelled",
    "createError"
  ];
  const fnBodies = fnNames
    .map(extractFn)
    .filter(Boolean);
  if (headEnd < 0 || !busyMatch || fnBodies.length !== fnNames.length) {
    return null;
  }

  return (storageData) => {
    const chromeStub = {
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...storageData }),
          set: async (updates) => {
            Object.assign(storageData, updates);
          }
        }
      }
    };
    return new Function(
      "chrome",
      "DeepSeekTranslatorUtils",
      "importScripts",
      `${busyMatch[0]}\n${source.slice(0, headEnd)}\n${fnBodies.join("\n\n")}\n` +
        "return { PROVIDERS, DEFAULT_SETTINGS, loadSettings, translateBatch, " +
        "getFriendlyApiError, isProviderBusyResponse, getProviderBusyMessage, isContentRunCancelled, PROVIDER_BUSY_MESSAGE };"
    )(chromeStub, utils, () => {});
  };
}

async function checkModelMigrationAndRetryPolicy() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for model/retry tests: ${error.message}`);
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
  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertInRange = (actual, min, max, label) => {
    if (typeof actual !== "number" || actual < min || actual > max) {
      fail(`${label}: expected a number within [${min}, ${max}], got ${JSON.stringify(actual)}`);
    }
  };

  // ---- DeepSeek model defaults / options / migration (1.4.3 rename) ----
  const {
    DEEPSEEK_MODEL_IDS,
    DEEPSEEK_DEFAULT_MODEL,
    migrateModelName,
    MAX_PROVIDER_RETRIES,
    RETRY_BASE_DELAYS_MS,
    computeRetryDelay,
    isRetryableStatus,
    MAX_INFLIGHT_TRANSLATE_BATCHES
  } = utils;

  assertEqual(DEEPSEEK_MODEL_IDS, ["deepseek-flash", "deepseek-v4-pro"], "DeepSeek model options");
  assertEqual(DEEPSEEK_DEFAULT_MODEL, "deepseek-flash", "DeepSeek default model");
  assertEqual(migrateModelName("deepseek-v4-flash"), "deepseek-flash", "migrateModelName: legacy flash name");
  assertEqual(migrateModelName("deepseek-v4-pro"), "deepseek-v4-pro", "migrateModelName: current name passes through");
  assertEqual(migrateModelName("kimi-k2.6"), "kimi-k2.6", "migrateModelName: non-DeepSeek model passes through");
  assertEqual(migrateModelName(undefined), undefined, "migrateModelName: missing value passes through");

  // The legacy name may live on only inside shared.js's alias map (comments
  // documenting the rename are fine — scan code only).
  const sharedRaw = fs.readFileSync(path.join(ROOT, "shared.js"), "utf8");
  if ((stripCommentsForScan(sharedRaw).match(/deepseek-v4-flash/g) || []).length !== 1) {
    fail("shared.js: deepseek-v4-flash may appear in code only once (the LEGACY_MODEL_ALIASES entry)");
  }
  for (const rel of ["background.js", "content.js", "popup.js", "popup.html"]) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (stripCommentsForScan(raw).includes("deepseek-v4-flash")) {
      fail(`${rel}: legacy model name deepseek-v4-flash must not appear in code (migrate on read instead)`);
    }
  }

  const harness = buildBackgroundHarness(utils);
  if (!harness) {
    fail("background.js: cannot build harness for model/retry functional tests");
    return;
  }

  // background provider table + defaults mirror shared.js exactly.
  const emptyHarness = harness({});
  assertEqual(
    emptyHarness.PROVIDERS.deepseek.models,
    ["deepseek-flash", "deepseek-v4-pro"],
    "background PROVIDERS.deepseek.models"
  );
  assertEqual(emptyHarness.PROVIDERS.deepseek.defaultModel, "deepseek-flash", "background PROVIDERS.deepseek.defaultModel");
  assertEqual(emptyHarness.DEFAULT_SETTINGS.model, "deepseek-flash", "background DEFAULT_SETTINGS.model");

  // loadSettings maps a saved legacy name AND persists the migration.
  const migratedStorage = {
    provider: "deepseek",
    deepseekApiKey: "sk-migration",
    model: "deepseek-v4-flash",
    targetLanguage: "zh-CN",
    displayMode: "bilingual"
  };
  const migratedSettings = await harness(migratedStorage).loadSettings();
  assertEqual(migratedSettings.model, "deepseek-flash", "loadSettings: legacy saved model migrates on read");
  assertEqual(migratedStorage.model, "deepseek-flash", "loadSettings: migrated model persists to chrome.storage");
  const stableStorage = { provider: "deepseek", deepseekApiKey: "sk-x", model: "deepseek-v4-pro" };
  await harness(stableStorage).loadSettings();
  assertEqual(stableStorage.model, "deepseek-v4-pro", "loadSettings: current model names are not rewritten");

  // popup migrateSettings maps the legacy name on read (persist via _didMigrate save).
  const popupSource = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  const popupHead = popupSource.slice(0, popupSource.indexOf("const elements ="));
  const popupMigrateSrc = extractTopLevelFunction("popup.js", "migrateSettings");
  if (!popupHead || !popupMigrateSrc) {
    fail("popup.js: cannot extract migrateSettings for model-migration test");
    return;
  }
  let popupMigrate;
  try {
    popupMigrate = new Function(`${popupHead}\n${popupMigrateSrc}\nreturn migrateSettings;`)();
  } catch (error) {
    fail(`popup.js: migrateSettings is not runnable standalone: ${error.message}`);
    return;
  }
  assertEqual(
    popupMigrate({ model: "deepseek-v4-flash" }).model,
    "deepseek-flash",
    "popup migrateSettings: legacy model maps on read"
  );
  assertTrue(
    popupMigrate({ model: "deepseek-v4-flash" })._didMigrate === true,
    "popup migrateSettings: model migration flags _didMigrate so it persists"
  );
  assertEqual(popupMigrate({}).model, "deepseek-flash", "popup migrateSettings: default is deepseek-flash");
  assertFalse(
    popupMigrate({ model: "deepseek-v4-pro" })._didMigrate === true,
    "popup migrateSettings: current model does not flag _didMigrate"
  );

  // popup.html static options + popup.js PROVIDER_META agree with shared.js.
  const popupHtml = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
  const htmlValues = [...popupHtml.matchAll(/<option value="(deepseek-[^"]+)">/g)].map((m) => m[1]);
  assertEqual(htmlValues, ["deepseek-flash", "deepseek-v4-pro"], "popup.html DeepSeek model options");
  let popupMeta;
  try {
    popupMeta = new Function(`${popupHead}\nreturn PROVIDER_META;`)();
  } catch {
    popupMeta = null;
  }
  if (!popupMeta) {
    fail("popup.js: cannot extract PROVIDER_META for model-options test");
    return;
  }
  assertEqual(
    popupMeta.deepseek.models.map((m) => m.value),
    ["deepseek-flash", "deepseek-v4-pro"],
    "popup PROVIDER_META.deepseek model values"
  );
  assertEqual(popupMeta.deepseek.defaultModel, "deepseek-flash", "popup PROVIDER_META.deepseek.defaultModel");

  // ---- Friendly busy errors (500/502/503 / "too busy" body) ----
  const h = harness({});
  const busyDeepseek = `${h.PROVIDER_BUSY_MESSAGE} 状态：https://status.deepseek.com`;
  assertEqual(
    h.PROVIDER_BUSY_MESSAGE,
    "服务商繁忙或故障，请稍后重试，或在设置里切换到另一服务商",
    "PROVIDER_BUSY_MESSAGE exact text"
  );
  assertTrue(h.isProviderBusyResponse(500, ""), "isProviderBusyResponse: 500");
  assertTrue(h.isProviderBusyResponse(502, ""), "isProviderBusyResponse: 502");
  assertTrue(h.isProviderBusyResponse(503, ""), "isProviderBusyResponse: 503");
  assertFalse(h.isProviderBusyResponse(504, ""), "isProviderBusyResponse: 504 is not the busy message");
  assertFalse(h.isProviderBusyResponse(400, ""), "isProviderBusyResponse: 400 alone");
  assertTrue(
    h.isProviderBusyResponse(400, '{"error":{"message":"The server is too busy"}}'),
    "isProviderBusyResponse: 'too busy' body"
  );
  assertTrue(
    h.isProviderBusyResponse(429, "SERVER IS TOO BUSY"),
    "isProviderBusyResponse: 'too busy' match is case-insensitive"
  );
  assertEqual(h.getProviderBusyMessage("deepseek"), busyDeepseek, "getProviderBusyMessage: DeepSeek appends status link");
  assertEqual(h.getProviderBusyMessage("kimi"), h.PROVIDER_BUSY_MESSAGE, "getProviderBusyMessage: other providers get no link");

  // Popup must surface the busy message verbatim (toFriendlyPageError pass-through).
  const friendlySrc = extractTopLevelFunction("popup.js", "toFriendlyPageError");
  if (!friendlySrc) {
    fail("popup.js: cannot extract toFriendlyPageError for busy-message test");
    return;
  }
  let toFriendlyPageError;
  try {
    toFriendlyPageError = new Function(`${friendlySrc}\nreturn toFriendlyPageError;`)();
  } catch (error) {
    fail(`popup.js: toFriendlyPageError is not runnable standalone: ${error.message}`);
    return;
  }
  if (toFriendlyPageError({ message: busyDeepseek }) !== busyDeepseek) {
    fail("popup.js: toFriendlyPageError must not mangle the provider-busy message");
  }
  if (toFriendlyPageError({ message: h.PROVIDER_BUSY_MESSAGE }) !== h.PROVIDER_BUSY_MESSAGE) {
    fail("popup.js: toFriendlyPageError must not mangle the plain provider-busy message");
  }

  // ---- Retry policy: isRetryableStatus / computeRetryDelay ----
  for (const status of [429, 500, 502, 503, 504]) {
    assertTrue(isRetryableStatus(status), `isRetryableStatus: ${status} retries`);
  }
  for (const status of [400, 401, 403, 404]) {
    assertFalse(isRetryableStatus(status), `isRetryableStatus: ${status} fails fast`);
  }

  assertEqual(MAX_PROVIDER_RETRIES, 2, "retry policy: max 2 retries");
  assertEqual(RETRY_BASE_DELAYS_MS, [1000, 3000], "retry policy: backoff bases 1s / 3s");
  // Jittered ranges: attempt 0 → [800, 1200], attempt 1 → [2400, 3600].
  assertInRange(computeRetryDelay(0, null, () => 0), 800, 800.001, "computeRetryDelay: attempt 0 min");
  assertEqual(computeRetryDelay(0, null, () => 0.5), 1000, "computeRetryDelay: attempt 0 mid");
  assertInRange(computeRetryDelay(0, null, () => 1), 1200, 1200.001, "computeRetryDelay: attempt 0 max");
  assertInRange(computeRetryDelay(1, null, () => 0), 2400, 2400.001, "computeRetryDelay: attempt 1 min");
  assertEqual(computeRetryDelay(1, null, () => 0.5), 3000, "computeRetryDelay: attempt 1 mid");
  assertInRange(computeRetryDelay(1, null, () => 1), 3600, 3600.001, "computeRetryDelay: attempt 1 max");
  assertEqual(computeRetryDelay(9, null, () => 0.5), 3000, "computeRetryDelay: later attempts clamp to last base");
  // Retry-After (delay-seconds) is honored exactly, without jitter, capped at 10s.
  assertEqual(computeRetryDelay(0, "2", () => 1), 2000, "computeRetryDelay: Retry-After seconds honored exactly");
  assertEqual(computeRetryDelay(0, "30", () => 0), 10000, "computeRetryDelay: Retry-After capped at 10s");
  // Retry-After as an HTTP date: future deltas honored, past clamped to 0.
  const nowMs = Date.parse("2026-10-15T00:00:00Z");
  assertEqual(
    computeRetryDelay(0, new Date(nowMs + 5000).toUTCString(), () => 1, nowMs),
    5000,
    "computeRetryDelay: Retry-After HTTP date honored"
  );
  assertEqual(
    computeRetryDelay(0, new Date(nowMs - 5000).toUTCString(), () => 1, nowMs),
    0,
    "computeRetryDelay: past Retry-After date clamps to 0"
  );
  assertEqual(
    computeRetryDelay(0, new Date(nowMs + 60000).toUTCString(), () => 1, nowMs),
    10000,
    "computeRetryDelay: Retry-After HTTP date capped at 10s"
  );
  // Absent / unparseable header falls back to the jittered backoff.
  assertEqual(computeRetryDelay(0, "", () => 0.5), 1000, "computeRetryDelay: empty header falls back to backoff");
  assertEqual(computeRetryDelay(0, "soon", () => 0.5), 1000, "computeRetryDelay: unparseable header falls back to backoff");
  assertEqual(computeRetryDelay(0, undefined, () => 0.5), 1000, "computeRetryDelay: missing header falls back to backoff");

  // ---- Functional retry loop (real translateBatch, fake fetch, zero sleep) ----
  const okBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translations: ["你好"] }) } }]
  });
  const jsonResponse = (status, body, headers = {}) => ({
    ok: status === 200,
    status,
    statusText: "",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    url: "https://api.deepseek.com/chat/completions",
    text: async () => body
  });
  const hangUntilAbort = (url, options = {}) => new Promise((resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      reject(abortError);
    });
  });

  const WATCHDOG_MS = 3000;
  // The watchdog timer must die with the guarded promise: leaving it armed
  // calls fail() 3s after an already-settled request and misreports success
  // runs as timeouts. Clear it from the race promise's finally.
  const withWatchdog = (promise, label) => {
    let watchdog = null;
    const guarded = Promise.resolve(promise).finally(() => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
      }
    });
    return Promise.race([
      guarded,
      new Promise((resolve) => {
        watchdog = setTimeout(() => {
          fail(`translateBatch functional test (${label}): no settlement within ${WATCHDOG_MS}ms`);
          resolve(undefined);
        }, WATCHDOG_MS);
      })
    ]);
  };

  const runTranslate = async (label, storage, handlers, timeoutMs = 30000, extraOptions = {}) => {
    let calls = 0;
    const delays = [];
    // Fake clock: only the recorded (zero-real-delay) backoff sleeps advance
    // it, so total-deadline arithmetic is deterministic regardless of jitter.
    const clock = { now: 0 };
    const queue = [...handlers];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      const handler = queue.length > 1 ? queue.shift() : queue[0];
      return handler(url, options);
    };
    try {
      const result = await withWatchdog(
        harness({ ...storage }).translateBatch(
          ["Hello"],
          "zh-CN",
          undefined,
          undefined,
          timeoutMs,
          {
            sleep: async (ms) => { delays.push(ms); clock.now += ms; },
            now: () => clock.now,
            ...extraOptions
          }
        ),
        label
      );
      return { ok: true, result, calls, delays };
    } catch (error) {
      return { ok: false, error, calls, delays };
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  const deepseekStorage = {
    provider: "deepseek",
    deepseekApiKey: "sk-test",
    kimiApiKey: "sk-kimi",
    model: "deepseek-flash",
    targetLanguage: "zh-CN",
    displayMode: "bilingual"
  };

  // 503, 503, then success → 3 calls total, success, backoff delays in range.
  const recovered = await runTranslate(
    "503x2 then 200",
    deepseekStorage,
    [
      () => jsonResponse(503, '{"error":{"message":"upstream"}}'),
      () => jsonResponse(503, '{"error":{"message":"upstream"}}'),
      () => jsonResponse(200, okBody)
    ]
  );
  if (!recovered.ok) {
    fail(`translateBatch: 503x2 then 200 must succeed, got ${JSON.stringify(recovered.error?.message)}`);
  } else {
    assertEqual(recovered.result, ["你好"], "translateBatch: 503x2 then 200 returns translations");
    assertEqual(recovered.calls, 3, "translateBatch: 503x2 then 200 makes exactly 3 calls");
    assertEqual(recovered.delays.length, 2, "translateBatch: 503x2 then 200 sleeps twice");
    assertInRange(recovered.delays[0], 800, 1200, "translateBatch: first backoff delay ~1s ±20%");
    assertInRange(recovered.delays[1], 2400, 3600, "translateBatch: second backoff delay ~3s ±20%");
  }

  // 401 fails fast: exactly 1 call, friendly key message, no sleep.
  const unauthorized = await runTranslate(
    "401 no retry",
    deepseekStorage,
    [() => jsonResponse(401, '{"error":{"message":"bad key"}}')]
  );
  if (unauthorized.ok) {
    fail("translateBatch: 401 must reject");
  } else {
    assertEqual(unauthorized.calls, 1, "translateBatch: 401 makes exactly 1 call (never retried)");
    assertEqual(unauthorized.error.message, "API Key 无效，请检查后重试", "translateBatch: 401 friendly message");
    assertEqual(unauthorized.delays.length, 0, "translateBatch: 401 never sleeps");
  }

  // Always 503 (DeepSeek) → 3 calls then the busy message with status link.
  const alwaysBusy = await runTranslate(
    "always 503 deepseek",
    deepseekStorage,
    [() => jsonResponse(503, '{"error":{"message":"down"}}')]
  );
  if (alwaysBusy.ok) {
    fail("translateBatch: always-503 must reject");
  } else {
    assertEqual(alwaysBusy.calls, 3, "translateBatch: always-503 stops after 3 calls (max 2 retries)");
    assertEqual(alwaysBusy.error.message, busyDeepseek, "translateBatch: always-503 surfaces the DeepSeek busy message with status link");
  }

  // Always 503 on Kimi → plain busy message, no DeepSeek status link.
  const kimiBusy = await runTranslate(
    "always 503 kimi",
    { ...deepseekStorage, provider: "kimi", model: "kimi-k2.6" },
    [() => jsonResponse(503, '{"error":{"message":"down"}}')]
  );
  if (kimiBusy.ok) {
    fail("translateBatch: kimi always-503 must reject");
  } else {
    assertEqual(kimiBusy.error.message, h.PROVIDER_BUSY_MESSAGE, "translateBatch: kimi busy message carries no DeepSeek status link");
  }

  // 400 whose body says "too busy" → friendly busy message, no retry.
  const busyBody = await runTranslate(
    "400 too-busy body",
    deepseekStorage,
    [() => jsonResponse(400, '{"error":{"message":"The server is too busy, retry later"}}')]
  );
  if (busyBody.ok) {
    fail("translateBatch: 400 too-busy must reject");
  } else {
    assertEqual(busyBody.calls, 1, "translateBatch: 400 is never retried even when the body says too busy");
    assertEqual(busyBody.error.message, busyDeepseek, "translateBatch: too-busy body surfaces the busy message");
  }

  // 429 with Retry-After: 1 → exact 1000ms delay (no jitter), then 503 backoff.
  const rateLimited = await runTranslate(
    "429 Retry-After then 200",
    deepseekStorage,
    [
      () => jsonResponse(429, '{"error":{"message":"rate"}}', { "retry-after": "1" }),
      () => jsonResponse(503, "{}"),
      () => jsonResponse(200, okBody)
    ]
  );
  if (!rateLimited.ok) {
    fail(`translateBatch: 429→503→200 must succeed, got ${JSON.stringify(rateLimited.error?.message)}`);
  } else {
    assertEqual(rateLimited.calls, 3, "translateBatch: 429→503→200 makes 3 calls");
    assertEqual(rateLimited.delays[0], 1000, "translateBatch: Retry-After: 1 honored as exactly 1000ms");
    assertInRange(rateLimited.delays[1], 2400, 3600, "translateBatch: second delay after 503 uses ~3s backoff");
  }

  // Total deadline (P1-1): a hung first attempt burns the whole budget, so
  // the ~1s backoff no longer fits and the call must fail with the verbatim
  // timeout error after exactly one fetch — never a second billable attempt
  // past the deadline.
  const startedHung = Date.now();
  const hungExhausted = await runTranslate(
    "hung fetch exhausts total deadline",
    deepseekStorage,
    [hangUntilAbort],
    25
  );
  const hungElapsed = Date.now() - startedHung;
  if (hungExhausted.ok) {
    fail("translateBatch: hung fetch with an exhausted budget must reject");
  } else {
    assertEqual(hungExhausted.calls, 1, "translateBatch: no retry once the total deadline is spent");
    assertEqual(hungExhausted.delays.length, 0, "translateBatch: budget-exhausted timeout never sleeps out a backoff");
    assertEqual(hungExhausted.error.message, utils.FETCH_TIMEOUT_MESSAGE, "translateBatch: budget exhaustion surfaces the verbatim timeout message");
    if (hungElapsed > 1500) {
      fail(`translateBatch: hung fetch must settle within the deadline budget, took ${hungElapsed}ms`);
    }
  }

  // A hung attempt whose budget still funds the backoff + retry does retry —
  // the timeout branch is exercised by the cancel-during-timeout-backoff
  // test below (cancellation is checked before the budget throw) and the vm
  // hung-fetch test in checkTotalDeadlineBudget.

  // ---- Run cancellation: abandoned generations must stop billing ----
  // Pure lookup: cancel marks "every run ≤ N from this tab is dead".
  assertTrue(!h.isContentRunCancelled(new Map(), 1, 1), "isContentRunCancelled: empty map cancels nothing");
  const cancelMap = new Map([[7, 5]]);
  assertTrue(h.isContentRunCancelled(cancelMap, 7, 5), "isContentRunCancelled: run equal to cancelled generation is cancelled");
  assertTrue(h.isContentRunCancelled(cancelMap, 7, 4), "isContentRunCancelled: older run is cancelled");
  assertFalse(h.isContentRunCancelled(cancelMap, 7, 6), "isContentRunCancelled: newer run survives");
  assertFalse(h.isContentRunCancelled(cancelMap, 8, 4), "isContentRunCancelled: other tab unaffected");
  assertFalse(h.isContentRunCancelled(cancelMap, null, 4), "isContentRunCancelled: missing tab never cancels");
  assertFalse(h.isContentRunCancelled(cancelMap, 7, null), "isContentRunCancelled: missing runId never cancels");

  // Cancelled before the first attempt: zero provider calls, RUN_CANCELLED.
  const preCancelled = await runTranslate(
    "pre-cancelled",
    deepseekStorage,
    [() => jsonResponse(200, okBody)],
    1000,
    { isCancelled: () => true }
  );
  if (preCancelled.ok) {
    fail("translateBatch: pre-cancelled run must reject");
  } else {
    assertEqual(preCancelled.calls, 0, "translateBatch: pre-cancelled run makes no provider call");
    assertEqual(preCancelled.error.code, "RUN_CANCELLED", "translateBatch: cancelled run rejects with RUN_CANCELLED");
  }

  // Cancel lands during the 503 backoff sleep: exactly 1 call, no retry.
  let cancelAfterFirstCall = false;
  const cancelledMidBackoff = await runTranslate(
    "cancel during backoff",
    deepseekStorage,
    [() => {
      cancelAfterFirstCall = true;
      return jsonResponse(503, '{"error":{"message":"down"}}');
    }],
    30000,
    { isCancelled: () => cancelAfterFirstCall }
  );
  if (cancelledMidBackoff.ok) {
    fail("translateBatch: backoff-cancelled run must reject");
  } else {
    assertEqual(cancelledMidBackoff.calls, 1, "translateBatch: cancellation during backoff stops before the retry");
    assertEqual(cancelledMidBackoff.delays.length, 1, "translateBatch: backoff sleep happened but no further attempt followed");
    assertEqual(cancelledMidBackoff.error.code, "RUN_CANCELLED", "translateBatch: backoff-cancelled run rejects with RUN_CANCELLED");
  }

  // Cancel lands during a timeout-retry sleep: the re-armed attempt never fires.
  let cancelOnAbort = false;
  const cancelledTimeoutRetry = await runTranslate(
    "cancel during timeout backoff",
    deepseekStorage,
    [(url, options) => {
      options.signal?.addEventListener("abort", () => {
        cancelOnAbort = true;
      });
      return hangUntilAbort(url, options);
    }],
    25,
    { isCancelled: () => cancelOnAbort }
  );
  if (cancelledTimeoutRetry.ok) {
    fail("translateBatch: timeout-backoff-cancelled run must reject");
  } else {
    assertEqual(cancelledTimeoutRetry.calls, 1, "translateBatch: cancellation during timeout backoff stops before the retry");
    assertEqual(cancelledTimeoutRetry.error.code, "RUN_CANCELLED", "translateBatch: timeout-backoff-cancelled run rejects with RUN_CANCELLED");
  }

  // Uncancelled runs keep retrying normally (isCancelled default is inert).
  const neverCancelled = await runTranslate(
    "503 then 200 without cancellation",
    deepseekStorage,
    [() => jsonResponse(503, "{}"), () => jsonResponse(200, okBody)]
  );
  if (!neverCancelled.ok) {
    fail(`translateBatch: retry must work untouched without cancellation, got ${JSON.stringify(neverCancelled.error?.message)}`);
  } else {
    assertEqual(neverCancelled.calls, 2, "translateBatch: uncalled isCancelled keeps the retry loop intact");
  }

  // ---- Whole-page translation concurrency cap ----
  assertTrue(
    MAX_INFLIGHT_TRANSLATE_BATCHES <= 3,
    `concurrency cap: MAX_INFLIGHT_TRANSLATE_BATCHES must be <= 3, got ${JSON.stringify(MAX_INFLIGHT_TRANSLATE_BATCHES)}`
  );
  const contentRaw = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const contentScan = stripCommentsForScan(contentRaw);
  if (/Promise\.all/.test(contentScan)) {
    fail("content.js: TRANSLATE_BATCH requests must not be fired with Promise.all (unbounded batch concurrency)");
  }
  if (!/for \(const batch of batches\) \{[\s\S]{0,400}?await translateBatchWithFallback\(/.test(contentRaw)) {
    fail("content.js: batch loop must await translateBatchWithFallback sequentially (≤ MAX_INFLIGHT_TRANSLATE_BATCHES in flight)");
  }
}

async function checkInflightCapAndRunCancellation() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for inflight-cap tests: ${error.message}`);
    return;
  }

  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (actual, label) => {
    if (actual !== true) {
      fail(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
  };

  // ---- Functional: the cross-generation in-flight slot limiter ----
  const acquireSrc = extractContentFunction("acquireInflightTranslateSlot");
  const releaseSrc = extractContentFunction("releaseInflightTranslateSlot");
  if (!acquireSrc || !releaseSrc) {
    fail("content.js: cannot extract acquire/releaseInflightTranslateSlot for inflight-cap test");
    return;
  }
  let slots;
  try {
    slots = new Function("Utils", `
      let generation = 1;
      let inflightTranslateBatches = 0;
      const inflightTranslateWaiters = [];
      ${acquireSrc}
      ${releaseSrc}
      return {
        acquire: acquireInflightTranslateSlot,
        release: releaseInflightTranslateSlot,
        bumpGeneration: () => { generation += 1; },
        inflight: () => inflightTranslateBatches,
        waiting: () => inflightTranslateWaiters.length
      };
    `)(utils);
  } catch (error) {
    fail(`content.js: slot limiter is not runnable standalone: ${error.message}`);
    return;
  }

  // Up to MAX_INFLIGHT_TRANSLATE_BATCHES slots grant immediately.
  assertTrue(await slots.acquire(1), "inflight cap: first slot granted");
  assertTrue(await slots.acquire(1), "inflight cap: second slot granted");
  assertTrue(await slots.acquire(1), "inflight cap: third slot granted");
  assertEqual(slots.inflight(), utils.MAX_INFLIGHT_TRANSLATE_BATCHES, "inflight cap: cap reached");
  // The next acquire queues instead of breaching the cap.
  let fourthValue = null;
  const fourth = slots.acquire(1).then((value) => { fourthValue = value; });
  assertEqual(slots.waiting(), 1, "inflight cap: fourth acquire waits");
  // Release hands the slot to the waiter without decrementing the count.
  slots.release();
  await fourth;
  assertTrue(fourthValue, "inflight cap: waiter receives the handed-off slot");
  assertEqual(slots.inflight(), utils.MAX_INFLIGHT_TRANSLATE_BATCHES, "inflight cap: hand-off keeps the count");
  // A generation bump does not clear the count; a stale waiter resolves false
  // (no request sent for a dead run) and the slot keeps flowing.
  slots.bumpGeneration();
  let fifthValue = null;
  const fifth = slots.acquire(1).then((value) => { fifthValue = value; });
  slots.release();
  await fifth;
  assertTrue(fifthValue === false, "inflight cap: stale-generation waiter resolves false (run abandoned)");
  assertEqual(slots.inflight(), utils.MAX_INFLIGHT_TRANSLATE_BATCHES, "inflight cap: navigation bump never zeroes the count");
  // Full drain returns to zero with no leaked waiters.
  slots.release();
  slots.release();
  slots.release();
  assertEqual(slots.inflight(), 0, "inflight cap: releasing every holder drains to zero");
  assertEqual(slots.waiting(), 0, "inflight cap: no leaked waiters after drain");

  // ---- Static: content.js wiring ----
  const contentRaw = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const content = stripCommentsForScan(contentRaw);
  const requestSrc = extractContentFunction("requestSegmentTranslations");
  if (!requestSrc) {
    fail("content.js: cannot extract requestSegmentTranslations for inflight-cap test");
    return;
  }
  if (!/acquireInflightTranslateSlot\(/.test(requestSrc) || !/releaseInflightTranslateSlot\(\)/.test(requestSrc)) {
    fail("content.js: requestSegmentTranslations must hold an in-flight slot around every TRANSLATE_BATCH send");
  }
  if (!/type:\s*"TRANSLATE_BATCH"[\s\S]{0,200}runId/.test(requestSrc)) {
    fail("content.js: TRANSLATE_BATCH payload must carry runId so the worker can match CANCEL_TRANSLATE_BATCHES");
  }
  if (!/CANCEL_TRANSLATE_BATCHES/.test(content)) {
    fail("content.js: run abandonment must notify the worker via CANCEL_TRANSLATE_BATCHES");
  }
  for (const name of ["startTranslation", "restoreOriginal", "handleSpaNavigation"]) {
    const src = extractContentFunction(name);
    if (!src) {
      fail(`content.js: cannot extract ${name} for inflight-cap test`);
      continue;
    }
    if (!/cancelAbandonedRunBatches\(/.test(src)) {
      fail(`content.js: ${name} bumps the generation — it must also cancel the abandoned run's batches`);
    }
    if (/inflightTranslateBatches/.test(stripCommentsForScan(src))) {
      fail(`content.js: ${name} must not touch the in-flight slot counters (the cap is shared across generations)`);
    }
  }
  const resets = (content.match(/inflightTranslateBatches\s*=\s*0/g) || []).length;
  if (resets !== 1) {
    fail(`content.js: inflightTranslateBatches may be zeroed only in its declaration, found ${resets} assignments`);
  }

  // ---- Static: background.js wiring ----
  const background = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  if (!/CANCEL_TRANSLATE_BATCHES/.test(background)) {
    fail("background.js: must handle CANCEL_TRANSLATE_BATCHES so abandoned runs stop billing");
  }
  if (!/isCancelled:\s*\(\)\s*=>\s*isContentRunCancelled\(/.test(background)) {
    fail("background.js: TRANSLATE_BATCH must poll isContentRunCancelled so retries stop for abandoned runs");
  }
  if (!/RUN_CANCELLED/.test(background)) {
    fail("background.js: cancelled runs must surface a RUN_CANCELLED error code");
  }
}

async function checkSpaRefreshAndSelectionLifecycle() {
  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

  // ---- (4a) Hash-only URL changes are not SPA navigation ----
  const spaUrlSrc = extractContentFunction("spaNavigationUrl");
  const checkSrc = extractContentFunction("checkSpaNavigation");
  if (!spaUrlSrc || !checkSrc) {
    fail("content.js: cannot extract spaNavigationUrl / checkSpaNavigation for hash test");
    return;
  }
  const location = { href: "https://x.com/home" };
  let navigations = 0;
  let checkSpaNavigation;
  try {
    checkSpaNavigation = new Function(
      "location",
      "handleSpaNavigation",
      `let lastSeenUrl = location.href;\n${spaUrlSrc}\n${checkSrc}\nreturn checkSpaNavigation;`
    )(location, () => { navigations += 1; });
  } catch (error) {
    fail(`content.js: checkSpaNavigation is not runnable standalone: ${error.message}`);
    return;
  }
  location.href = "https://x.com/home#feed";
  checkSpaNavigation();
  assertEqual(navigations, 0, "SPA navigation: hash-only change must not navigate");
  location.href = "https://x.com/home#about";
  checkSpaNavigation();
  assertEqual(navigations, 0, "SPA navigation: hash-to-hash change must not navigate");
  location.href = "https://x.com/explore";
  checkSpaNavigation();
  assertEqual(navigations, 1, "SPA navigation: real path change navigates");
  location.href = "https://x.com/explore#top";
  checkSpaNavigation();
  assertEqual(navigations, 1, "SPA navigation: hash appended to new path does not re-navigate");
  location.href = "https://x.com/home";
  checkSpaNavigation();
  assertEqual(navigations, 2, "SPA navigation: returning to a previous path navigates");

  // ---- (4b) Navigation keeps still-connected pendingRefreshBlocks ----
  const navSrc = extractContentFunction("handleSpaNavigation");
  if (!navSrc) {
    fail("content.js: cannot extract handleSpaNavigation for refresh-pending test");
    return;
  }
  if (/pendingRefreshBlocks\.clear\(\)/.test(navSrc)) {
    fail("content.js: handleSpaNavigation must not clear pendingRefreshBlocks wholesale — keep connected blocks for the scheduled flush");
  }
  if (!/pendingRefreshBlocks/.test(navSrc) || !/isConnected/.test(navSrc)) {
    fail("content.js: handleSpaNavigation must prune only disconnected pendingRefreshBlocks entries");
  }

  // ---- (5) Echo-skip cache: block + source text + run settings ----
  const skippedSrc = extractContentFunction("isSkippedEchoBlock");
  if (!skippedSrc) {
    fail("content.js: cannot extract isSkippedEchoBlock for echo-cache test");
    return;
  }
  const skippedEchoBlocks = new WeakMap();
  let settings = { provider: "deepseek", targetLanguage: "en", model: "deepseek-flash" };
  let isSkippedEchoBlock;
  try {
    isSkippedEchoBlock = new Function(
      "skippedEchoBlocks",
      "getRunSettings",
      `${skippedSrc}\nreturn isSkippedEchoBlock;`
    )(skippedEchoBlocks, () => settings);
  } catch (error) {
    fail(`content.js: isSkippedEchoBlock is not runnable standalone: ${error.message}`);
    return;
  }
  const blockA = {};
  assertFalse(isSkippedEchoBlock(blockA, "Hello world"), "echo cache: unknown block translates");
  assertFalse(isSkippedEchoBlock(undefined, "Hello world"), "echo cache: missing block never skips");
  skippedEchoBlocks.set(blockA, { text: "Hello world", ...settings });
  assertTrue(isSkippedEchoBlock(blockA, "Hello world"), "echo cache: same block + text + settings skips");
  assertFalse(isSkippedEchoBlock(blockA, "Hello world again"), "echo cache: changed source text invalidates the skip");
  settings = { ...settings, model: "deepseek-v4-pro" };
  assertFalse(isSkippedEchoBlock(blockA, "Hello world"), "echo cache: changed model invalidates the skip");
  settings = { provider: "kimi", targetLanguage: "en", model: "kimi-k2.6" };
  assertFalse(isSkippedEchoBlock(blockA, "Hello world"), "echo cache: changed provider/target invalidates the skip");

  const contentRaw = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const content = stripCommentsForScan(contentRaw);
  const applySrc = stripCommentsForScan(extractContentFunction("applyTranslatedSegment") || "");
  if (!/skippedEchoBlocks\.set\(/.test(applySrc)) {
    fail("content.js: applyTranslatedSegment must record echo skips in skippedEchoBlocks (else every rescan re-bills)");
  }
  if (!/isSkippedEchoBlock\(/.test(stripCommentsForScan(extractContentFunction("shouldTranslateBlockText") || ""))) {
    fail("content.js: shouldTranslateBlockText must consult the echo-skip cache");
  }
  if (!/shouldTranslateBlockText\(fullText, targetLanguage, block\)/.test(content) ||
      !/shouldTranslateBlockText\(text, runSettings\.targetLanguage, block\)/.test(content)) {
    fail("content.js: collectBlocks and translateBlocks must pass the block into shouldTranslateBlockText");
  }

  // ---- (6a) hasHiddenAncestor ignores our own display:none original wraps ----
  const ownedSrc = extractContentFunction("isOwnedOriginalWrap");
  const hiddenSrc = extractContentFunction("isHiddenElement");
  const hasHiddenSrc = extractContentFunction("hasHiddenAncestor");
  if (!ownedSrc || !hiddenSrc || !hasHiddenSrc) {
    fail("content.js: cannot extract hidden-ancestor helpers for refresh-compare test");
    return;
  }
  let hasHiddenAncestor;
  try {
    hasHiddenAncestor = new Function(
      "getComputedStyle",
      `${ownedSrc}\n${hiddenSrc}\n${hasHiddenSrc}\nreturn hasHiddenAncestor;`
    )((el) => ({ display: el.__display, visibility: el.__visibility || "visible" }));
  } catch (error) {
    fail(`content.js: hasHiddenAncestor is not runnable standalone: ${error.message}`);
    return;
  }
  const plain = { __display: "block", parentElement: null, hasAttribute: () => false };
  const wrap = { __display: "none", parentElement: plain, hasAttribute: (name) => name === "data-kilocean-original-wrap" };
  const hiddenSpan = { __display: "none", parentElement: plain, hasAttribute: () => false };
  const visibleWrapInHiddenSection = {
    __display: "contents",
    parentElement: { __display: "none", parentElement: null, hasAttribute: () => false },
    hasAttribute: (name) => name === "data-kilocean-original-wrap"
  };
  assertFalse(
    hasHiddenAncestor({ parentElement: wrap }),
    "refresh compare: translation-only hidden original wrap must not blind the text"
  );
  assertTrue(
    hasHiddenAncestor({ parentElement: hiddenSpan }),
    "refresh compare: page-owned hidden span still hides its text"
  );
  assertTrue(
    hasHiddenAncestor({ parentElement: visibleWrapInHiddenSection }),
    "refresh compare: page-hidden ancestor above the wrap still hides its text"
  );
  assertFalse(
    hasHiddenAncestor({ parentElement: { __display: "block", parentElement: null, hasAttribute: () => false } }),
    "refresh compare: fully visible chain stays visible"
  );

  // ---- (6b) repairBlockRecordDom rebuilds owned DOM without re-billing ----
  const repairSrc = extractContentFunction("repairBlockRecordDom");
  if (!repairSrc) {
    fail("content.js: cannot extract repairBlockRecordDom for rebuild test");
    return;
  }
  let wrapCalls = 0;
  let relocateCalls = 0;
  let repairBlockRecordDom;
  try {
    repairBlockRecordDom = new Function(
      "beginApplyingDom",
      "endApplyingDom",
      "wrapTextNodesForToggle",
      "relocateAfterHostCompanion",
      `${repairSrc}\nreturn repairBlockRecordDom;`
    )(
      () => 0,
      () => {},
      () => {
        wrapCalls += 1;
        return { firstWrap: { rebuilt: 1 }, wraps: [{ rebuilt: 1 }, { rebuilt: 2 }] };
      },
      (record) => {
        relocateCalls += 1;
        record.relocated = true;
      }
    );
  } catch (error) {
    fail(`content.js: repairBlockRecordDom is not runnable standalone: ${error.message}`);
    return;
  }
  const makeBlock = () => {
    const block = {
      isConnected: true,
      appended: null,
      appendChild(node) {
        this.appended = node;
      }
    };
    return block;
  };
  const swappedRecord = {
    block: makeBlock(),
    wraps: [{ isConnected: true }, { isConnected: false }],
    companion: { isConnected: false },
    layout: "companion",
    nested: []
  };
  repairBlockRecordDom(swappedRecord);
  assertEqual(wrapCalls, 1, "repair: swapped wraps are rebuilt via wrapTextNodesForToggle");
  assertEqual(swappedRecord.wraps.length, 2, "repair: record references the rebuilt wraps");
  assertEqual(swappedRecord.block.appended, swappedRecord.companion, "repair: detached companion is re-inserted from the cache");
  assertEqual(relocateCalls, 0, "repair: non-after layouts re-insert into the block");
  const intactRecord = {
    block: makeBlock(),
    wraps: [{ isConnected: true }],
    companion: { isConnected: true },
    layout: "flow",
    nested: []
  };
  repairBlockRecordDom(intactRecord);
  assertEqual(wrapCalls, 1, "repair: intact wraps are left alone");
  assertEqual(intactRecord.block.appended, null, "repair: connected companion is not re-inserted");
  const afterRecord = {
    block: makeBlock(),
    wraps: [{ isConnected: true }],
    companion: { isConnected: false },
    layout: "after",
    nested: []
  };
  repairBlockRecordDom(afterRecord);
  assertEqual(relocateCalls, 1, "repair: after-host companions relocate back after the host");
  assertEqual(afterRecord.block.appended, null, "repair: after-host companions are not appended into the block");
  assertTrue(afterRecord.relocated === true, "repair: relocation received the record");
  if (/requestSegmentTranslations|translateBatchWithFallback/.test(repairSrc)) {
    fail("content.js: repairBlockRecordDom must never issue a new translation request");
  }

  // scheduleDynamicTranslation: unchanged source → repair; changed → discard.
  const schedSrc = extractContentFunction("scheduleDynamicTranslation");
  if (!schedSrc) {
    fail("content.js: cannot extract scheduleDynamicTranslation for refresh test");
    return;
  }
  const schedOrder = stripCommentsForScan(schedSrc);
  const repairAt = schedOrder.indexOf("repairBlockRecordDom(");
  const compareAt = schedOrder.indexOf("extractBlockText(block) === record.originalText");
  const discardAt = schedOrder.indexOf("discardBlockRecord(");
  if (repairAt < 0 || compareAt < 0 || discardAt < 0 || compareAt > repairAt || compareAt > discardAt) {
    fail("content.js: refresh flush must compare extractBlockText to the recorded original first, then repair (unchanged) or discard (changed)");
  }

  // ---- (7) Confirmed selection survives a collapse (blank click) ----
  const maybeSrc = stripCommentsForScan(extractContentFunction("onSelectionMaybeTranslate") || "");
  if (!/if \(snapshot\)\s*\{\s*selectionGeneration \+= 1/.test(maybeSrc)) {
    fail("content.js: only a NEW non-empty selection may bump selectionGeneration (collapse must not strand the confirmed card at loading)");
  }
  const sendSrc = stripCommentsForScan(extractContentFunction("sendSelectionTranslation") || "");
  if (/收起，译文已丢弃/.test(sendSrc)) {
    fail("content.js: a collapsed selection after confirm must not discard the billed translation");
  }
  if (!/selectionGone/.test(sendSrc) || !/postNetworkText !== gesture\.text/.test(sendSrc)) {
    fail("content.js: post-network revalidation must guard text/range changes behind a non-collapsed selection");
  }
  if (!/requestId !== selectionGeneration/.test(sendSrc)) {
    fail("content.js: close/new-selection race protection (requestId vs generation) must stay");
  }
  const hideSrc = stripCommentsForScan(extractContentFunction("hideSelectionPanel") || "");
  if (!/selectionGeneration \+= 1/.test(hideSrc)) {
    fail("content.js: hiding the panel must keep bumping selectionGeneration (explicit close still cancels)");
  }
}

// ---- P1-1: total deadline budget ----
async function checkTotalDeadlineBudget() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for deadline-budget tests: ${error.message}`);
    return;
  }
  const {
    canRetryWithinBudget,
    MIN_ATTEMPT_BUDGET_MS,
    createFetchTimeoutError,
    isTimeoutError,
    FETCH_TIMEOUT_MESSAGE
  } = utils;

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
  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  if (typeof canRetryWithinBudget !== "function") {
    fail("shared.js: canRetryWithinBudget export missing (total-deadline helper)");
    return;
  }
  if (MIN_ATTEMPT_BUDGET_MS !== 1000) {
    fail(`deadline budget: MIN_ATTEMPT_BUDGET_MS must be 1000ms, got ${JSON.stringify(MIN_ATTEMPT_BUDGET_MS)}`);
  }

  // Pure budget arithmetic: a wait is affordable only when it leaves
  // MIN_ATTEMPT_BUDGET_MS of the deadline for the next attempt.
  const at = (ms) => () => ms;
  assertFalse(canRetryWithinBudget(0, 1000, at(500)), "canRetryWithinBudget: 500ms left cannot fund a 1000ms-minimum attempt");
  assertTrue(canRetryWithinBudget(0, 1500, at(500)), "canRetryWithinBudget: exactly the minimum headroom fits");
  assertTrue(canRetryWithinBudget(4000, 15000, at(0)), "canRetryWithinBudget: 4s wait inside a fresh 15s budget");
  assertFalse(canRetryWithinBudget(10000, 15000, at(5000)), "canRetryWithinBudget: 10s wait + minimum exceeds 10s left");
  assertTrue(canRetryWithinBudget(1e9, Infinity, at(12345)), "canRetryWithinBudget: no deadline always fits");

  const timeoutError = createFetchTimeoutError();
  if (!isTimeoutError(timeoutError) || timeoutError.message !== FETCH_TIMEOUT_MESSAGE || timeoutError.canSplit !== false) {
    fail("createFetchTimeoutError: must produce the recognizable verbatim timeout error");
  }

  // Functional: the shipping translateBatch honors the total budget.
  const harness = buildBackgroundHarness(utils);
  if (!harness) {
    fail("background.js: cannot build harness for deadline-budget functional tests");
    return;
  }

  const okBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translations: ["你好"] }) } }]
  });
  const jsonResponse = (status, body, headers = {}) => ({
    ok: status === 200,
    status,
    statusText: "",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    url: "https://api.deepseek.com/chat/completions",
    text: async () => body
  });
  const deepseekStorage = {
    provider: "deepseek",
    deepseekApiKey: "sk-deadline",
    model: "deepseek-flash",
    targetLanguage: "zh-CN",
    displayMode: "bilingual"
  };
  const runWithClock = async (handlers, timeoutMs) => {
    let calls = 0;
    const delays = [];
    const clock = { now: 0 };
    const queue = [...handlers];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      return (queue.length > 1 ? queue.shift() : queue[0])(url, options);
    };
    try {
      const result = await Promise.race([
        harness({ ...deepseekStorage }).translateBatch(
          ["Hello"],
          "zh-CN",
          undefined,
          undefined,
          timeoutMs,
          { sleep: async (ms) => { delays.push(ms); clock.now += ms; }, now: () => clock.now }
        ),
        new Promise((resolve) => setTimeout(() => {
          fail("deadline-budget functional test: no settlement within 3000ms");
          resolve(undefined);
        }, 3000))
      ]);
      return { ok: true, result, calls, delays };
    } catch (error) {
      return { ok: false, error, calls, delays };
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  // Retry-After larger than the whole budget: never waited out, exactly one
  // call, friendly rate-limit message (not the timeout hint).
  const hugeRetryAfter = await runWithClock(
    [() => jsonResponse(429, '{"error":{"message":"rate"}}', { "retry-after": "30" })],
    2000
  );
  if (hugeRetryAfter.ok) {
    fail("translateBatch: 429 with an unaffordable Retry-After must reject");
  } else {
    assertEqual(hugeRetryAfter.calls, 1, "translateBatch: unaffordable Retry-After makes no second call");
    assertEqual(hugeRetryAfter.delays.length, 0, "translateBatch: unaffordable Retry-After is never slept out");
    assertEqual(hugeRetryAfter.error.message, "DeepSeek 请求过于频繁，请稍后重试", "translateBatch: unaffordable Retry-After surfaces the friendly 429 message");
  }

  // Budget exhausts mid 5xx cycle: first backoff fits, the second cannot, so
  // the call stops after 2 calls with the busy message instead of sleeping
  // past the deadline.
  const exhaustedMidCycle = await runWithClock(
    [() => jsonResponse(503, '{"error":{"message":"down"}}'), () => jsonResponse(503, '{"error":{"down"}}')],
    2500
  );
  if (exhaustedMidCycle.ok) {
    fail("translateBatch: budget exhausted mid-5xx-cycle must reject");
  } else {
    assertEqual(exhaustedMidCycle.calls, 2, "translateBatch: second 5xx backoff that no longer fits stops the cycle");
    assertEqual(exhaustedMidCycle.delays.length, 1, "translateBatch: only the affordable backoff was slept");
    assertEqual(
      exhaustedMidCycle.error.message,
      "服务商繁忙或故障，请稍后重试，或在设置里切换到另一服务商 状态：https://status.deepseek.com",
      "translateBatch: budget exhaustion after 5xx surfaces the busy message"
    );
  }

  // Sanity: a generous budget keeps the retry cycle intact (503, 503 → 200).
  const recovered = await runWithClock(
    [
      () => jsonResponse(503, "{}"),
      () => jsonResponse(503, "{}"),
      () => jsonResponse(200, okBody)
    ],
    30000
  );
  if (!recovered.ok) {
    fail(`translateBatch: generous budget must keep retries working, got ${JSON.stringify(recovered.error?.message)}`);
  } else {
    assertEqual(recovered.calls, 3, "translateBatch: generous budget retries both times");
  }

  // Static: every attempt passes its remaining budget (not the fixed timeout)
  // into fetchWithTimeout, and the loop consults canRetryWithinBudget.
  const background = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  if (!/Math\.max\(deadline - now\(\),\s*1\)/.test(background)) {
    fail("background.js: each attempt must pass its remaining deadline budget into fetchWithTimeout");
  }
  if (!/canRetryWithinBudget\(/.test(background)) {
    fail("background.js: the retry loop must gate waits on DeepSeekTranslatorUtils.canRetryWithinBudget");
  }
  if ((background.match(/canRetryWithinBudget\(/g) || []).length < 3) {
    fail("background.js: canRetryWithinBudget must gate pre-attempt budget, status backoff and timeout backoff");
  }
}

// ---- P1-2: per-tab concurrency + navigation/tab-close cancellation ----
// Load the REAL background.js + shared.js into a node:vm context with a
// stubbed chrome API and fetch so the tests drive the shipping wiring
// (listener registration, slot gate, abort plumbing).
function buildBackgroundVm({ storageData = {}, fetchImpl, setTimeoutImpl = setTimeout } = {}) {
  const backgroundSource = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const sharedSource = fs.readFileSync(path.join(ROOT, "shared.js"), "utf8");
  const listeners = { installed: [], message: [], tabsUpdated: [], tabsRemoved: [] };
  const storage = { ...storageData };
  const extensionId = "ci-test-extension-id";
  const chromeStub = {
    runtime: {
      id: extensionId,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) }
    },
    tabs: {
      onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabsUpdated.push(fn) }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (updates) => { Object.assign(storage, updates); }
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    }
  };
  const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout: setTimeoutImpl,
    clearTimeout,
    AbortController,
    fetch: fetchImpl
  };
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (file) => {
    vm.runInContext(
      file === "shared.js" ? sharedSource : fs.readFileSync(path.join(ROOT, file), "utf8"),
      context,
      { filename: file }
    );
  };
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  if (listeners.message.length !== 1) {
    throw new Error(`background.js must register exactly one runtime.onMessage listener, got ${listeners.message.length}`);
  }
  if (listeners.tabsUpdated.length !== 1 || listeners.tabsRemoved.length !== 1) {
    throw new Error("background.js must register one tabs.onUpdated and one tabs.onRemoved listener");
  }

  return {
    listeners,
    extensionId,
    sendMessage: (message, tabId) => new Promise((resolve) => {
      let settled = false;
      const respond = (response) => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      };
      try {
        const keepOpen = listeners.message[0](
          message,
          { id: extensionId, tab: { id: tabId } },
          respond
        );
        if (keepOpen !== true && !settled) {
          respond({ ok: false, error: "handler did not keep the message channel open" });
        }
      } catch (error) {
        respond({ ok: false, error: `handler threw: ${error.message}` });
      }
    })
  };
}

// Deferred fetch stub: the test decides when each request settles; a caller
// abort rejects like a real fetch. Tracks concurrency for cap assertions.
const makeDeferredFetch = () => {
  const state = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const pending = [];
  const fetchImpl = (url, options = {}) => {
    state.calls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        state.inFlight -= 1;
        fn(value);
      };
      entry.resolve = (value) => settle(resolve, value);
      entry.reject = (value) => settle(reject, value);
    });
    options.signal?.addEventListener("abort", () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      entry.reject(abortError);
    });
    pending.push(entry);
    return entry.promise;
  };
  return { state, pending, fetchImpl };
};

async function checkTabConcurrencyAndNavigationCancel() {
  const require = createRequire(import.meta.url);
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for tab-concurrency tests: ${error.message}`);
    return;
  }
  const MAX = utils.MAX_INFLIGHT_TRANSLATE_BATCHES;

  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  const vmOkBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translations: ["你好"] }) } }]
  });
  const vmJsonResponse = (status, body, headers = {}) => ({
    ok: status === 200,
    status,
    statusText: "",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    url: "https://api.deepseek.com/chat/completions",
    text: async () => body
  });
  const vmStorage = {
    provider: "deepseek",
    deepseekApiKey: "sk-vm",
    model: "deepseek-flash",
    targetLanguage: "zh-CN",
    displayMode: "bilingual"
  };
  const batchMessage = (texts) => ({
    type: "TRANSLATE_BATCH",
    texts,
    runId: 1,
    provider: "deepseek",
    targetLanguage: "zh-CN",
    model: "deepseek-flash"
  });
  const tick = async (rounds = 10) => {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const withTimeout = (promise, label, ms = 2000) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => {
      fail(`tab-concurrency (${label}): no settlement within ${ms}ms`);
      resolve(undefined);
    }, ms))
  ]);

  // (1) One tab, six batches (as if from two content-script instances):
  // at most MAX run concurrently; the rest queue and drain as slots free.
  let vmBg;
  try {
    const deferred = makeDeferredFetch();
    vmBg = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    const responses = [];
    for (let i = 0; i < 6; i += 1) {
      responses.push(vmBg.sendMessage(batchMessage([`Hello ${i}`]), 11));
    }
    await tick();
    assertEqual(deferred.state.calls, MAX, "tab cap: only MAX batches start per tab");
    assertEqual(deferred.state.maxInFlight, MAX, "tab cap: concurrent fetches never exceed MAX per tab");
    const firstWave = deferred.pending.splice(0);
    assertEqual(firstWave.length, MAX, "tab cap: exactly MAX requests are in flight");
    for (const entry of firstWave) {
      entry.resolve(vmJsonResponse(200, vmOkBody));
    }
    await tick();
    assertEqual(deferred.state.calls, 6, "tab cap: queued batches start once slots free");
    assertEqual(deferred.state.maxInFlight, MAX, "tab cap: draining the queue never exceeds MAX concurrent fetches");
    for (const entry of deferred.pending.splice(0)) {
      entry.resolve(vmJsonResponse(200, vmOkBody));
    }
    const settled = await withTimeout(Promise.all(responses), "six batches settle");
    if (!Array.isArray(settled) || settled.length !== 6 || settled.some((r) => r?.ok !== true)) {
      fail(`tab cap: all six batches must resolve ok, got ${JSON.stringify(settled?.map((r) => r?.ok))}`);
    }
  } catch (error) {
    fail(`tab cap: vm harness failed: ${error.message}`);
  }

  // (2) Whole-page navigation (onUpdated status loading) during the 503
  // backoff cancels the tab's run: no further fetch may leave the worker.
  try {
    // Scale every sandbox timer to ≥50ms real: the ~1s backoff sleep then
    // spans several tick() rounds, so the cancel below reliably lands while
    // the run is between attempts.
    const scaledSetTimeout = (fn, ms) => setTimeout(fn, Math.max(Math.min(ms ?? 0, 30000), 50));
    let calls503 = 0;
    const fetch503 = async () => {
      calls503 += 1;
      return vmJsonResponse(503, '{"error":{"message":"down"}}');
    };
    const vmNav = buildBackgroundVm({
      storageData: vmStorage,
      fetchImpl: fetch503,
      setTimeoutImpl: scaledSetTimeout
    });
    const responsePromise = vmNav.sendMessage(batchMessage(["Hello nav"]), 12);
    await tick();
    assertEqual(calls503, 1, "nav cancel: first 503 attempt fired");
    // The backoff sleep (~1s, scaled to 50ms) is in flight right now.
    vmNav.listeners.tabsUpdated[0](12, { status: "loading" }, { id: 12 });
    const response = await withTimeout(responsePromise, "nav cancel response");
    if (response?.ok !== false || response?.code !== "RUN_CANCELLED") {
      fail(`nav cancel: loading must cancel the tab's in-flight run with RUN_CANCELLED, got ${JSON.stringify(response)}`);
    }
    // Long enough for a (buggy) post-cancel retry to have fired after the
    // scaled backoff elapsed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqual(calls503, 1, "nav cancel: no fetch after the tab navigated (retry/backoff cancelled)");
  } catch (error) {
    fail(`nav cancel: vm harness failed: ${error.message}`);
  }

  // (3) onRemoved aborts the in-flight fetch itself.
  try {
    const deferred = makeDeferredFetch();
    const vmRemoved = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    const responsePromise = vmRemoved.sendMessage(batchMessage(["Hello gone"]), 13);
    await tick();
    assertEqual(deferred.state.calls, 1, "tab removed: batch was in flight");
    vmRemoved.listeners.tabsRemoved[0](13);
    const response = await withTimeout(responsePromise, "tab removed response");
    if (response?.ok !== false || response?.code !== "RUN_CANCELLED") {
      fail(`tab removed: closing the tab must cancel with RUN_CANCELLED, got ${JSON.stringify(response)}`);
    }
    assertEqual(deferred.state.calls, 1, "tab removed: aborted fetch is never retried");
    assertEqual(deferred.state.inFlight, 0, "tab removed: aborted fetch settled");
  } catch (error) {
    fail(`tab removed: vm harness failed: ${error.message}`);
  }

  // (4) Hash-only URL changes are same-document: batches keep running.
  try {
    const deferred = makeDeferredFetch();
    const vmHash = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    // Prime the tab's recorded url before any batch exists.
    vmHash.listeners.tabsUpdated[0](14, { url: "https://x.com/home" }, { id: 14 });
    await tick();
    const responsePromise = vmHash.sendMessage(batchMessage(["Hello hash"]), 14);
    await tick();
    assertEqual(deferred.state.calls, 1, "hash nav: batch was in flight");
    vmHash.listeners.tabsUpdated[0](14, { url: "https://x.com/home#feed" }, { id: 14 });
    await tick();
    assertEqual(deferred.state.calls, 1, "hash nav: same-document anchor jump keeps the batch running");
    deferred.pending[0].resolve(vmJsonResponse(200, vmOkBody));
    const response = await withTimeout(responsePromise, "hash nav response");
    if (response?.ok !== true) {
      fail(`hash nav: hash-only change must not cancel the batch, got ${JSON.stringify(response)}`);
    }
  } catch (error) {
    fail(`hash nav: vm harness failed: ${error.message}`);
  }

  // (5) Real-file hung provider: the shipping worker wiring terminates the
  // run within the total deadline (scaled timers), surfacing the timeout
  // error after the bounded retry cycle.
  try {
    const scaledSetTimeout = (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5));
    let hangCalls = 0;
    const hangFetch = (url, options = {}) => new Promise((resolve, reject) => {
      hangCalls += 1;
      options.signal?.addEventListener("abort", () => {
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        reject(abortError);
      });
    });
    const vmHung = buildBackgroundVm({
      storageData: vmStorage,
      fetchImpl: hangFetch,
      setTimeoutImpl: scaledSetTimeout
    });
    const startedAt = Date.now();
    const response = await withTimeout(vmHung.sendMessage(batchMessage(["Hello hung"]), 15), "hung provider response");
    const elapsed = Date.now() - startedAt;
    if (response?.ok !== false || response?.code !== "FETCH_TIMEOUT") {
      fail(`hung provider: must surface FETCH_TIMEOUT through the real worker wiring, got ${JSON.stringify(response)}`);
    }
    const maxAttempts = 1 + utils.MAX_PROVIDER_RETRIES;
    if (hangCalls > maxAttempts) {
      fail(`hung provider: at most ${maxAttempts} attempts may fire, got ${hangCalls}`);
    }
    if (elapsed > 1000) {
      fail(`hung provider: run must terminate within the deadline budget, took ${elapsed}ms`);
    }
  } catch (error) {
    fail(`hung provider: vm harness failed: ${error.message}`);
  }

  // (6) A whole-tab reload clears cancelledContentRuns: the new document's
  // content script restarts its run generation at 1, so it must not inherit
  // the previous document's cancellation of generation 1.
  try {
    const deferred = makeDeferredFetch();
    const vmReload = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    vmReload.sendMessage({ type: "CANCEL_TRANSLATE_BATCHES", runId: 1 }, 16);
    await tick();
    const blocked = await withTimeout(vmReload.sendMessage(batchMessage(["Hello blocked"]), 16), "stale cancel response");
    if (blocked?.ok !== false || blocked?.code !== "RUN_CANCELLED") {
      fail(`reload: a cancelled generation must stay cancelled before any navigation, got ${JSON.stringify(blocked)}`);
    }
    assertEqual(deferred.state.calls, 0, "reload: cancelled run makes no provider call");
    // The reload (status "loading") is a whole-tab navigation: the stale
    // cancelledContentRuns entry for the tab must go with the old document.
    vmReload.listeners.tabsUpdated[0](16, { status: "loading" }, { id: 16 });
    const responsePromise = vmReload.sendMessage(batchMessage(["Hello reload"]), 16);
    await tick();
    assertEqual(deferred.state.calls, 1, "reload: post-reload generation-1 run starts");
    deferred.pending[0].resolve(vmJsonResponse(200, vmOkBody));
    const response = await withTimeout(responsePromise, "reload response");
    if (response?.ok !== true) {
      fail(`reload: whole-tab navigation must clear the stale cancellation for the reused generation, got ${JSON.stringify(response)}`);
    }
  } catch (error) {
    fail(`reload: vm harness failed: ${error.message}`);
  }

  // (7) A cold-started worker has no baseline URL for a tab: the tab's FIRST
  // url event must not be treated as a whole-tab navigation (memory-only
  // lastTabUrls map), while status "loading" still cancels and a later
  // baseline-backed non-fragment change still cancels.
  try {
    const deferred = makeDeferredFetch();
    const vmFirstUrl = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    const responsePromise = vmFirstUrl.sendMessage(batchMessage(["Hello first url"]), 17);
    await tick();
    assertEqual(deferred.state.calls, 1, "first url: batch was in flight");
    vmFirstUrl.listeners.tabsUpdated[0](17, { url: "https://x.com/home" }, { id: 17 });
    await tick();
    assertEqual(deferred.state.calls, 1, "first url: baseline-less url event keeps the batch running");
    deferred.pending[0].resolve(vmJsonResponse(200, vmOkBody));
    const response = await withTimeout(responsePromise, "first url response");
    if (response?.ok !== true) {
      fail(`first url: the tab's first url event must not cancel the batch, got ${JSON.stringify(response)}`);
    }
    // Baseline recorded: a non-fragment url change still counts as navigation.
    const secondPromise = vmFirstUrl.sendMessage(batchMessage(["Hello path change"]), 17);
    await tick();
    assertEqual(deferred.state.calls, 2, "first url: second batch was in flight");
    vmFirstUrl.listeners.tabsUpdated[0](17, { url: "https://x.com/explore" }, { id: 17 });
    const cancelled = await withTimeout(secondPromise, "path change response");
    if (cancelled?.ok !== false || cancelled?.code !== "RUN_CANCELLED") {
      fail(`first url: a baseline-backed non-fragment url change must cancel with RUN_CANCELLED, got ${JSON.stringify(cancelled)}`);
    }
  } catch (error) {
    fail(`first url: vm harness failed: ${error.message}`);
  }

  // Statics: the gate and listeners exist in the shipping file.
  const background = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  for (const needle of [
    "withTabTranslateSlot",
    "cancelTabTranslateBatches",
    "releaseTabTranslateSlot",
    "isWholeTabNavigationChange",
    "stripUrlHash"
  ]) {
    if (!background.includes(needle)) {
      fail(`background.js: per-tab slot manager must keep ${needle}`);
    }
  }
  if (!/withTabTranslateSlot\(tabId,/.test(background)) {
    fail("background.js: TRANSLATE_BATCH must run under withTabTranslateSlot");
  }
}

// ---- P2-1: content.js translation reuse cache ----
function checkTranslationReuseCache() {
  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (actual, label) => {
    if (actual !== true) {
      fail(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
  };
  const assertNull = (actual, label) => {
    if (actual !== null) {
      fail(`${label}: expected null, got ${JSON.stringify(actual)}`);
    }
  };

  const keySrc = extractContentFunction("translationCacheKey");
  const getSrc = extractContentFunction("getCachedTranslation");
  const setSrc = extractContentFunction("setCachedTranslation");
  if (!keySrc || !getSrc || !setSrc) {
    fail("content.js: cannot extract translationCacheKey/getCachedTranslation/setCachedTranslation for reuse-cache test");
    return;
  }

  const cache = new Map();
  const state = { displayMode: "bilingual" };
  let api;
  try {
    api = new Function(
      "state",
      "translationCache",
      "TRANSLATION_CACHE_LIMIT",
      `${keySrc}\n${getSrc}\n${setSrc}\nreturn { translationCacheKey, getCachedTranslation, setCachedTranslation };`
    )(state, cache, 500);
  } catch (error) {
    fail(`content.js: translation cache helpers are not runnable standalone: ${error.message}`);
    return;
  }

  const settings = { provider: "deepseek", targetLanguage: "zh-CN", model: "deepseek-flash" };

  assertNull(api.getCachedTranslation("Hello world", settings), "reuse cache: unknown text misses");
  api.setCachedTranslation("Hello world", "你好，世界", settings);
  assertEqual(api.getCachedTranslation("Hello world", settings), "你好，世界", "reuse cache: stored text hits");

  // Run-setting changes must miss: a different provider/target/model would
  // produce a different translation for the same source.
  assertNull(api.getCachedTranslation("Hello world", { ...settings, model: "deepseek-v4-pro" }), "reuse cache: model change misses");
  assertNull(api.getCachedTranslation("Hello world", { ...settings, provider: "kimi", model: "kimi-k2.6" }), "reuse cache: provider change misses");
  assertNull(api.getCachedTranslation("Hello world", { ...settings, targetLanguage: "en" }), "reuse cache: target change misses");
  // displayMode only picks how a translation is rendered, never its content:
  // it is not part of the cache key, so toggling it reuses the billed entry.
  state.displayMode = "translation-only";
  assertEqual(api.getCachedTranslation("Hello world", settings), "你好，世界", "reuse cache: displayMode change still hits (not part of the key)");
  state.displayMode = "original";
  assertEqual(api.getCachedTranslation("Hello world", settings), "你好，世界", "reuse cache: every displayMode reads the same entry");
  state.displayMode = "bilingual";
  if (/displayMode/.test(stripCommentsForScan(keySrc))) {
    fail("content.js: translationCacheKey must not include displayMode (rendering choice, not translation identity)");
  }

  // Empty / whitespace-only translations are never stored.
  api.setCachedTranslation("Blank text", "   ", settings);
  assertNull(api.getCachedTranslation("Blank text", settings), "reuse cache: whitespace-only translation is not stored");

  // Bounded LRU: 500 entries max; a read refreshes recency so the oldest
  // non-refreshed entry is the one evicted.
  for (let i = 0; i < 500; i += 1) {
    api.setCachedTranslation(`text-${i}`, `t${i}`, settings);
  }
  assertEqual(cache.size, 500, "reuse cache: bounded at the 500-entry limit");
  assertEqual(api.getCachedTranslation("text-0", settings), "t0", "reuse cache: read returns the translation");
  api.setCachedTranslation("text-500", "t500", settings);
  assertEqual(cache.size, 500, "reuse cache: insertion past the limit evicts exactly one entry");
  assertNull(api.getCachedTranslation("text-1", settings), "reuse cache: least-recently-used entry (text-1) evicted");
  assertEqual(api.getCachedTranslation("text-0", settings), "t0", "reuse cache: refreshed entry (text-0) survives");
  assertEqual(api.getCachedTranslation("text-500", settings), "t500", "reuse cache: newest entry present");

  // Static wiring: cache-first before any request, store after apply,
  // clear on session end.
  const fallbackSrc = stripCommentsForScan(extractContentFunction("translateBatchWithFallback") || "");
  const cacheReadAt = fallbackSrc.indexOf("getCachedTranslation(");
  const requestAt = fallbackSrc.indexOf("requestSegmentTranslations(");
  if (cacheReadAt < 0 || requestAt < 0 || cacheReadAt > requestAt) {
    fail("content.js: translateBatchWithFallback must consult the reuse cache before sending TRANSLATE_BATCH");
  }
  const applySrc = stripCommentsForScan(extractContentFunction("applyTranslatedSegment") || "");
  if (!/setCachedTranslation\(/.test(applySrc)) {
    fail("content.js: applyTranslatedSegment must store validated translations in the reuse cache");
  }
  const restoreSrc = stripCommentsForScan(extractContentFunction("restoreOriginal") || "");
  if (!/translationCache\.clear\(\)/.test(restoreSrc)) {
    fail("content.js: restoreOriginal must clear the reuse cache (session end)");
  }
  const content = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"));
  if (!/TRANSLATION_CACHE_LIMIT\s*=\s*500/.test(content)) {
    fail("content.js: TRANSLATION_CACHE_LIMIT must stay a bounded 500");
  }
}

// ---- P2-2: packaging ----
async function checkPackaging() {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, "scripts", "pack.mjs")).href);
  } catch (error) {
    fail(`scripts/pack.mjs: cannot be imported: ${error.message}`);
    return;
  }
  const {
    collectExtensionFiles,
    assertNoExcludedFiles,
    pack,
    listZipEntries,
    readZipEntry,
    EXCLUDED_PREFIXES,
    EXCLUDED_NAMES
  } = mod;

  const manifest = readJson("manifest.json");
  if (!manifest) {
    return;
  }

  let collected;
  try {
    collected = collectExtensionFiles(ROOT);
  } catch (error) {
    fail(`pack file list: ${error.message}`);
    return;
  }
  const { files, version } = collected;
  if (version !== manifest.version) {
    fail(`pack: zip version ${JSON.stringify(version)} must match manifest.version ${JSON.stringify(manifest.version)}`);
  }

  // The ship list must cover every runtime entry point.
  const required = [
    "manifest.json",
    "background.js",
    "shared.js",
    "content.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png"
  ];
  for (const rel of required) {
    if (!files.includes(rel)) {
      fail(`pack: required file missing from the ship list: ${rel}`);
    }
  }

  // Every shipped file exists and nothing excluded ships.
  for (const rel of files) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      fail(`pack: shipped file missing on disk: ${rel}`);
    }
    if (EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
      fail(`pack: excluded directory must not ship: ${rel}`);
    }
    if (EXCLUDED_NAMES.includes(rel) || path.basename(rel).startsWith(".env")) {
      fail(`pack: excluded file must not ship: ${rel}`);
    }
  }
  try {
    assertNoExcludedFiles(files);
  } catch (error) {
    fail(`pack: exclusion assertion failed: ${error.message}`);
  }
  for (const never of ["scripts/ci-check.mjs", "scripts/pack.mjs", "README.md", "AGENTS.md", "docs/MERGE_GATES.md", "promo/store-listing-zh.md", ".gitignore"]) {
    if (files.includes(never)) {
      fail(`pack: non-extension file must never ship: ${never}`);
    }
  }

  // Manifest-referenced files all exist — re-derive the direct references and
  // check each one (collectExtensionFiles already throws, this is the
  // ci-side assertion with a clear message).
  const directRefs = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);
  for (const rel of directRefs) {
    if (!files.includes(rel)) {
      fail(`pack: manifest-referenced file missing from the ship list: ${rel}`);
    }
  }

  // Build the real zip and verify the container + payloads.
  let packed;
  try {
    packed = pack(ROOT);
  } catch (error) {
    fail(`pack: build failed: ${error.message}`);
    return;
  }
  if (!fs.existsSync(packed.outPath) || fs.statSync(packed.outPath).size === 0) {
    fail(`pack: output zip missing or empty: ${packed.outPath}`);
    return;
  }
  let entries;
  try {
    entries = listZipEntries(packed.outPath);
  } catch (error) {
    fail(`pack: zip container verification failed: ${error.message}`);
    return;
  }
  const entryNames = entries.map((entry) => entry.name);
  if (JSON.stringify([...entryNames].sort()) !== JSON.stringify([...files].sort())) {
    fail(`pack: zip entries must equal the ship list, got ${JSON.stringify(entryNames)}`);
    return;
  }

  // Payload integrity: CRC + inflate round-trip on a text and a binary entry.
  try {
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    const manifestData = JSON.parse(readZipEntry(packed.outPath, manifestEntry).toString("utf8"));
    if (manifestData.version !== manifest.version) {
      fail("pack: zipped manifest.json must parse and carry the extension version");
    }
    const iconEntry = entries.find((entry) => entry.name === "icons/icon-128.png");
    const iconData = readZipEntry(packed.outPath, iconEntry);
    const diskData = fs.readFileSync(path.join(ROOT, "icons/icon-128.png"));
    if (Buffer.compare(iconData, diskData) !== 0) {
      fail("pack: zipped icon must byte-match the source file after inflate");
    }
  } catch (error) {
    fail(`pack: zip payload verification failed: ${error.message}`);
  }

  // dist/ must be gitignored so builds never dirty the tree.
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  if (!/^dist\/$/m.test(gitignore)) {
    fail(".gitignore: must ignore dist/ (build output)");
  }
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

async function main() {
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
  await checkFetchTimeoutCoverage();
  await checkModelMigrationAndRetryPolicy();
  await checkInflightCapAndRunCancellation();
  await checkSpaRefreshAndSelectionLifecycle();
  await checkTotalDeadlineBudget();
  await checkTabConcurrencyAndNavigationCancel();
  checkTranslationReuseCache();
  await checkPackaging();

  if (errors.length > 0) {
    console.error("\nCI CHECK FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("OK: manifest, permissions, syntax, static bans, segment split logic, parseTranslationPayload, joinSplitTranslations, joinRawTextNodes, X layout heuristics, X mutation scope gate, English profile detection, version bump, SPA navigation + selection card statics, fetch timeout coverage, model migration + retry policy, inflight cap + run cancellation, SPA refresh + selection lifecycle, total deadline budget, tab concurrency + navigation cancel, translation reuse cache, packaging");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
