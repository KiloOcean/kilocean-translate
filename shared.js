(function exposeUtils(root, factory) {
  const utils = factory();
  root.DeepSeekTranslatorUtils = utils;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createUtils() {
  "use strict";

  const TARGET_LANGUAGE_NAMES = Object.freeze({
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    ja: "日本語",
    ko: "한국어",
    en: "English"
  });

  const DISPLAY_MODES = Object.freeze({
    bilingual: "bilingual",
    translationOnly: "translation-only",
    original: "original"
  });

  // On X (Twitter) hosts the translator only touches tweet bodies and profile
  // bios; sidebar / trends / follow rows / footer chrome must stay untouched.
  const X_TRANSLATABLE_SELECTOR = '[data-testid="tweetText"], [data-testid="UserDescription"]';

  function getTargetLanguageName(code) {
    return TARGET_LANGUAGE_NAMES[code] || code || "简体中文";
  }

  function normalizeDisplayMode(value) {
    if (value === DISPLAY_MODES.translationOnly) {
      return DISPLAY_MODES.translationOnly;
    }
    if (value === DISPLAY_MODES.original) {
      return DISPLAY_MODES.original;
    }
    return DISPLAY_MODES.bilingual;
  }

  function isTranslatableText(value, targetLanguage) {
    if (typeof value !== "string") {
      return false;
    }

    const text = value.trim();
    if (text.length < 2) {
      return false;
    }

    if (/^(?:https?:\/\/|www\.)\S+$/i.test(text)) {
      return false;
    }

    if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) {
      return false;
    }

    if (
      typeof targetLanguage === "string" &&
      targetLanguage.startsWith("zh") &&
      /^[\p{Script=Han}\d\s\p{P}\p{S}]+$/u.test(text)
    ) {
      return false;
    }

    return true;
  }

  // True when the text already looks like the run's target language, so
  // translating it again would only duplicate it on screen ("宝玉宝玉").
  // Strict rule: the shortcut applies only when the text carries NO
  // foreign-script letters — every Unicode letter (\p{L}) must belong to the
  // target's allowed scripts (zh: Han only; ja: Han + kana + prolonged
  // mark; ko: Hangul + Han) — and the per-target minimum ratio must still
  // hold. Digits, punctuation and symbols never vote. A target-script
  // minority inside foreign prose ("한국어 Привет", "かな test",
  // "中文 Привет мир") always fails open to translation: a low ratio alone
  // must never drop a mixed block. Latin-script targets (en, fr, es, de, …)
  // never take the shortcut at all — a shared script proves nothing about
  // the language.
  function isAlreadyTargetLanguage(text, targetLang) {
    if (typeof text !== "string") {
      return false;
    }
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      return false;
    }

    const countMatches = (value, pattern) => (value.match(pattern) || []).length;
    const han = countMatches(trimmed, /\p{Script=Han}/gu);
    // Kana letters only: hiragana + katakana (+ phonetic extensions).
    // Block-edge punctuation — U+30FB ・, U+3000–303F CJK punctuation —
    // must not count, or "你好・世界" would be misread as already-Japanese
    // and skip its ja translation.
    const kana = countMatches(trimmed, /[\u3041-\u3096\u30A1-\u30FA\u31F0-\u31FF]/gu);
    // U+30FC (chouonpu, the prolonged sound mark) is a letter (Lm), so it
    // votes in the denominator; Japanese allows it next to kana without
    // counting it as a kana vote.
    const prolonged = countMatches(trimmed, /\u30FC/gu);
    const hangul = countMatches(trimmed, /[\uAC00-\uD7A3\u1100-\u11FF]/gu);
    // Every letter votes, including scripts with no numerator here (Latin,
    // Cyrillic, Arabic, Greek, …) — any one of them is a foreign letter.
    const letters = countMatches(trimmed, /\p{L}/gu);
    if (letters < 2) {
      return false;
    }

    const code = String(targetLang || "").toLowerCase();
    if (code.startsWith("zh")) {
      // Han letters only: any kana, hangul, Latin or other-script letter
      // makes this Japanese/Korean/mixed prose, not Chinese.
      return han === letters && han / letters >= 0.5;
    }
    if (code === "ja") {
      // Kanji-only edge cases still fall through via the 0.2 kana floor:
      // "你好・世界" holds no foreign letter but no kana vote either.
      return han + kana + prolonged === letters && kana / letters >= 0.2;
    }
    if (code === "ko") {
      // Hangul + hanja only; the 0.3 hangul floor drops hanja-only text.
      return hangul + han === letters && hangul / letters >= 0.3;
    }
    // Latin-script targets (en, fr, es, de, …): a shared script cannot prove
    // the target language — be conservative and always translate.
    return false;
  }

  // True for page chrome that must never be translated: @handles, bare URLs,
  // counters ("1.9K", "12万"), relative times ("2h") and bare dates ("Oct 12") —
  // translating those yields glued duplicates like "Oct 1210月12日".
  function isSkippableText(text) {
    if (typeof text !== "string") {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (/^@[\w.\-]+$/u.test(trimmed)) {
      return true;
    }
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)) {
      return true;
    }
    if (/^\d[\d.,]*(?:\s?[万萬亿億]|[KkMmBb])?\+?$/.test(trimmed)) {
      return true;
    }
    if (/^\d+\s*(?:[smhdw]|sec|min|hr|wk)\s*(?:ago)?$/i.test(trimmed)) {
      return true;
    }
    // Bare dates: real month names or standard abbreviations only (incl.
    // "Sept"), word-bounded — "Market 12" / "Octopus 12" / "Decemberish 3"
    // are ordinary text before a number and must stay translatable.
    if (
      /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b\.?\s+\d{1,2}(?:\s*,?\s*\d{4})?$/i.test(trimmed)
    ) {
      return true;
    }
    return false;
  }

  // X hosts: x.com / twitter.com plus subdomains such as mobile.twitter.com.
  // "notx.com" must not match.
  function isXHost(hostname) {
    const host = String(hostname || "").trim().toLowerCase().replace(/\.$/u, "");
    return host === "x.com" || host === "twitter.com" ||
      host.endsWith(".x.com") || host.endsWith(".twitter.com");
  }

  function preserveWhitespace(original, translated) {
    const leading = original.match(/^\s*/u)?.[0] || "";
    const trailing = original.match(/\s*$/u)?.[0] || "";
    return `${leading}${String(translated).trim()}${trailing}`;
  }

  function chunkSegments(segments, maxCharacters = 5000, maxItems = 24) {
    const chunks = [];
    let current = [];
    let characterCount = 0;

    for (const segment of segments) {
      const length = segment.text.length;
      const exceedsCharacters = current.length > 0 && characterCount + length > maxCharacters;
      const exceedsItems = current.length >= maxItems;

      if (exceedsCharacters || exceedsItems) {
        chunks.push(current);
        current = [];
        characterCount = 0;
      }

      current.push(segment);
      characterCount += length;
    }

    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  // True for a blank-line paragraph break: two newlines with only horizontal
  // whitespace (spaces, tabs, \r) between them. Matches exact \n\n as well as
  // whitespace-only blank lines ("甲\n \n乙") and CRLF breaks ("甲\r\n\r\n乙"),
  // so paragraph structure survives sloppy whitespace or CRLF sources.
  function hasBlankLineBreak(text) {
    return typeof text === "string" && /\n[^\S\n]*\n/u.test(text);
  }

  // True when source has blank-line paragraph breaks or at least two
  // non-empty lines separated by newlines (after joinRawTextNodes may collapse
  // blank lines to a single \n).
  function hasMultiParagraphSource(text) {
    if (typeof text !== "string" || text.length === 0) {
      return false;
    }
    if (hasBlankLineBreak(text)) {
      return true;
    }
    const nonEmptyLines = text.split("\n").filter((line) => line.trim() !== "");
    return nonEmptyLines.length >= 2;
  }

  // Count source paragraph/line units the same way join recovery detects them:
  // blank-line-separated chunks when a blank line exists, otherwise non-empty
  // trimmed lines. Single-line text counts as 1 so mismatched extras cannot
  // silently join.
  function countSourceParagraphUnits(text) {
    if (typeof text !== "string" || text.length === 0) {
      return 0;
    }
    if (hasBlankLineBreak(text)) {
      let units = 0;
      let inUnit = false;
      for (const line of text.split("\n")) {
        const isContent = line.trim() !== "";
        if (isContent && !inUnit) {
          units += 1;
        }
        inUnit = isContent;
      }
      return units;
    }
    const nonEmptyLines = text.split("\n").filter((line) => line.trim() !== "");
    return nonEmptyLines.length === 0 ? 0 : nonEmptyLines.length;
  }

  function parseTranslationPayload(content, expectedCount, sourceText, providerLabel = "DeepSeek") {
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`${providerLabel} 返回了空内容`);
    }

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      throw new Error(`${providerLabel} 返回的翻译结果不是有效 JSON`);
    }

    const translations = Array.isArray(payload) ? payload : payload.translations;
    if (!Array.isArray(translations)) {
      throw new Error(`${providerLabel} 返回结果缺少 translations 数组`);
    }

    // A single multi-paragraph segment sometimes comes back as one entry per
    // paragraph; rejoin so counts match again. Prefer \n\n when the source
    // still has blank lines (including whitespace-only or CRLF blank lines);
    // otherwise join with \n (normalized single breaks). Trim each entry
    // first so edge whitespace from the payload cannot stack newlines or
    // gaps around the separator.
    // Only recover when the source itself is multi-paragraph so selection /
    // TEST_CONNECTION malformed extras still fail closed.
    if (
      expectedCount === 1 &&
      translations.length > 1 &&
      translations.every((item) => typeof item === "string" && item.trim() !== "") &&
      typeof sourceText === "string" &&
      hasMultiParagraphSource(sourceText) &&
      translations.length === countSourceParagraphUnits(sourceText)
    ) {
      const separator = hasBlankLineBreak(sourceText) ? "\n\n" : "\n";
      return [translations.map((item) => item.trim()).join(separator)];
    }

    if (translations.length !== expectedCount) {
      throw new Error(`${providerLabel} 返回 ${translations.length} 条结果，预期 ${expectedCount} 条`);
    }

    return translations.map((item, index) => {
      if (typeof item !== "string") {
        throw new Error(`第 ${index + 1} 条翻译结果不是文本`);
      }
      return item;
    });
  }

  function sanitizeExportFilename(value) {
    return String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
      .replace(/\s+/gu, " ")
      .replace(/[-\s.]+$/gu, "")
      .trim()
      .slice(0, 80);
  }

  function buildExportFilename(title, targetLanguage, date = new Date()) {
    const safeTitle = sanitizeExportFilename(title) || "translated-page";
    const safeLanguage = sanitizeExportFilename(targetLanguage) || "translated";
    const dateLabel = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
      .join("-");
    return `${safeTitle}-${safeLanguage}-${dateLabel}.html`;
  }

  return {
    DISPLAY_MODES,
    TARGET_LANGUAGE_NAMES,
    X_TRANSLATABLE_SELECTOR,
    normalizeDisplayMode,
    getTargetLanguageName,
    isTranslatableText,
    isAlreadyTargetLanguage,
    isSkippableText,
    isXHost,
    preserveWhitespace,
    chunkSegments,
    hasMultiParagraphSource,
    countSourceParagraphUnits,
    parseTranslationPayload,
    sanitizeExportFilename,
    buildExportFilename
  };
});
