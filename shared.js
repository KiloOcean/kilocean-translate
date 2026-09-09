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

  function parseTranslationPayload(content, expectedCount, sourceText) {
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("DeepSeek 返回了空内容");
    }

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      throw new Error("DeepSeek 返回的翻译结果不是有效 JSON");
    }

    const translations = Array.isArray(payload) ? payload : payload.translations;
    if (!Array.isArray(translations)) {
      throw new Error("DeepSeek 返回结果缺少 translations 数组");
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
      throw new Error(`DeepSeek 返回 ${translations.length} 条结果，预期 ${expectedCount} 条`);
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
    normalizeDisplayMode,
    getTargetLanguageName,
    isTranslatableText,
    preserveWhitespace,
    chunkSegments,
    hasMultiParagraphSource,
    countSourceParagraphUnits,
    parseTranslationPayload,
    sanitizeExportFilename,
    buildExportFilename
  };
});
