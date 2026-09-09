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
const ALLOWED_HOST = "https://api.deepseek.com/*";
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
  if (hosts.length === 0) {
    fail("host_permissions must include https://api.deepseek.com/*");
  }
  for (const host of hosts) {
    if (host !== ALLOWED_HOST && !host.startsWith("https://api.deepseek.com/")) {
      fail(`disallowed host_permission: ${host} (only https://api.deepseek.com/* allowed)`);
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
  const { parseTranslationPayload, hasMultiParagraphSource } = utils;
  if (typeof parseTranslationPayload !== "function") {
    fail("shared.js: parseTranslationPayload export missing");
    return;
  }
  if (typeof hasMultiParagraphSource !== "function") {
    fail("shared.js: hasMultiParagraphSource export missing");
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

  if (errors.length > 0) {
    console.error("\nCI CHECK FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("OK: manifest, permissions, syntax, static bans, segment split logic, parseTranslationPayload, joinSplitTranslations, joinRawTextNodes");
  process.exit(0);
}

main();
