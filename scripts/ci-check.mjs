#!/usr/bin/env node
/**
 * Zero-dependency AI-native CI gate for kilocean-translate.
 * Exit non-zero with clear messages on failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
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

// Chrome Web Store item this repository publishes to. manifest.key must carry
// the item's public key so unpacked installs share the store extension ID (and
// therefore chrome.storage — saved API keys survive the switch).
const STORE_EXTENSION_ID = "lmdbhjngjhlgbpmbjfffegjalchblpke";

const errors = [];

// Obviously-fake API key fixtures, built at runtime so no key-shaped literal
// lives in the source (keeps secret scanners quiet without allowlisting).
function fakeKey(tag, len) {
  return ["sk", tag + "FAKE".padEnd(len - 4, "X")].join("-");
}

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

  // manifest.key = the Chrome Web Store public key (NOT an API key). It pins
  // unpacked installs to the store extension ID so saved keys survive the
  // unpacked→store transition. Derivation: sha256(base64-decoded DER), first
  // 16 bytes, each nibble 0-15 → 'a'-'p'.
  if (typeof manifest.key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) {
    fail(
      `manifest.key (Chrome Web Store public key, base64) is required so unpacked installs keep the store ID ${STORE_EXTENSION_ID}, got ${JSON.stringify(manifest.key)}`
    );
  } else {
    const der = Buffer.from(manifest.key, "base64");
    if (der.toString("base64") !== manifest.key || der.length < 160) {
      fail("manifest.key must base64-decode (round-trip) to a DER public key of plausible size");
    } else {
      const digest = crypto.createHash("sha256").update(der).digest();
      let derivedId = "";
      for (let i = 0; i < 16; i += 1) {
        derivedId += String.fromCharCode(97 + (digest[i] >> 4));
        derivedId += String.fromCharCode(97 + (digest[i] & 0xf));
      }
      if (derivedId !== STORE_EXTENSION_ID) {
        fail(`manifest.key must derive the store extension ID ${STORE_EXTENSION_ID}, got ${derivedId}`);
      }
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
  // Deliberate false negative: "About me" is English but carries only one
  // unambiguous function word — short text (< 8 words) skips only on
  // overwhelming evidence (>= 3 distinct unambiguous function words), so it
  // keeps translating rather than risking a foreign-text skip.
  assertFalse(looksLikeEnglish("About me"), "looksLikeEnglish: short English without 3 distinct unambiguous words translates (accepted false negative)");

  // Short foreign text that shares English tokens must never be skipped:
  // Dutch/Afrikaans sentences carry "is" and no listed foreign marker, so
  // the word-list cannot save us — only the overwhelming-evidence bar can
  // (P1 review: avoid word-list whack-a-mole).
  assertFalse(looksLikeEnglish("Dit is nie moontlik nie"), "looksLikeEnglish: 'Dit is nie moontlik nie' is Afrikaans — 'is' alone is not English evidence");
  assertFalse(looksLikeEnglish("Dit is een goed idee"), "looksLikeEnglish: 'Dit is een goed idee' is Dutch — 'is' alone is not English evidence");
  assertFalse(looksLikeEnglish("Es una buena idea"), "looksLikeEnglish: 'Es una buena idea' is Spanish — markers veto the skip");
  assertFalse(looksLikeEnglish("Het is een mooie dag"), "looksLikeEnglish: 'Het is een mooie dag' is Dutch — 'is' alone is not English evidence");

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
  // remaining unambiguous hits still carry the sentence. Short English needs
  // the overwhelming bar (>= 3 distinct unambiguous words at a high ratio).
  assertFalse(looksLikeEnglish("The movie was great"), "looksLikeEnglish: 4-word English without 3 distinct unambiguous words translates (accepted false negative)");
  assertTrue(looksLikeEnglish("It is what it is"), "looksLikeEnglish: short English with overwhelming evidence still detected");
  assertTrue(looksLikeEnglish("This is not a test"), "looksLikeEnglish: short English with 3 distinct unambiguous words still detected");
  assertTrue(looksLikeEnglish("I am so happy about this"), "looksLikeEnglish: English with ambiguous 'a'-word context still detected");
  assertTrue(looksLikeEnglish("We are a small team of makers based in Berlin."), "looksLikeEnglish: English bio with ambiguous 'a'/'in' still detected");
  assertFalse(looksLikeEnglish("Was it good?"), "looksLikeEnglish: 3-word English without 3 distinct unambiguous words translates (accepted false negative)");

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
  assertFalse(
    isAlreadyTargetLanguage("Dit is nie moontlik nie", "en"),
    "isAlreadyTargetLanguage: Afrikaans translates for en (shared 'is' is not English evidence)"
  );
  assertFalse(
    isAlreadyTargetLanguage("Dit is een goed idee", "en"),
    "isAlreadyTargetLanguage: Dutch translates for en (shared 'is' is not English evidence)"
  );
  assertFalse(
    isAlreadyTargetLanguage("Es una buena idea", "en"),
    "isAlreadyTargetLanguage: Spanish translates for en"
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
  // Manual + paste tests share runKeyConnectionTest: thrown errors go through
  // toFriendlyPageError (timeout verbatim), API errors fall back to response.error.
  if (
    !/renderStatus\("网络错误",\s*toFriendlyPageError\(error\)/.test(popup) ||
    !/response\?\.error \|\| "连接测试失败/.test(popup)
  ) {
    fail("popup.js: connection-test failure must surface the error message");
  }
  if (!/(?:setStatus|passiveStatus)\("翻译失败",\s*status\.error/.test(popup)) {
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

// ---- 1.4.3 key persistence: upgrades must never wipe a stored key ----
// Loads the REAL background.js (+ shared.js) into a node vm behind a mock
// chrome (storage.local, runtime.onInstalled/onStartup/onMessage, tabs,
// action) and replays every stored-settings shape a 1.3.x / 1.4.x user can
// carry into 1.4.3 through the shipping code paths: direct loadSettings,
// onInstalled(update), worker cold-restart (script reload + onStartup), and
// the live message paths (TEST_CONNECTION / TRANSLATE_BATCH). A stored key
// may be migrated (legacy apiKey → deepseekApiKey) or mirrored (apiKey), but
// never emptied. The popup load path runs in its own vm with a minimal DOM
// mock, including the settings import/export merge rules.
function createBackgroundVm(storageData, fetchImpl) {
  const sharedSource = fs.readFileSync(path.join(ROOT, "shared.js"), "utf8");
  const backgroundSource = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const listeners = {
    installed: [],
    startup: [],
    message: [],
    tabsRemoved: [],
    tabsUpdated: []
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchImpl,
    chrome: {
      runtime: {
        id: "kilocean-ci-extension-id",
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
        onMessage: { addListener: (fn) => listeners.message.push(fn) }
      },
      storage: {
        local: {
          get: async (defaults) => ({ ...(defaults || {}), ...storageData }),
          set: async (updates) => { Object.assign(storageData, updates); }
        },
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        },
        onChanged: { addListener() {} }
      },
      tabs: {
        onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) },
        onUpdated: { addListener: (fn) => listeners.tabsUpdated.push(fn) }
      },
      action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {}
      }
    }
  };
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (rel) => {
    if (rel !== "shared.js") {
      throw new Error(`unexpected importScripts: ${rel}`);
    }
    vm.runInContext(sharedSource, context, { filename: "shared.js" });
  };
  vm.runInContext(
    `${backgroundSource}\n;globalThis.__hooks = { loadSettings, translateBatch, PROVIDERS, DEFAULT_SETTINGS };`,
    context,
    { filename: "background.js" }
  );
  return {
    storage: storageData,
    listeners,
    hooks: sandbox.__hooks,
    sendMessage: (message, sender = { id: sandbox.chrome.runtime.id, tab: { id: 11 } }) =>
      new Promise((resolve) => {
        if (listeners.message.length !== 1) {
          throw new Error("background vm: exactly one runtime.onMessage listener expected");
        }
        listeners.message[0](message, sender, resolve);
      })
  };
}

// Minimal DOM stub good enough to run the real popup.js load path (and the
// settings import/export helpers) without a browser.
function createPopupVm(storageData, { runtimeMessageHandler = async () => ({ ok: false }) } = {}) {
  const storageListeners = [];
  const sharedSource = fs.readFileSync(path.join(ROOT, "shared.js"), "utf8");
  const popupSource = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");

  const makeElement = (overrides = {}) => ({
    value: "",
    type: "text",
    textContent: "",
    disabled: false,
    hidden: false,
    checked: false,
    focused: false,
    files: [],
    dataset: {},
    attributes: {},
    listeners: {},
    options: [],
    classList: {
      toggle() {},
      add() {},
      remove() {},
      contains: () => false
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    focus() {
      this.focused = true;
    },
    appendChild(node) {
      this.options.push(node);
      return node;
    },
    click() {},
    remove() {},
    ...overrides
  });
  // <select>-like: assigning innerHTML = "" must clear the options list like
  // the real DOM, or applyProviderUi's rebuild would stack stale options.
  const makeSelect = () => {
    const element = makeElement();
    let innerHTML = "";
    Object.defineProperty(element, "innerHTML", {
      get() {
        return innerHTML;
      },
      set(next) {
        innerHTML = String(next);
        if (innerHTML === "") {
          element.options.length = 0;
        }
      }
    });
    return element;
  };

  const byId = new Map();
  const element = (id, overrides) => {
    if (!byId.has(id)) {
      byId.set(id, id === "provider" || id === "model" || id === "target-language"
        ? makeSelect()
        : makeElement(overrides));
    }
    return byId.get(id);
  };
  for (const id of [
    "provider",
    "api-key",
    "api-key-label",
    "get-key-link",
    "key-status-deepseek",
    "key-status-deepseek-value",
    "key-status-kimi",
    "key-status-kimi-value",
    "key-guide",
    "target-language",
    "model",
    "toggle-key",
    "test-connection",
    "translate",
    "restore",
    "export-html",
    "print-pdf",
    "export-settings",
    "import-settings",
    "import-file",
    "export-include-keys",
    "status-title",
    "status-detail",
    "selection-confirm-panel",
    "selection-confirm-text",
    "selection-confirm-btn",
    "selection-confirm-dismiss"
  ]) {
    element(id);
  }
  element("api-key").type = "password";
  const statusCard = makeElement();
  const modeButtons = ["bilingual", "translation-only", "original"].map((mode) =>
    makeElement({ dataset: { mode } })
  );

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    document: {
      getElementById: (id) => byId.get(id) || null,
      querySelector: (selector) => (selector === ".status-card" ? statusCard : null),
      querySelectorAll: (selector) => (selector === ".mode-button" ? modeButtons : []),
      createElement: () => makeElement(),
      body: makeElement(),
      addEventListener() {},
      visibilityState: "visible"
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.4.3" }),
        onMessage: { addListener() {} },
        sendMessage: (message) => runtimeMessageHandler(message)
      },
      storage: {
        local: {
          get: async (defaults) => ({ ...(defaults || {}), ...storageData }),
          set: async (updates) => { Object.assign(storageData, updates); }
        },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      },
      tabs: {
        query: async () => [{ id: 42 }],
        sendMessage: async () => ({ ok: true, status: { active: false } })
      },
      scripting: { executeScript: async () => {} }
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(sharedSource, context, { filename: "shared.js" });
  vm.runInContext(
    `${popupSource}\n;globalThis.__popupHooks = {
      parseImportedSettings,
      applyImportedSettings,
      handleApiKeyPasted,
      apiKeyFormatReason,
      saveSettings,
      migrateSettings,
      initializePromise,
      getProviderKeys: () => providerKeys,
      renderTranslationStatus,
      runKeyConnectionTest,
      buildExportPayload
    };`,
    context,
    { filename: "popup.js" }
  );
  return {
    storage: storageData,
    dom: byId,
    hooks: sandbox.__popupHooks,
    sandbox,
    emitStorageChange(changes) {
      for (const [field, change] of Object.entries(changes)) {
        storageData[field] = change.newValue;
      }
      for (const fn of storageListeners) {
        fn(changes, "local");
      }
    }
  };
}

async function checkKeyMigrationGate() {
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

  const LEGACY_KEY = fakeKey("legacy", 26);
  const DEEPSEEK_KEY = fakeKey("deepseek", 21);
  const KIMI_KEY = fakeKey("kimi", 25);

  // Provider fetch mock: capture the Authorization header, answer with a
  // well-formed minimal translation so the whole shipping path succeeds.
  const seenRequests = [];
  const okBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ translations: ["你好"] }) } }]
  });
  const okFetch = async (url, options = {}) => {
    seenRequests.push({ url, authorization: options.headers?.Authorization || "" });
    return {
      ok: true,
      status: 200,
      statusText: "",
      headers: { get: () => null },
      url,
      text: async () => okBody
    };
  };

  // A stored key may migrate or mirror, never disappear.
  const storageKeysSurvive = (seed, data, label) => {
    const seedDeepseek = String(seed.deepseekApiKey || "").trim();
    const seedKimi = String(seed.kimiApiKey || "").trim();
    const seedLegacy = String(seed.apiKey || "").trim();
    if (seedDeepseek) {
      assertTrue(
        String(data.deepseekApiKey || "").trim() === seedDeepseek,
        `${label}: stored DeepSeek key must survive every 1.4.3 load path`
      );
    }
    if (seedKimi) {
      assertTrue(
        String(data.kimiApiKey || "").trim() === seedKimi,
        `${label}: stored Kimi key must survive every 1.4.3 load path`
      );
    }
    if (seedLegacy && !seedDeepseek && !seedKimi) {
      assertTrue(
        String(data.deepseekApiKey || "").trim() === seedLegacy,
        `${label}: <=1.3.x legacy apiKey must migrate into deepseekApiKey, not vanish`
      );
    }
  };

  // Replay one stored-settings shape through every upgrade path against the
  // SAME evolving storage object: repeated worker cold-restarts (script
  // reload = onStartup equivalent), onInstalled(update), settings loads and
  // the live TEST_CONNECTION message path (which must bill the expected key).
  const runUpgradeGauntlet = async (label, seed, { expectedProvider, expectedActiveKey, expectedModel }) => {
    const storageData = { ...seed };
    for (let round = 0; round < 3; round += 1) {
      // (a) worker cold-restart: fresh vm, top-level runs, onStartup fires,
      //     then a direct settings load.
      const cold = createBackgroundVm(storageData, okFetch);
      assertTrue(cold.listeners.startup.length === 1, `${label}: background must register a runtime.onStartup migration pass`);
      for (const onStartup of cold.listeners.startup) {
        await onStartup();
      }
      const settings = await cold.hooks.loadSettings();
      storageKeysSurvive(seed, storageData, `${label} (cold restart ${round})`);
      assertEqual(settings.provider, expectedProvider, `${label}: provider preserved (round ${round})`);
      assertEqual(settings.model, expectedModel, `${label}: model mapped to current name (round ${round})`);
      assertEqual(
        String(settings[expectedProvider === "kimi" ? "kimiApiKey" : "deepseekApiKey"] || ""),
        expectedActiveKey,
        `${label}: migrated key is usable in returned settings (round ${round})`
      );

      // (b) onInstalled(update) — the store-upgrade event itself.
      const updated = createBackgroundVm(storageData, okFetch);
      for (const onInstalled of updated.listeners.installed) {
        await onInstalled({ reason: "update", previousVersion: "1.4.2" });
      }
      storageKeysSurvive(seed, storageData, `${label} (onInstalled update ${round})`);

      // (c) live message path: TEST_CONNECTION exercises loadSettings +
      //     translateBatch end to end and must send the expected bearer key.
      const requestsBefore = seenRequests.length;
      const live = createBackgroundVm(storageData, okFetch);
      const response = await live.sendMessage({
        type: "TEST_CONNECTION",
        provider: expectedProvider,
        targetLanguage: "zh-CN",
        model: expectedModel
      });
      assertTrue(response?.ok === true, `${label}: TEST_CONNECTION succeeds with migrated settings (round ${round})`);
      assertEqual(seenRequests.length, requestsBefore + 1, `${label}: connection test bills exactly one request (round ${round})`);
      assertEqual(
        seenRequests[seenRequests.length - 1].authorization,
        `Bearer ${expectedActiveKey}`,
        `${label}: migrated key reaches the provider Authorization header (round ${round})`
      );

      // (d) popup open between rounds (below) rewrites the full settings
      //     object — folded in by the popup scenarios after this loop.
    }
    return storageData;
  };

  // ---- 1.3.x single-key storage (apiKey + legacy model name) ----
  const migratedFromLegacy = await runUpgradeGauntlet(
    "1.3.x → 1.4.3",
    { apiKey: LEGACY_KEY, model: "deepseek-v4-flash" },
    { expectedProvider: "deepseek", expectedActiveKey: LEGACY_KEY, expectedModel: "deepseek-flash" }
  );
  assertEqual(migratedFromLegacy.deepseekApiKey, LEGACY_KEY, "1.3.x → 1.4.3: legacy key persisted as deepseekApiKey");
  assertEqual(migratedFromLegacy.model, "deepseek-flash", "1.3.x → 1.4.3: legacy model name retired in storage");

  // ---- 1.4.x DeepSeek user, current + legacy model names ----
  await runUpgradeGauntlet(
    "1.4.x deepseek (legacy model)",
    { provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, model: "deepseek-v4-flash", targetLanguage: "zh-CN", displayMode: "bilingual" },
    { expectedProvider: "deepseek", expectedActiveKey: DEEPSEEK_KEY, expectedModel: "deepseek-flash" }
  );
  await runUpgradeGauntlet(
    "1.4.x deepseek (current model)",
    { provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, model: "deepseek-v4-pro" },
    { expectedProvider: "deepseek", expectedActiveKey: DEEPSEEK_KEY, expectedModel: "deepseek-v4-pro" }
  );

  // ---- 1.4.x Kimi user: kimi key must survive, and the legacy apiKey
  // mirror must NOT be reinterpreted as a DeepSeek key ----
  const kimiStorage = await runUpgradeGauntlet(
    "1.4.x kimi (mirrored apiKey)",
    { provider: "kimi", kimiApiKey: KIMI_KEY, apiKey: KIMI_KEY, model: "kimi-k2.6" },
    { expectedProvider: "kimi", expectedActiveKey: KIMI_KEY, expectedModel: "kimi-k2.6" }
  );
  assertEqual(String(kimiStorage.deepseekApiKey || ""), "", "1.4.x kimi: mirrored apiKey is not re-imported as a DeepSeek key");

  // ---- 1.4.x dual-key user ----
  const dualStorage = await runUpgradeGauntlet(
    "1.4.x dual keys",
    { provider: "kimi", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, apiKey: KIMI_KEY, model: "kimi-k2.6" },
    { expectedProvider: "kimi", expectedActiveKey: KIMI_KEY, expectedModel: "kimi-k2.6" }
  );
  assertEqual(dualStorage.deepseekApiKey, DEEPSEEK_KEY, "1.4.x dual keys: inactive DeepSeek key survives Kimi sessions");
  assertEqual(dualStorage.apiKey, KIMI_KEY, "1.4.x dual keys: apiKey mirrors the active provider's key");

  // ---- Popup load path (vm + DOM mock): open on legacy storage, then
  // re-open on the result — keys must never be wiped by the popup save ----
  {
    // 1.3.x storage + popup open → migration persists, status row shows the tail.
    const legacyPopupStorage = { apiKey: LEGACY_KEY, model: "deepseek-v4-flash" };
    const testRequests = [];
    const popup1 = createPopupVm(legacyPopupStorage, {
      runtimeMessageHandler: async (message) => {
        if (message?.type === "TEST_CONNECTION") {
          testRequests.push(message);
          return { ok: true };
        }
        return { ok: false };
      }
    });
    await popup1.hooks.initializePromise;
    assertEqual(legacyPopupStorage.deepseekApiKey, LEGACY_KEY, "popup load 1.3.x: legacy key persisted as deepseekApiKey");
    assertEqual(legacyPopupStorage.apiKey, LEGACY_KEY, "popup load 1.3.x: selection-gate mirror carries the key");
    assertEqual(legacyPopupStorage.model, "deepseek-flash", "popup load 1.3.x: legacy model name migrated");
    assertEqual(popup1.dom.get("api-key").value, LEGACY_KEY, "popup load 1.3.x: key input shows the migrated key");
    assertEqual(
      popup1.dom.get("key-status-deepseek-value").textContent,
      `已配置 · 尾号 ${LEGACY_KEY.slice(-4)}`,
      "popup key status: DeepSeek row shows 已配置 with the key tail"
    );
    assertEqual(
      popup1.dom.get("key-status-kimi-value").textContent,
      "未配置",
      "popup key status: Kimi row shows 未配置 when no key exists"
    );

    // Re-open the popup on the migrated storage: values stay put (no wipe).
    const popup2 = createPopupVm(legacyPopupStorage);
    await popup2.hooks.initializePromise;
    assertEqual(legacyPopupStorage.deepseekApiKey, LEGACY_KEY, "popup reopen: migrated key not wiped");

    // Kimi-only 1.4.x storage through the popup.
    const kimiPopupStorage = { provider: "kimi", kimiApiKey: KIMI_KEY, apiKey: KIMI_KEY, model: "kimi-k2.6" };
    const popup3 = createPopupVm(kimiPopupStorage);
    await popup3.hooks.initializePromise;
    assertEqual(kimiPopupStorage.kimiApiKey, KIMI_KEY, "popup load 1.4.x kimi: kimi key not wiped");
    assertEqual(String(kimiPopupStorage.deepseekApiKey || ""), "", "popup load 1.4.x kimi: no phantom DeepSeek key appears");
    assertEqual(
      popup3.dom.get("key-status-kimi-value").textContent,
      `已配置 · 尾号 ${KIMI_KEY.slice(-4)}`,
      "popup key status: Kimi row shows 已配置 with the key tail"
    );

    // Paste flow: format gate before network, auto-save, then connection test.
    // Seeded with BOTH providers' keys so the auto-save also proves that
    // saving the active provider never clobbers the inactive one's key.
    const pasteStorage = {
      provider: "deepseek",
      deepseekApiKey: DEEPSEEK_KEY,
      kimiApiKey: KIMI_KEY,
      apiKey: DEEPSEEK_KEY,
      model: "deepseek-flash",
      targetLanguage: "zh-CN",
      displayMode: "bilingual"
    };
    const pastePopup = createPopupVm(pasteStorage, {
      runtimeMessageHandler: async (message) => {
        if (message?.type === "TEST_CONNECTION") {
          testRequests.push(message);
          return { ok: true };
        }
        return { ok: false };
      }
    });
    await pastePopup.hooks.initializePromise;
    const pasteDom = pastePopup.dom;
    pasteDom.get("api-key").value = "not-a-key";
    await pastePopup.hooks.handleApiKeyPasted();
    assertEqual(testRequests.length, 0, "paste flow: format-invalid key must not hit the network");
    assertEqual(pasteDom.get("status-title").textContent, "Key 格式错误", "paste flow: format error surfaces a clear title");
    assertTrue(
      String(pasteDom.get("status-detail").textContent).includes("sk-"),
      "paste flow: format error explains the expected shape"
    );
    assertEqual(pastePopup.storage.deepseekApiKey, "not-a-key", "paste flow: invalid-shape paste is still saved locally (no silent drop)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(pasteDom.get("key-guide").hidden, false, "paste flow: correction guide stays visible after async save of a malformed key");
    assertEqual(pastePopup.storage.kimiApiKey, KIMI_KEY, "paste flow: saving the DeepSeek input never wipes the stored Kimi key");

    pasteDom.get("api-key").value = DEEPSEEK_KEY;
    await pastePopup.hooks.handleApiKeyPasted();
    assertEqual(testRequests.length, 1, "paste flow: well-formed key triggers exactly one connection test");
    assertEqual(testRequests[0].type, "TEST_CONNECTION", "paste flow: verification goes through the background message path");
    assertEqual(pasteDom.get("status-title").textContent, "Key 有效", "paste flow: success surfaces a clear title");
    assertEqual(pastePopup.storage.deepseekApiKey, DEEPSEEK_KEY, "paste flow: pasted key auto-saved");
    assertEqual(pastePopup.storage.kimiApiKey, KIMI_KEY, "paste flow: auto-save keeps the inactive provider's key");
    assertEqual(
      pasteDom.get("key-status-deepseek-value").textContent,
      `已配置 · 尾号 ${DEEPSEEK_KEY.slice(-4)}`,
      "paste flow: key status refreshes after save"
    );
  }

  // ---- Passive status polling must not cancel an in-flight key test ----
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pollPopup = createPopupVm(
      { provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: "", model: "deepseek-flash" },
      { runtimeMessageHandler: async (message) => (message?.type === "TEST_CONNECTION" ? gate : { ok: false }) }
    );
    await pollPopup.hooks.initializePromise;
    const testDone = pollPopup.hooks.runKeyConnectionTest();
    pollPopup.hooks.renderTranslationStatus({ active: false });
    assertTrue(
      String(pollPopup.dom.get("status-title").textContent).startsWith("正在验证"),
      "poll: passive status update is suppressed while a key test is in flight"
    );
    release({ ok: true });
    await testDone;
    assertEqual(pollPopup.dom.get("status-title").textContent, "Key 有效", "poll: key test result survives a concurrent poll");
    pollPopup.hooks.renderTranslationStatus({ active: false });
    assertEqual(pollPopup.dom.get("status-title").textContent, "准备就绪", "poll: passive updates resume after the test completes");
  }

  // ---- Stale view must not restore an old key over a newer one ----
  {
    const shared = { provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, model: "deepseek-flash" };
    const stale = createPopupVm(shared);
    await stale.hooks.initializePromise;
    const NEWER = fakeKey("rotated", 24);
    stale.emitStorageChange({ deepseekApiKey: { oldValue: DEEPSEEK_KEY, newValue: NEWER } });
    await stale.hooks.saveSettings();
    assertEqual(stale.storage.deepseekApiKey, NEWER, "stale view: save after an external key change keeps the newer key");
    assertEqual(stale.storage.kimiApiKey, KIMI_KEY, "stale view: other provider key untouched");
    stale.emitStorageChange({ provider: { oldValue: "deepseek", newValue: "kimi" }, model: { oldValue: "deepseek-flash", newValue: "kimi-k2.6" }, targetLanguage: { oldValue: "zh-CN", newValue: "ja" } });
    await stale.hooks.saveSettings();
    assertEqual(stale.storage.provider, "kimi", "stale view: explicit save keeps provider changed in another view");
    assertEqual(stale.storage.model, "kimi-k2.6", "stale view: explicit save keeps model changed in another view");
    assertEqual(stale.storage.targetLanguage, "ja", "stale view: explicit save keeps target language changed in another view");
    {
      const pendingView = createPopupVm({ provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, model: "deepseek-flash", targetLanguage: "zh-CN" });
      await pendingView.hooks.initializePromise;
      const EDITED = fakeKey("edited", 24);
      pendingView.dom.get("api-key").value = EDITED; // local key edit not yet saved
      pendingView.emitStorageChange({ model: { oldValue: "deepseek-flash", newValue: "deepseek-v4-pro" }, targetLanguage: { oldValue: "zh-CN", newValue: "ko" } });
      await pendingView.hooks.saveSettings();
      assertEqual(pendingView.storage.deepseekApiKey, EDITED, "pending edit: local key edit is saved");
      assertEqual(pendingView.storage.model, "deepseek-v4-pro", "pending edit: external model change survives the save");
      assertEqual(pendingView.storage.targetLanguage, "ko", "pending edit: external language change survives the save");
    }
    {
      const focused = createPopupVm({ provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, model: "deepseek-flash" });
      await focused.hooks.initializePromise;
      focused.sandbox.document.activeElement = focused.dom.get("api-key"); // focus, no edit
      const ROTATED2 = fakeKey("rotatedtwo", 24);
      focused.emitStorageChange({ deepseekApiKey: { oldValue: DEEPSEEK_KEY, newValue: ROTATED2 } });
      await focused.hooks.saveSettings(); // e.g. blur
      assertEqual(focused.storage.deepseekApiKey, ROTATED2, "focus only: external key update applies and blur-save keeps it");
    }
    let releaseStale;
    const staleGate = new Promise((resolve) => { releaseStale = resolve; });
    const racing = createPopupVm(
      { provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, model: "deepseek-flash" },
      { runtimeMessageHandler: async (message) => (message?.type === "TEST_CONNECTION" ? staleGate : { ok: false }) }
    );
    await racing.hooks.initializePromise;
    const pending = racing.hooks.runKeyConnectionTest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    racing.emitStorageChange({ deepseekApiKey: { oldValue: DEEPSEEK_KEY, newValue: NEWER } });
    releaseStale({ ok: true });
    await pending;
    assertTrue(
      racing.dom.get("status-title").textContent !== "Key 有效",
      "stale view: external key change supersedes an in-flight test result"
    );
  }

  // ---- Settings import/export (popup vm): schema validation + no-wipe merge ----
  {
    const storage = {
      provider: "deepseek",
      deepseekApiKey: DEEPSEEK_KEY,
      kimiApiKey: KIMI_KEY,
      apiKey: DEEPSEEK_KEY,
      model: "deepseek-flash",
      targetLanguage: "zh-CN",
      displayMode: "bilingual"
    };
    const popup = createPopupVm(storage);
    await popup.hooks.initializePromise;

    // Export: keys excluded by default; opt-in carries BOTH provider keys
    // (regression: providerKeys is keyed by provider id, not field name).
    {
      const base = { provider: "deepseek", targetLanguage: "zh-CN", model: "deepseek-flash", displayMode: "bilingual" };
      const noKeys = popup.hooks.buildExportPayload(base, false).settings;
      if ("deepseekApiKey" in noKeys || "kimiApiKey" in noKeys) {
        fail("export: keys must be excluded unless opted in");
      }
      const withKeys = popup.hooks.buildExportPayload(base, true).settings;
      if (withKeys.deepseekApiKey !== DEEPSEEK_KEY || withKeys.kimiApiKey !== KIMI_KEY) {
        fail("export: opt-in must include both stored provider keys");
      }
      const roundTrip = popup.hooks.parseImportedSettings(popup.hooks.buildExportPayload(base, true));
      if (roundTrip.deepseekApiKey !== DEEPSEEK_KEY || roundTrip.kimiApiKey !== KIMI_KEY) {
        fail("export→import round trip must preserve opted-in keys");
      }
    }

    // Provider-only import must not leave the other provider's model.
    {
      const p2 = createPopupVm({ provider: "deepseek", deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: KIMI_KEY, model: "deepseek-flash" });
      await p2.hooks.initializePromise;
      await p2.hooks.applyImportedSettings({ provider: "kimi" });
      if (p2.storage.model !== "kimi-k2.6") {
        fail(`import: provider-only import must normalize model to kimi default, got ${p2.storage.model}`);
      }
      if (p2.storage.deepseekApiKey !== DEEPSEEK_KEY || p2.storage.kimiApiKey !== KIMI_KEY) {
        fail("import: provider-only import must keep both keys");
      }
    }

    // parseImportedSettings: happy paths and every rejection reason.
    const goodFile = {
      format: "kilocean-translate-settings",
      version: 1,
      settings: { provider: "kimi", targetLanguage: "ja", model: "deepseek-v4-flash", displayMode: "translation-only" }
    };
    assertEqual(
      popup.hooks.parseImportedSettings(goodFile),
      { provider: "kimi", targetLanguage: "ja", displayMode: "translation-only", model: "deepseek-flash" },
      "import parse: valid file passes with legacy model mapped"
    );
    assertEqual(
      popup.hooks.parseImportedSettings({ format: "kilocean-translate-settings", version: 1, settings: {} }),
      {},
      "import parse: key-less file parses to an empty field set"
    );
    assertEqual(
      popup.hooks.parseImportedSettings({
        format: "kilocean-translate-settings",
        version: 1,
        settings: { deepseekApiKey: DEEPSEEK_KEY, kimiApiKey: "" }
      }),
      { deepseekApiKey: DEEPSEEK_KEY },
      "import parse: blank key field counts as absent, valid key imports"
    );
    const rejectsWith = (parsed, needle, label) => {
      try {
        popup.hooks.parseImportedSettings(parsed);
        fail(`${label}: expected rejection`);
      } catch (error) {
        assertTrue(
          String(error.message).includes(needle),
          `${label}: rejection must mention "${needle}", got "${error.message}"`
        );
      }
    };
    rejectsWith(null, "设置对象", "import parse: non-object");
    rejectsWith({ format: "other", version: 1, settings: {} }, "format", "import parse: wrong format field");
    rejectsWith({ format: "kilocean-translate-settings", version: 2, settings: {} }, "版本", "import parse: unknown version");
    rejectsWith({ format: "kilocean-translate-settings", version: 1 }, "settings", "import parse: missing settings object");
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { bogus: "x" } },
      "无法识别的字段",
      "import parse: unknown field"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { provider: 7 } },
      "字符串",
      "import parse: non-string field"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { provider: "openai" } },
      "服务商",
      "import parse: provider enum"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { targetLanguage: "fr" } },
      "目标语言",
      "import parse: target language enum"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { displayMode: "dual" } },
      "显示模式",
      "import parse: display mode enum"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { model: "gpt-4o" } },
      "模型",
      "import parse: model not allowed"
    );
    rejectsWith(
      { format: "kilocean-translate-settings", version: 1, settings: { deepseekApiKey: "nope" } },
      "格式不正确",
      "import parse: malformed key rejects the file"
    );

    // applyImportedSettings without keys: fields merge, keys untouched.
    await popup.hooks.applyImportedSettings({ targetLanguage: "ja", displayMode: "translation-only" });
    assertEqual(storage.targetLanguage, "ja", "import apply: file fields overwrite storage");
    assertEqual(storage.displayMode, "translation-only", "import apply: display mode overwrites storage");
    assertEqual(storage.deepseekApiKey, DEEPSEEK_KEY, "import apply (key-less file): DeepSeek key not wiped");
    assertEqual(storage.kimiApiKey, KIMI_KEY, "import apply (key-less file): Kimi key not wiped");
    assertEqual(storage.apiKey, DEEPSEEK_KEY, "import apply (key-less file): mirror keeps the active key");

    // applyImportedSettings with keys + provider switch.
    const NEW_DEEPSEEK = fakeKey("newdeepseek", 19);
    const NEW_KIMI = fakeKey("newkimi", 23);
    await popup.hooks.applyImportedSettings({
      provider: "kimi",
      model: "kimi-k3",
      deepseekApiKey: NEW_DEEPSEEK,
      kimiApiKey: NEW_KIMI
    });
    assertEqual(storage.provider, "kimi", "import apply: provider switches");
    assertEqual(storage.model, "kimi-k3", "import apply: model switches");
    assertEqual(storage.deepseekApiKey, NEW_DEEPSEEK, "import apply: file-provided DeepSeek key imports");
    assertEqual(storage.kimiApiKey, NEW_KIMI, "import apply: file-provided Kimi key imports");
    assertEqual(storage.apiKey, NEW_KIMI, "import apply: mirror follows the switched provider");
    assertEqual(
      popup.hooks.getProviderKeys(),
      { deepseek: NEW_DEEPSEEK, kimi: NEW_KIMI },
      "import apply: in-memory provider keys match storage"
    );
    assertEqual(
      popup.dom.get("key-status-kimi-value").textContent,
      `已配置 · 尾号 ${NEW_KIMI.slice(-4)}`,
      "import apply: key status re-renders"
    );
  }

  // ---- Static: export uses blob + <a download>, never chrome.downloads ----
  const popupScan = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"));
  if (!/addEventListener\("pagehide",\s*flushPendingPersist\)/.test(popupScan)) {
    fail("popup.js: pagehide must only flush pending edits (no stale full-settings write)");
  }
  // Import must not run its file chooser inside the transient action popup
  // (crbug 364825891): popup opens popup.html?view=settings as a tab.
  if (!/view=settings/.test(popupScan) || !/chrome\.tabs\.create\(/.test(popupScan) || !/IS_SETTINGS_TAB/.test(popupScan)) {
    fail("popup.js: settings import must run from an extension tab (view=settings), not the action popup");
  }
  if (!/new Blob\(/.test(popupScan) || !/createObjectURL\(/.test(popupScan) || !/\.download\s*=/.test(popupScan)) {
    fail("popup.js: settings export must use Blob + <a download> (no downloads permission)");
  }
  if (/chrome\.downloads/.test(popupScan)) {
    fail("popup.js: settings export must not touch chrome.downloads");
  }
  if (!/包含 API Key/.test(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"))) {
    fail("popup.html: export opt-in checkbox with the 明文保存 warning must exist");
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
  // Ownership is the module-level ownedOriginalWraps WeakSet, injected here
  // exactly like the shipping code reads it: fake wraps must be registered
  // members, a page-owned same-attribute node must NOT be.
  const ownedOriginalWraps = new WeakSet();
  try {
    hasHiddenAncestor = new Function(
      "getComputedStyle",
      "ownedOriginalWraps",
      `${ownedSrc}\n${hiddenSrc}\n${hasHiddenSrc}\nreturn hasHiddenAncestor;`
    )(
      (el) => ({ display: el.__display, visibility: el.__visibility || "visible" }),
      ownedOriginalWraps
    );
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
  // Only extension-created wraps enter the set (wrapTextNodesForToggle does
  // this at creation); page-owned nodes never do.
  ownedOriginalWraps.add(wrap);
  ownedOriginalWraps.add(visibleWrapInHiddenSection);
  const pageSpoofedHiddenWrap = {
    __display: "none",
    parentElement: plain,
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
    hasHiddenAncestor({ parentElement: pageSpoofedHiddenWrap }),
    "refresh compare: page-owned hidden span carrying data-kilocean-original-wrap is not ours — its text stays uncollected (no hidden-content bypass)"
  );
  assertTrue(
    hasHiddenAncestor({ parentElement: visibleWrapInHiddenSection }),
    "refresh compare: page-hidden ancestor above the wrap still hides its text"
  );
  assertFalse(
    hasHiddenAncestor({ parentElement: { __display: "block", parentElement: null, hasAttribute: () => false } }),
    "refresh compare: fully visible chain stays visible"
  );
  // Ownership must be WeakSet-based, not attribute-based: the shipping code
  // registers created wraps and checks membership only.
  if (!/ownedOriginalWraps\.add\(wrap\)/.test(content)) {
    fail("content.js: wrapTextNodesForToggle must register every created wrap in the ownedOriginalWraps WeakSet");
  }
  if (!/ownedOriginalWraps\.has\(el\)/.test(stripCommentsForScan(ownedSrc))) {
    fail("content.js: isOwnedOriginalWrap must decide ownership via the ownedOriginalWraps WeakSet, not the page-settable attribute");
  }

  // ---- (6b) repairBlockRecordDom rebuilds owned DOM without re-billing ----
  const repairSrc = extractContentFunction("repairBlockRecordDom");
  if (!repairSrc) {
    fail("content.js: cannot extract repairBlockRecordDom for rebuild test");
    return;
  }
  // hasUnwrappedOriginalTextNode is injected as a controllable stub: the
  // real one only needs a document, which the standalone harness lacks.
  let wrapCalls = 0;
  let relocateCalls = 0;
  let unwrappedSource = false;
  let repairBlockRecordDom;
  try {
    repairBlockRecordDom = new Function(
      "beginApplyingDom",
      "endApplyingDom",
      "wrapTextNodesForToggle",
      "relocateAfterHostCompanion",
      "hasUnwrappedOriginalTextNode",
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
      },
      () => unwrappedSource
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
  assertEqual(
    swappedRecord.wraps.length,
    3,
    "repair: rebuilt record keeps the still-connected old wrap plus the new wraps (teardown must unwrap both)"
  );
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
  // SPA re-render planted a bare source node outside every owned wrap while
  // the recorded wraps stayed connected: repair must rebuild for it too, or
  // the node would show untranslated in translation-only mode.
  unwrappedSource = true;
  const bareNodeRecord = {
    block: makeBlock(),
    wraps: [{ isConnected: true, original: true }],
    companion: { isConnected: true },
    layout: "flow",
    nested: []
  };
  repairBlockRecordDom(bareNodeRecord);
  assertEqual(wrapCalls, 2, "repair: connected wraps alone do not skip the rebuild when a source node sits outside them");
  assertEqual(
    bareNodeRecord.wraps.length,
    3,
    "repair: rebuild for unwrapped source keeps the connected wrap and adds the new ones"
  );
  if (!bareNodeRecord.wraps.some((wrap) => wrap.original === true)) {
    fail("repair: the still-connected owned wrap must stay referenced after the partial rebuild");
  }
  assertEqual(bareNodeRecord.block.appended, null, "repair: connected companion is not re-inserted on partial rebuild");
  unwrappedSource = false;
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

  // The rebuild trigger itself: a live eligible source text node whose parent
  // is not an owned wrap — with the same nested/interactive exclusions
  // wrapTextNodesForToggle applies. Dependency-injected so it runs without a
  // document.
  const unwrappedCheckSrc = extractContentFunction("hasUnwrappedOriginalTextNode");
  if (!unwrappedCheckSrc) {
    fail("content.js: cannot extract hasUnwrappedOriginalTextNode for rebuild test");
    return;
  }
  let hasUnwrappedOriginalTextNode;
  try {
    hasUnwrappedOriginalTextNode = new Function(
      "collectRawTextNodes",
      "isOwnedOriginalWrap",
      "isInsideInteractiveDescendant",
      "INTERACTIVE_TAGS",
      `${unwrappedCheckSrc}\nreturn hasUnwrappedOriginalTextNode;`
    )(
      (block) => block.textNodes,
      (el) => Boolean(el?.isOwnedWrap),
      () => false,
      new Set(["BUTTON"])
    );
  } catch (error) {
    fail(`content.js: hasUnwrappedOriginalTextNode is not runnable standalone: ${error.message}`);
    return;
  }
  const inOwnedWrap = { parentElement: { isOwnedWrap: true } };
  const bareTextNode = { parentElement: { isOwnedWrap: false } };
  const checkBlock = { tagName: "DIV", textNodes: [inOwnedWrap] };
  assertFalse(
    hasUnwrappedOriginalTextNode(checkBlock, []),
    "repair trigger: fully wrapped source text does not force a rebuild"
  );
  checkBlock.textNodes = [inOwnedWrap, bareTextNode];
  assertTrue(
    hasUnwrappedOriginalTextNode(checkBlock, []),
    "repair trigger: a bare source node next to owned wraps forces a rebuild"
  );
  checkBlock.textNodes = [inOwnedWrap, { parentElement: { isOwnedWrap: false }, nestedOwned: true }];
  assertFalse(
    hasUnwrappedOriginalTextNode(checkBlock, [{ contains: (node) => Boolean(node.nestedOwned) }]),
    "repair trigger: text owned by a nested recorded block never forces a rebuild"
  );
  checkBlock.textNodes = [];
  assertFalse(
    hasUnwrappedOriginalTextNode(checkBlock, []),
    "repair trigger: a block without source text nodes never forces a rebuild"
  );

  // scheduleDynamicTranslation: unchanged source → repair; changed → discard.
  const schedSrc = extractContentFunction("scheduleDynamicTranslation");
  if (!schedSrc) {
    fail("content.js: cannot extract scheduleDynamicTranslation for refresh test");
    return;
  }
  const schedOrder = stripCommentsForScan(schedSrc);
  const repairAt = schedOrder.indexOf("repairBlockRecordDom(");
  // The comparison must extract the way record.originalText was captured:
  // with record.nested (separately-translated descendants) excluded.
  const compareAt = schedOrder.indexOf(
    "extractBlockText(block, record.nested || []) === record.originalText"
  );
  const bareCompareAt = schedOrder.indexOf("extractBlockText(block) === record.originalText");
  const discardAt = schedOrder.indexOf("discardBlockRecord(");
  if (repairAt < 0 || compareAt < 0 || discardAt < 0 || compareAt > repairAt || compareAt > discardAt) {
    fail("content.js: refresh flush must compare extractBlockText (excluding record.nested) to the recorded original first, then repair (unchanged) or discard (changed)");
  }
  if (bareCompareAt >= 0) {
    fail("content.js: refresh flush must not compare the bare-block text — a translated nested descendant would then always look like a source change (teardown + re-bill)");
  }

  // Functional: an ancestor with direct text plus a translated descendant
  // must not misdetect a source change. Runs the shipping extractBlockText
  // with collectRawTextNodes/joinRawTextNodes injected (the standalone
  // harness has no document); the nested block owns one text node exactly
  // like a separately-translated descendant record would.
  const extractBlockSrc = extractContentFunction("extractBlockText");
  if (!extractBlockSrc) {
    fail("content.js: cannot extract extractBlockText for refresh-compare test");
    return;
  }
  let extractBlockText;
  try {
    extractBlockText = new Function(
      "collectRawTextNodes",
      "joinRawTextNodes",
      `${extractBlockSrc}\nreturn extractBlockText;`
    )(
      (block) => block.textNodes,
      (nodes) => nodes.map((node) => node.data).join(" ").trim()
    );
  } catch (error) {
    fail(`content.js: extractBlockText is not runnable standalone: ${error.message}`);
    return;
  }
  const nestedTextNode = { data: "nested block text" };
  const nestedBlock = { contains: (node) => node === nestedTextNode };
  const ancestorBlock = {
    textNodes: [{ data: "direct ancestor text" }, nestedTextNode]
  };
  // Capture path (translateBlocks): the record's originalText excludes nested.
  const record = {
    nested: [nestedBlock],
    originalText: extractBlockText(ancestorBlock, [nestedBlock])
  };
  assertEqual(record.originalText, "direct ancestor text", "refresh compare: recorded original excludes the nested descendant's text");
  // Refresh path (scheduleDynamicTranslation): same extraction shape — the
  // translated descendant's still-present source does not look like a change.
  assertTrue(
    extractBlockText(ancestorBlock, record.nested || []) === record.originalText,
    "refresh compare: ancestor with direct text + translated descendant is not misdetected as changed"
  );
  // The exclusion is what saves it: the bare-block shape (old bug) sweeps in
  // the descendant's text and would always mismatch the record.
  assertFalse(
    extractBlockText(ancestorBlock) === record.originalText,
    "refresh compare: bare-block extraction sweeps in the nested descendant's text (must not be used for comparison)"
  );

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

// ---- P1: SPA flush race — 450 ms dynamic debounce vs 500 ms URL poll ----
// A pushState route swap landing between poll ticks must not let the queued
// dynamic flush issue requests under the pre-navigation generation (they
// would stay billed and be re-billed by the poll-time re-discovery). The
// flush has to reconcile location.href with lastSeenUrl synchronously, route
// through handleSpaNavigation (generation bump + re-queue from document.body),
// and stop. popstate/hashchange only accelerate the same check.
async function checkSpaFlushRaceGuard() {
  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  const watchSrc = extractContentFunction("setupSpaNavigationWatch");
  const spaUrlSrc = extractContentFunction("spaNavigationUrl");
  const checkSrc = extractContentFunction("checkSpaNavigation");
  const schedSrc = extractContentFunction("scheduleDynamicTranslation");
  if (!watchSrc || !spaUrlSrc || !checkSrc || !schedSrc) {
    fail("content.js: cannot extract SPA watch/flush functions for flush-race test");
    return;
  }

  // Accelerators: popstate AND hashchange both trigger the same URL check
  // (plain window events — safe from the content-script isolated world).
  // Comments are stripped first so the check needs the real addEventListener
  // calls, not a comment mentioning the event names.
  const watchCode = stripCommentsForScan(watchSrc);
  if (!/popstate/.test(watchCode) || !/hashchange/.test(watchCode)) {
    fail("content.js: setupSpaNavigationWatch must listen to popstate and hashchange to accelerate SPA URL detection");
  }

  // checkSpaNavigation reports whether it handled a navigation so the flush
  // can tell "reconciled, stop" from "no change, proceed".
  if (!/return false/.test(checkSrc) || !/return true/.test(checkSrc)) {
    fail("content.js: checkSpaNavigation must return whether a navigation was handled (flush race guard)");
  }

  // Static ordering: the URL reconciliation sits inside the timer callback —
  // after the debounce is armed, before any pruning / refresh processing /
  // translateBlocks queueing. A check placed at schedule time could not see a
  // pushState that happens during the 450 ms window.
  const schedOrder = stripCommentsForScan(schedSrc);
  const armAt = schedOrder.indexOf("dynamicTimer = setTimeout");
  const guardAt = schedOrder.indexOf("checkSpaNavigation()");
  const pruneAt = schedOrder.indexOf("pruneDetachedBlockRecords()");
  const refreshAt = schedOrder.indexOf("pendingRefreshBlocks");
  const translateAt = schedOrder.indexOf("translateBlocks(");
  if (armAt < 0 || guardAt < 0 || pruneAt < 0 || refreshAt < 0 || translateAt < 0 ||
      guardAt < armAt || pruneAt < guardAt || refreshAt < guardAt || translateAt < guardAt) {
    fail("content.js: dynamic flush must reconcile the SPA URL (checkSpaNavigation) after arming and before any flush work");
  }

  // Functional race: the shipping scheduleDynamicTranslation +
  // spaNavigationUrl + checkSpaNavigation run together; stubs record what the
  // flush dared to do. handleSpaNavigation mirrors the real handler's
  // contract (asserted statically in checkSpaNavigationAndSelectionStatics):
  // bump the generation, drop stale pendingRoots, re-arm discovery from
  // document.body.
  const makeHarness = () => {
    const staleRoot = { id: "stale-root" };
    const bodyRoot = { id: "body-root" };
    const fakeBlock = { id: "new-route-block" };
    let harness;
    try {
      harness = new Function(
        "staleRoot",
        "bodyRoot",
        "fakeBlock",
        `
        const location = { href: "https://x.com/home" };
        let lastSeenUrl = location.href;
        const timers = [];
        const flushes = [];
        const navigations = [];
        const prunes = [];
        const state = { active: true, phase: "translated" };
        const pendingRoots = new Set();
        const pendingRefreshBlocks = new Set();
        const blockRecords = new Map();
        let dynamicTimer = null;
        let generation = 0;
        let workQueue = Promise.resolve();
        const setTimeout = (fn) => { timers.push(fn); return timers.length; };
        const clearTimeout = () => {};
        const notifyPopupStatus = () => {};
        const pruneDetachedBlockRecords = () => { prunes.push(1); };
        const extractBlockText = () => { throw new Error("refresh compare must not run in this harness"); };
        const repairBlockRecordDom = () => { throw new Error("repair must not run in this harness"); };
        const discardBlockRecord = () => { throw new Error("discard must not run in this harness"); };
        const collectBlocks = (root) => (root === staleRoot || root === bodyRoot ? [fakeBlock] : []);
        const finalizeDynamicPhase = () => {};
        const translateBlocks = (blocks, runId, isDynamic) => {
          flushes.push({ blocks, runId, isDynamic });
          return Promise.resolve();
        };
        function handleSpaNavigation() {
          if (!state.active) {
            return;
          }
          navigations.push(location.href);
          generation += 1;
          pendingRoots.clear();
          pendingRoots.add(bodyRoot);
          scheduleDynamicTranslation();
        }
        ${spaUrlSrc}
        ${checkSrc}
        ${schedSrc}
        return {
          location,
          pendingRoots,
          scheduleDynamicTranslation,
          fireTimer: async () => {
            const fn = timers.shift();
            if (fn) {
              fn();
            }
            // The flush queues translateBlocks on the workQueue promise
            // chain — let those microtasks settle before asserting.
            await new Promise((resolve) => setImmediate(resolve));
          },
          armedTimers: () => timers.length,
          flushes,
          navigations,
          pruneCount: () => prunes.length,
          generationNow: () => generation
        };
        `
      )(staleRoot, bodyRoot, fakeBlock);
    } catch (error) {
      fail(`content.js: SPA flush-race harness cannot run the shipping functions: ${error.message}`);
      return null;
    }
    return { harness, staleRoot, bodyRoot, fakeBlock };
  };

  // Race: mutations of the NEW route queue under the old URL, pushState lands
  // during the 450 ms window (no poll tick yet), then the debounce fires.
  const raced = makeHarness();
  if (!raced) {
    return;
  }
  raced.harness.pendingRoots.add(raced.staleRoot);
  raced.harness.scheduleDynamicTranslation();
  raced.harness.location.href = "https://x.com/explore";
  await raced.harness.fireTimer();
  assertEqual(raced.harness.navigations, ["https://x.com/explore"], "SPA flush race: flush must run the navigation handler synchronously");
  assertEqual(raced.harness.flushes.length, 0, "SPA flush race: stale flush must not queue translateBlocks under the old generation");
  assertEqual(raced.harness.pruneCount(), 0, "SPA flush race: stale flush must stop before any of its own work");
  assertEqual(raced.harness.generationNow(), 1, "SPA flush race: navigation handler must bump the generation");
  assertEqual(raced.harness.armedTimers(), 1, "SPA flush race: navigation handler must re-arm dynamic discovery");
  assertEqual([...raced.harness.pendingRoots], [raced.bodyRoot], "SPA flush race: discovery must be re-queued from document.body, dropping stale roots");

  // The re-queued flush runs under the new generation and translates normally.
  await raced.harness.fireTimer();
  assertEqual(raced.harness.flushes, [{ blocks: [raced.fakeBlock], runId: 1, isDynamic: true }], "SPA flush race: re-queued flush translates under the new generation");
  assertEqual(raced.harness.navigations.length, 1, "SPA flush race: unchanged URL must not re-navigate");
  assertEqual(raced.harness.armedTimers(), 0, "SPA flush race: clean flush leaves no stray debounce");

  // Control: no URL change — the flush proceeds directly, no navigation.
  const control = makeHarness();
  if (!control) {
    return;
  }
  control.harness.pendingRoots.add(control.staleRoot);
  control.harness.scheduleDynamicTranslation();
  await control.harness.fireTimer();
  assertEqual(control.harness.flushes, [{ blocks: [control.fakeBlock], runId: 0, isDynamic: true }], "SPA flush control: unchanged URL flushes without navigation");
  assertEqual(control.harness.navigations.length, 0, "SPA flush control: no navigation recorded");
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

  // ---- Per-attempt timeout: a real timeout must be retryable in-budget ----
  // Every attempt gets min(MAX_ATTEMPT_TIMEOUT_MS, remaining − reserve), never
  // the whole remaining total budget — or a hung first attempt would eat all
  // 30s alone and no timeout retry could ever fit. Spy on fetchWithTimeout to
  // observe the per-attempt deadlines without wall-clock hangs (restore it in
  // a finally: every check shares the one cached shared.js module instance).
  if (utils.MAX_ATTEMPT_TIMEOUT_MS !== 10000) {
    fail(`deadline budget: MAX_ATTEMPT_TIMEOUT_MS must be 10000ms, got ${JSON.stringify(utils.MAX_ATTEMPT_TIMEOUT_MS)}`);
  }
  const originalFetchWithTimeout = utils.fetchWithTimeout;
  const runTimeoutRetry = async (totalBudgetMs, timeoutsBeforeSuccess) => {
    const attemptTimeouts = [];
    let fetchCalls = 0;
    utils.fetchWithTimeout = async (url, options, timeoutMs, signal) => {
      fetchCalls += 1;
      attemptTimeouts.push(timeoutMs);
      if (fetchCalls <= timeoutsBeforeSuccess) {
        throw createFetchTimeoutError();
      }
      return jsonResponse(200, okBody);
    };
    const clock = { now: 0 };
    try {
      const result = await harness({ ...deepseekStorage }).translateBatch(
        ["Hello"],
        "zh-CN",
        undefined,
        undefined,
        totalBudgetMs,
        { sleep: async (ms) => { clock.now += ms; }, now: () => clock.now }
      );
      return { ok: true, result, attemptTimeouts };
    } catch (error) {
      return { ok: false, error, attemptTimeouts };
    } finally {
      utils.fetchWithTimeout = originalFetchWithTimeout;
    }
  };

  const timeoutThenOk = await runTimeoutRetry(30000, 1);
  if (!timeoutThenOk.ok) {
    fail(`translateBatch: a first-attempt timeout must be retried within the total budget, got ${JSON.stringify(timeoutThenOk.error?.message)}`);
  } else {
    assertEqual(timeoutThenOk.result, ["你好"], "translateBatch: timeout-retry returns translations");
    assertEqual(timeoutThenOk.attemptTimeouts.length, 2, "translateBatch: a retried timeout makes exactly 2 attempts");
    assertEqual(timeoutThenOk.attemptTimeouts[0], 10000, "translateBatch: attempt 1 deadline is capped at MAX_ATTEMPT_TIMEOUT_MS, not the whole 30s budget");
    assertEqual(timeoutThenOk.attemptTimeouts[1], 10000, "translateBatch: attempt 2 deadline stays capped while budget remains");
  }

  // A shrinking budget shrinks each attempt: min(10000, 5000−1000) = 4000,
  // then after the ~1s jittered backoff min(10000, remaining−1000) ∈ [2800, 3200].
  const shrinking = await runTimeoutRetry(5000, 1);
  if (!shrinking.ok) {
    fail(`translateBatch: timeout retry must still work in a 5s budget, got ${JSON.stringify(shrinking.error?.message)}`);
  } else {
    assertEqual(shrinking.attemptTimeouts[0], 4000, "translateBatch: attempt deadline is min(cap, remaining − MIN_ATTEMPT_BUDGET_MS reserve)");
    const second = shrinking.attemptTimeouts[1];
    if (typeof second !== "number" || second < 2800 || second > 3200) {
      fail(`translateBatch: second attempt deadline must shrink with the remaining budget into [2800, 3200], got ${JSON.stringify(second)}`);
    }
  }

  // Static: each attempt passes min(MAX_ATTEMPT_TIMEOUT_MS, remaining −
  // reserve) into fetchWithTimeout — never the whole remaining budget — and
  // the loop consults canRetryWithinBudget.
  const background = stripCommentsForScan(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  if (!/Math\.min\(\s*DeepSeekTranslatorUtils\.MAX_ATTEMPT_TIMEOUT_MS,\s*deadline - now\(\) - DeepSeekTranslatorUtils\.MIN_ATTEMPT_BUDGET_MS\s*\)/.test(background)) {
    fail("background.js: each attempt must cap its fetch deadline at min(MAX_ATTEMPT_TIMEOUT_MS, remaining − MIN_ATTEMPT_BUDGET_MS reserve)");
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
  const listeners = { installed: [], startup: [], message: [], tabsUpdated: [], tabsRemoved: [] };
  const storage = { ...storageData };
  const extensionId = "ci-test-extension-id";
  const chromeStub = {
    runtime: {
      id: extensionId,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
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
  const selectionMessage = (texts) => ({
    type: "SELECTION_TRANSLATE_BATCH",
    texts,
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

  // (8) SELECTION_TRANSLATE_BATCH joins the same per-tab gate: while MAX page
  // batches hold every slot, a selection from the same tab queues instead of
  // breaching the cap, and starts once a slot frees.
  try {
    const deferred = makeDeferredFetch();
    const vmSelQueue = buildBackgroundVm({ storageData: vmStorage, fetchImpl: deferred.fetchImpl });
    const pageResponses = [];
    for (let i = 0; i < MAX; i += 1) {
      pageResponses.push(vmSelQueue.sendMessage(batchMessage([`Hello page ${i}`]), 18));
    }
    const selectionResponse = vmSelQueue.sendMessage(selectionMessage(["Hello selection"]), 18);
    await tick();
    assertEqual(deferred.state.calls, MAX, "selection slot: selection queues while page batches hold every slot");
    assertEqual(deferred.state.maxInFlight, MAX, "selection slot: cap never exceeded with a selection in the queue");
    for (const entry of deferred.pending.splice(0)) {
      entry.resolve(vmJsonResponse(200, vmOkBody));
    }
    await tick();
    assertEqual(deferred.state.calls, MAX + 1, "selection slot: selection starts once a slot frees");
    for (const entry of deferred.pending.splice(0)) {
      entry.resolve(vmJsonResponse(200, vmOkBody));
    }
    const settled = await withTimeout(Promise.all([...pageResponses, selectionResponse]), "selection slot settle");
    if (!Array.isArray(settled) || settled.length !== MAX + 1 || settled.some((r) => r?.ok !== true)) {
      fail(`selection slot: every batch incl. the selection must resolve ok, got ${JSON.stringify(settled?.map((r) => r?.ok))}`);
    }
  } catch (error) {
    fail(`selection slot: vm harness failed: ${error.message}`);
  }

  // (9) Whole-tab reload during a selection's 429/5xx backoff cancels the
  // run: no further provider call may leave the worker for the dead document.
  try {
    const scaledSetTimeout = (fn, ms) => setTimeout(fn, Math.max(Math.min(ms ?? 0, 30000), 50));
    let selNavCalls = 0;
    const fetchSelBusy = async () => {
      selNavCalls += 1;
      return vmJsonResponse(503, '{"error":{"message":"down"}}');
    };
    const vmSelNav = buildBackgroundVm({
      storageData: vmStorage,
      fetchImpl: fetchSelBusy,
      setTimeoutImpl: scaledSetTimeout
    });
    const responsePromise = vmSelNav.sendMessage(selectionMessage(["Hello selection nav"]), 19);
    await tick();
    assertEqual(selNavCalls, 1, "selection nav cancel: first 503 attempt fired");
    // The backoff sleep (~1s, scaled to 50ms) is pending right now.
    vmSelNav.listeners.tabsUpdated[0](19, { status: "loading" }, { id: 19 });
    const response = await withTimeout(responsePromise, "selection nav cancel response");
    if (response?.ok !== false || response?.code !== "RUN_CANCELLED") {
      fail(`selection nav cancel: reload must cancel the selection run with RUN_CANCELLED, got ${JSON.stringify(response)}`);
    }
    // Long enough for a (buggy) post-cancel retry to have fired after the
    // scaled backoff elapsed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqual(selNavCalls, 1, "selection nav cancel: no fetch after the tab reloaded (selection backoff cancelled)");
  } catch (error) {
    fail(`selection nav cancel: vm harness failed: ${error.message}`);
  }

  // (10) Tab close during a selection's backoff: the sleep itself must be
  // abortable — the backoff here is scaled to ≥3s real, far past the 2s
  // response watchdog, so a non-abortable sleep cannot pass on timing alone —
  // and no further provider call may fire afterwards.
  try {
    const scaledSetTimeout = (fn, ms) => setTimeout(fn, Math.max(ms ?? 0, 3000));
    let selCloseCalls = 0;
    const fetchSelBusy = async () => {
      selCloseCalls += 1;
      return vmJsonResponse(503, '{"error":{"message":"down"}}');
    };
    const vmSelClose = buildBackgroundVm({
      storageData: vmStorage,
      fetchImpl: fetchSelBusy,
      setTimeoutImpl: scaledSetTimeout
    });
    const responsePromise = vmSelClose.sendMessage(selectionMessage(["Hello selection close"]), 20);
    await tick();
    assertEqual(selCloseCalls, 1, "selection close cancel: first 503 attempt fired");
    vmSelClose.listeners.tabsRemoved[0](20);
    const response = await withTimeout(responsePromise, "selection close cancel response");
    if (response?.ok !== false || response?.code !== "RUN_CANCELLED") {
      fail(`selection close cancel: closing the tab must cancel the selection run with RUN_CANCELLED, got ${JSON.stringify(response)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqual(selCloseCalls, 1, "selection close cancel: no fetch after the tab closed (selection backoff aborted)");
  } catch (error) {
    fail(`selection close cancel: vm harness failed: ${error.message}`);
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
  if (!/SELECTION_TRANSLATE_BATCH[\s\S]{0,900}?withTabTranslateSlot\(/.test(background)) {
    fail("background.js: SELECTION_TRANSLATE_BATCH must run under withTabTranslateSlot (per-tab cancellation for selection runs)");
  }
  if (!/await sleep\(retryDelay, signal\)/.test(background) || !/await sleep\(timeoutRetryDelay, signal\)/.test(background)) {
    fail("background.js: backoff sleeps must receive the abort signal so tab close/reload interrupts pending retries");
  }
  if (!/sleepSignal/.test(background)) {
    fail("background.js: the default backoff sleep must be abortable via the tab cancellation signal");
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

// ---- P2 security: pack path safety (symlinks, traversal, escapes) ----
async function checkPackPathSafety() {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, "scripts", "pack.mjs")).href);
  } catch (error) {
    fail(`scripts/pack.mjs: cannot be imported for path-safety test: ${error.message}`);
    return;
  }
  const { collectExtensionFiles, buildZip, normalizeEntryName } = mod;

  // The output write itself must stay symlink-safe and atomic: an O_EXCL
  // ("wx") temp file inside dist renamed over the destination — never a
  // writeFileSync directly on the output path (that would follow a planted
  // symlink and could leave a half-written zip behind).
  const packSource = fs.readFileSync(path.join(ROOT, "scripts", "pack.mjs"), "utf8");
  if (!/"wx"/.test(packSource) || !/renameSync\(/.test(packSource) || /writeFileSync\(\s*outPath/.test(packSource)) {
    fail("pack safety: output must be written via an O_EXCL temp file + rename (never writeFileSync on the output path)");
  }

  const assertEqual = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertRejects = (fn, label) => {
    try {
      fn();
    } catch {
      return;
    }
    fail(`${label}: expected pack to reject`);
  };

  // normalizeEntryName: benign shapes normalize, escaping shapes reject.
  assertEqual(normalizeEntryName("background.js"), "background.js", "normalizeEntryName: plain name");
  assertEqual(normalizeEntryName("./background.js"), "background.js", "normalizeEntryName: leading ./ collapses");
  assertEqual(normalizeEntryName("icons//16/./icon.png"), "icons/16/icon.png", "normalizeEntryName: duplicate separators and . segments collapse");
  assertRejects(() => normalizeEntryName("../escape.js"), "normalizeEntryName: leading ..");
  assertRejects(() => normalizeEntryName("a/../../escape.js"), "normalizeEntryName: mid ..");
  assertRejects(() => normalizeEntryName("sub/../../worker.js"), "normalizeEntryName: .. that would resolve inside root is still rejected");
  assertRejects(() => normalizeEntryName("/etc/passwd"), "normalizeEntryName: absolute unix path");
  assertRejects(() => normalizeEntryName("C:\\Windows\\evil.js"), "normalizeEntryName: windows drive path");
  assertRejects(() => normalizeEntryName("https://evil.example/x.js"), "normalizeEntryName: URL scheme");
  assertRejects(() => normalizeEntryName(""), "normalizeEntryName: empty");

  // Fixtures in a temp dir: a manifest referencing each hostile shape must
  // fail the pack, and nothing may be read from outside the root.
  const tempDirs = [];
  const writeFixture = (manifest) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilocean-pack-safety-"));
    tempDirs.push(rootDir);
    fs.writeFileSync(path.join(rootDir, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(rootDir, "worker.js"), "console.log('fixture');\n");
    return rootDir;
  };
  const baseManifest = {
    manifest_version: 3,
    name: "path-safety-fixture",
    version: "1.4.2",
    background: { service_worker: "worker.js" }
  };

  try {
    // Sanity: the benign fixture collects and zips.
    const okRoot = writeFixture(baseManifest);
    let okCollected;
    try {
      okCollected = collectExtensionFiles(okRoot);
    } catch (error) {
      fail(`pack safety: benign fixture must collect, got ${error.message}`);
      return;
    }
    try {
      buildZip(path.join(okRoot, "dist", "fixture.zip"), okRoot, okCollected.files);
    } catch (error) {
      fail(`pack safety: benign fixture must zip, got ${error.message}`);
    }

    // (1) Symlink entry — rejected by lstat even though it points back inside
    // the root (a swapped link is indistinguishable from an escape).
    const linkRoot = writeFixture({ ...baseManifest, background: { service_worker: "linked.js" } });
    fs.symlinkSync(path.join(linkRoot, "worker.js"), path.join(linkRoot, "linked.js"));
    assertRejects(() => collectExtensionFiles(linkRoot), "pack safety: symlinked entry must be rejected");

    // (2) Manifest traversal — ../outside.js exists (outside the root) but
    // must never enter the ship list, let alone be read.
    const outsideRoot = writeFixture(baseManifest);
    const traversalRoot = writeFixture({ ...baseManifest, background: { service_worker: "../outside.js" } });
    assertRejects(() => collectExtensionFiles(traversalRoot), "pack safety: manifest .. traversal must be rejected");

    // (3) Absolute path reference.
    const absoluteRoot = writeFixture({ ...baseManifest, background: { service_worker: "/etc/passwd" } });
    assertRejects(() => collectExtensionFiles(absoluteRoot), "pack safety: absolute path reference must be rejected");

    // (3b) Traversal that would resolve back INSIDE the root: the realpath
    // containment alone cannot catch it — the entry NAME itself must be
    // rejected so no ".." ever reaches a zip entry.
    const insideTraversalRoot = writeFixture({ ...baseManifest, background: { service_worker: "sub/../worker.js" } });
    fs.mkdirSync(path.join(insideTraversalRoot, "sub"));
    assertRejects(
      () => collectExtensionFiles(insideTraversalRoot),
      "pack safety: a .. segment resolving inside the root must still be rejected as an entry name"
    );

    // (4) realpath escape: linkdir is a symlinked DIRECTORY pointing outside
    // the root — linkdir/worker.js lstats as a regular file, so only the
    // realpath containment check catches it.
    const escapeRoot = writeFixture({ ...baseManifest, background: { service_worker: "linkdir/worker.js" } });
    const outsideStore = fs.mkdtempSync(path.join(os.tmpdir(), "kilocean-pack-outside-"));
    tempDirs.push(outsideStore);
    fs.writeFileSync(path.join(outsideStore, "worker.js"), "console.log('smuggled');\n");
    fs.symlinkSync(outsideStore, path.join(escapeRoot, "linkdir"));
    assertRejects(() => collectExtensionFiles(escapeRoot), "pack safety: realpath escape via symlinked directory must be rejected");

    // (5) buildZip re-validates even a caller-supplied list (defense in depth).
    const zipRoot = writeFixture(baseManifest);
    fs.symlinkSync(path.join(zipRoot, "worker.js"), path.join(zipRoot, "linked.js"));
    assertRejects(
      () => buildZip(path.join(zipRoot, "dist", "x.zip"), zipRoot, ["manifest.json", "../worker.js"]),
      "pack safety: buildZip must reject traversal entries"
    );
    assertRejects(
      () => buildZip(path.join(zipRoot, "dist", "x.zip"), zipRoot, ["manifest.json", "linked.js"]),
      "pack safety: buildZip must reject symlink entries"
    );
    if (fs.existsSync(path.join(zipRoot, "dist", "x.zip"))) {
      fail("pack safety: a rejected buildZip must not write its output");
    }

    // (6) Symlinked OUTPUT FILE: the zip write must replace the link itself
    // (unlink + rename), never follow it — the victim file outside the root
    // keeps its bytes, the output ends up a regular file, and no temp litter
    // stays behind in dist.
    const outLinkRoot = writeFixture(baseManifest);
    let outLinkCollected;
    try {
      outLinkCollected = collectExtensionFiles(outLinkRoot);
    } catch (error) {
      fail(`pack safety: symlinked-output fixture must collect, got ${error.message}`);
      outLinkCollected = null;
    }
    if (outLinkCollected) {
      const victimStore = fs.mkdtempSync(path.join(os.tmpdir(), "kilocean-pack-victim-"));
      tempDirs.push(victimStore);
      const victimFile = path.join(victimStore, "victim.zip");
      fs.writeFileSync(victimFile, "precious bytes");
      const outLink = path.join(outLinkRoot, "dist", "fixture.zip");
      fs.mkdirSync(path.join(outLinkRoot, "dist"));
      fs.symlinkSync(victimFile, outLink);
      try {
        buildZip(outLink, outLinkRoot, outLinkCollected.files);
      } catch (error) {
        fail(`pack safety: symlinked output file must be replaced (unlink + rename), got: ${error.message}`);
      }
      if (fs.readFileSync(victimFile, "utf8") !== "precious bytes") {
        fail("pack safety: buildZip must never write through a symlinked output file");
      }
      const outStat = fs.lstatSync(outLink, { throwIfNoEntry: false });
      if (!outStat || !outStat.isFile()) {
        fail("pack safety: buildZip output must be a regular file after replacing the symlink");
      }
      const { listZipEntries } = mod;
      try {
        const names = listZipEntries(outLink).map((entry) => entry.name).sort();
        if (JSON.stringify(names) !== JSON.stringify([...outLinkCollected.files].sort())) {
          fail("pack safety: zip written over a replaced symlink must still carry the full ship list");
        }
      } catch (error) {
        fail(`pack safety: zip written over a replaced symlink must be a valid container: ${error.message}`);
      }
      const litter = fs.readdirSync(path.join(outLinkRoot, "dist")).filter((name) => name !== "fixture.zip");
      if (litter.length > 0) {
        fail(`pack safety: atomic write must leave no temp files in dist, found: ${litter.join(", ")}`);
      }
    }

    // (7) Symlinked DIST DIR: refused by lstat even when the link points back
    // inside the root, and refused by realpath containment when it points
    // outside — nothing may ever be written through the link.
    const distInsideRoot = writeFixture(baseManifest);
    let distInsideCollected;
    try {
      distInsideCollected = collectExtensionFiles(distInsideRoot);
    } catch (error) {
      fail(`pack safety: symlinked-dist fixture must collect, got ${error.message}`);
      distInsideCollected = null;
    }
    if (distInsideCollected) {
      const insideTarget = path.join(distInsideRoot, "real-dist");
      fs.mkdirSync(insideTarget);
      fs.symlinkSync(insideTarget, path.join(distInsideRoot, "dist"));
      assertRejects(
        () => buildZip(path.join(distInsideRoot, "dist", "x.zip"), distInsideRoot, distInsideCollected.files),
        "pack safety: symlinked dist dir must be refused even when it points inside the root"
      );
      if (fs.readdirSync(insideTarget).length > 0) {
        fail("pack safety: nothing may be written through a symlinked dist dir");
      }
    }

    const distEscapeRoot = writeFixture(baseManifest);
    let distEscapeCollected;
    try {
      distEscapeCollected = collectExtensionFiles(distEscapeRoot);
    } catch (error) {
      fail(`pack safety: dist-escape fixture must collect, got ${error.message}`);
      distEscapeCollected = null;
    }
    if (distEscapeCollected) {
      const escapeStore = fs.mkdtempSync(path.join(os.tmpdir(), "kilocean-pack-escape-"));
      tempDirs.push(escapeStore);
      fs.symlinkSync(escapeStore, path.join(distEscapeRoot, "dist"));
      assertRejects(
        () => buildZip(path.join(distEscapeRoot, "dist", "x.zip"), distEscapeRoot, distEscapeCollected.files),
        "pack safety: dist dir resolving outside the root must be refused"
      );
      if (fs.readdirSync(escapeStore).length > 0) {
        fail("pack safety: nothing may be written through a dist dir that resolves outside the root");
      }
    }
  } finally {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function checkVersionBump() {
  const manifest = readJson("manifest.json");
  if (manifest && manifest.version !== "1.4.3") {
    fail(`manifest.version must be 1.4.3 for this release, got ${JSON.stringify(manifest.version)}`);
  }

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  if (!readme.includes("1.4.3")) {
    fail("README.md: version hint must mention 1.4.3");
  }

  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  if (!content.includes("Kilocean Translate 1.4.3")) {
    fail("content.js: export generator meta must carry the extension version 1.4.3");
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
  await checkKeyMigrationGate();
  await checkInflightCapAndRunCancellation();
  await checkSpaRefreshAndSelectionLifecycle();
  await checkSpaFlushRaceGuard();
  await checkTotalDeadlineBudget();
  await checkTabConcurrencyAndNavigationCancel();
  checkTranslationReuseCache();
  await checkPackaging();
  await checkPackPathSafety();

  if (errors.length > 0) {
    console.error("\nCI CHECK FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("OK: manifest (incl. store key → extension ID), permissions, syntax, static bans, segment split logic, parseTranslationPayload, joinSplitTranslations, joinRawTextNodes, X layout heuristics, X mutation scope gate, English profile detection, version bump, SPA navigation + selection card statics, fetch timeout coverage, model migration + retry policy, key persistence migration gate (vm), inflight cap + run cancellation, SPA refresh + selection lifecycle, SPA flush race guard, total deadline budget, tab concurrency + navigation cancel, translation reuse cache, packaging, pack path safety");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
