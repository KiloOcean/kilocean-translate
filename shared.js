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

  // Provider fetch deadlines. Translation batches (page + selection) get a
  // generous 30s; the popup connection test fails fast at 15s. Without them a
  // hung request keeps the popup at "正在翻译"/"正在连接" forever.
  const FETCH_TIMEOUT_MS = Object.freeze({
    translation: 30000,
    connectionTest: 15000
  });
  const FETCH_TIMEOUT_MESSAGE = "请求超时，请检查网络或稍后重试";

  // Smallest remaining deadline budget still worth one more provider
  // attempt. Below it a fresh request would almost certainly be cut off
  // mid-flight, so the caller fails fast instead (timeout, or the busy hint
  // when the last failure was 429/5xx). The first attempt is exempt: its
  // budget is the whole deadline, which callers keep well above this floor.
  const MIN_ATTEMPT_BUDGET_MS = 1000;

  // Per-attempt ceiling for one provider fetch. Without it every attempt
  // would inherit the whole remaining total budget as its own timeout, so a
  // hung first request could burn all 30s alone and no timeout retry could
  // ever fit. Each attempt instead gets
  // min(MAX_ATTEMPT_TIMEOUT_MS, remaining − MIN_ATTEMPT_BUDGET_MS reserve):
  // 10s stays comfortably above p99 latency for a ≤24-segment batch while
  // leaving the 30s translation budget room for ~1s/~3s backoffs and a
  // second or third attempt.
  const MAX_ATTEMPT_TIMEOUT_MS = 10000;

  // DeepSeek chat models: the API renamed deepseek-v4-flash → deepseek-flash
  // (DeepSeek-V4.1-Flash, see selftest/deepseek-connectivity-2026-10-15.md).
  // Saved settings may still hold the legacy name; migrateModelName maps it
  // on read so existing users keep their fast-model choice.
  const DEEPSEEK_MODEL_IDS = Object.freeze(["deepseek-flash", "deepseek-v4-pro"]);
  const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
  const LEGACY_MODEL_ALIASES = Object.freeze({
    "deepseek-v4-flash": "deepseek-flash"
  });

  // Whole-page translation keeps at most this many TRANSLATE_BATCH requests
  // in flight (content.js sends them sequentially, i.e. one at a time). The
  // cap exists so any future parallelism cannot stampede the provider into
  // 429s.
  const MAX_INFLIGHT_TRANSLATE_BATCHES = 3;

  // Map legacy saved model names (deepseek-v4-flash → deepseek-flash) to
  // their current IDs; unknown values pass through untouched.
  function migrateModelName(model) {
    return LEGACY_MODEL_ALIASES[model] || model;
  }

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

  // High-frequency English function words. Ordinary English prose (tweets,
  // bios) always carries several of these, while French/German/Spanish/Italian
  // sentences carry none of them (their function words live in the set below).
  const ENGLISH_STOPWORDS = new Set([
    "the", "and", "is", "to", "of", "a", "in", "for", "you", "that", "it",
    "with", "on", "this", "are", "be", "i", "my", "we", "as", "at", "by",
    "an", "or", "from", "about", "not", "but", "have", "has", "was", "were",
    "all", "can", "will", "would", "your", "their", "our", "me", "he", "she",
    "they", "them", "his", "her", "its", "if", "so", "what", "when", "who",
    "do", "does", "did", "been", "being", "am", "just", "more", "also",
    "than", "then", "there", "here", "out", "up", "down", "over", "into",
    "now", "like", "get", "make", "want", "know", "think", "see", "how",
    "which", "because", "while", "where", "should", "could", "after", "before"
  ]);

  // Function words of the other big Latin-script languages. A couple of hits
  // mark the text as not English even when an English-looking word sneaks in
  // ("die" in German, "son" in Spanish): precision wins over recall, because
  // wrongly skipping French/German/Spanish/Italian would silently drop their
  // translation, while wrongly translating an English block only echoes it.
  const NON_ENGLISH_STOPWORDS = new Set([
    // French
    "le", "la", "les", "des", "de", "une", "un", "du", "et", "est", "dans",
    "pour", "que", "qui", "pas", "avec", "sur", "je", "tu", "il", "elle",
    "nous", "vous", "ils", "mais", "plus", "tout", "très", "aussi", "comme",
    "être", "avoir", "ce", "cette", "ces", "au", "aux", "ne", "où", "notre",
    "votre",
    // German
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "und",
    "ist", "sind", "war", "wir", "ihr", "nicht", "mit", "für", "auf", "von",
    "zu", "bei", "aus", "nach", "auch", "wird", "werden", "hat", "habe",
    "sich", "oder", "aber", "wenn", "nur", "noch", "schon", "über", "unter",
    "durch", "um", "im", "als", "ich", "mich", "dich", "euch", "uns",
    // Spanish
    "el", "los", "las", "una", "unos", "unas", "en", "del", "es", "son",
    "por", "con", "pero", "muy", "ya", "sobre", "entre", "cuando", "como",
    "porque", "más", "yo", "tú", "él", "ella", "usted", "nosotros", "ellos",
    "si", "esta", "está", "están", "hay", "tiene", "desde", "hasta", "donde",
    "quien", "fue", "ser", "mis", "sus", "nuestro",
    // Italian
    "il", "lo", "gli", "che", "non", "per", "e", "ma", "sono", "era",
    "come", "questo", "questa", "quello", "quella", "anche", "nel", "dal",
    "dalla", "della", "degli", "loro", "suo", "sua", "ho", "hai", "ha",
    "molto", "sempre", "bene"
  ]);

  // English stopwords that double as ordinary function words in the other
  // Latin-script languages: "Me gusta bailar" (es "me"), "On arrive demain
  // matin" (fr "on"/"a"), "Was nun" (de "was"), "I problemi sociali" (it "i"
  // is the masculine plural article). They can never prove English on their
  // own — only unambiguous hits (the/and/of…) count as evidence for the skip
  // shortcut.
  const AMBIGUOUS_ENGLISH_STOPWORDS = new Set(["a", "i", "me", "on", "was", "in"]);

  // Lightweight English detector for Latin-script text: tokenize words, then
  // score unambiguous English function words against French/German/Spanish/
  // Italian markers and accented letters. Deliberately conservative — any
  // doubt must resolve to false so the caller keeps translating: any foreign
  // function word or accented letter vetoes the shortcut outright, short
  // texts (< 8 words) need overwhelming evidence (at least three distinct
  // unambiguous English function words at a high ratio — adding every
  // Dutch/Afrikaans marker to the foreign list is whack-a-mole, and "Dit is
  // nie moontlik nie" reads English-ish to any such list), longer texts need
  // a 0.15 strong stopword ratio. Never treat "all Latin script" as English
  // on its own.
  function looksLikeEnglish(text) {
    if (typeof text !== "string") {
      return false;
    }
    const words = text.toLowerCase().match(/\p{L}+/gu);
    if (!words || words.length === 0) {
      return false;
    }

    let englishHits = 0;
    let foreignHits = 0;
    let nonAsciiWords = 0;
    const distinctUnambiguousWords = new Set();
    for (const word of words) {
      if (ENGLISH_STOPWORDS.has(word)) {
        if (!AMBIGUOUS_ENGLISH_STOPWORDS.has(word)) {
          englishHits += 1;
          distinctUnambiguousWords.add(word);
        }
      }
      if (NON_ENGLISH_STOPWORDS.has(word)) {
        foreignHits += 1;
      }
      // Tokens are letters only, so any non a-z character is a non-ASCII
      // letter: café / über / señor / 中文 — strong not-English evidence.
      if (!/^[a-z]+$/.test(word)) {
        nonAsciiWords += 1;
      }
    }

    if (nonAsciiWords > 0) {
      return false;
    }
    // Foreign function words veto the shortcut even when outnumbered: a
    // single le/die/el marker means the text is not English, and wrongly
    // skipping would silently drop its translation.
    if (foreignHits > 0) {
      return false;
    }
    if (words.length < 8) {
      // Short texts skip only on overwhelming evidence. One or two English
      // function words prove nothing: the same tokens carry Afrikaans
      // ("Dit is nie moontlik nie") and Dutch ("Dit is een goed idee")
      // sentences that no foreign-marker list fully covers. Demand three or
      // more DISTINCT unambiguous function words at a high ratio; a false
      // negative merely echoes an English block, a false positive silently
      // drops a foreign translation.
      return (
        distinctUnambiguousWords.size >= 3 &&
        englishHits / words.length >= 0.4
      );
    }
    return englishHits > 0 && englishHits / words.length >= 0.15;
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
  // must never drop a mixed block. Latin-script targets never shortcut on
  // script alone — a shared script proves nothing about the language; only
  // English gets a word-profile shortcut (looksLikeEnglish), and only when
  // the profile is confident.
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
    if (code === "en" || code.startsWith("en-")) {
      // Latin script alone proves nothing (French/Spanish/German must keep
      // translating) — only a confident English word profile may skip.
      return looksLikeEnglish(trimmed);
    }
    // Other Latin-script targets (fr, es, de, …): a shared script cannot
    // prove the target language — be conservative and always translate.
    return false;
  }

  // True when the provider echoed the source back unchanged: inserting that
  // as a "translation" would only duplicate the block on screen. Compares
  // after normalization — trim, collapse whitespace runs, case-fold, strip
  // trailing punctuation — so "Hello world." vs "hello world" counts as the
  // same text.
  function isSameTranslation(source, output) {
    if (typeof source !== "string" || typeof output !== "string") {
      return false;
    }
    const normalize = (value) => value
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .replace(/[\p{P}\p{S}]+$/gu, "")
      .trim();
    const left = normalize(source);
    const right = normalize(output);
    return left !== "" && left === right;
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

  // Visible-area-first ordering for the initial page run: segments whose rect
  // intersects the viewport translate first (input order among them — callers
  // pass DOM order), then segments starting within one viewport height below
  // the fold, then everything else in input order. Items whose rect is
  // unavailable (getRect returns null/throws) keep input order in the last
  // tier — never dropped. Pure: returns a NEW array and reads getRect exactly
  // once per item, so callers can pass getBoundingClientRect without repeated
  // layout reads. Dynamic follow-up runs keep discovery order (callers simply
  // do not reorder).
  function orderSegmentsByViewport(items, getRect, viewportHeight) {
    const list = Array.isArray(items) ? [...items] : [];
    if (list.length <= 1) {
      return list;
    }
    const height = Number(viewportHeight);
    const fold = Number.isFinite(height) && height > 0 ? height : 0;
    const visible = [];
    const below = [];
    const rest = [];
    for (const item of list) {
      let rect = null;
      try {
        rect = getRect ? getRect(item) : null;
      } catch {
        rect = null;
      }
      if (
        !rect ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.bottom)
      ) {
        rest.push(item);
        continue;
      }
      if (rect.bottom > 0 && rect.top < fold) {
        visible.push(item);
      } else if (rect.top >= fold && rect.top < fold * 2) {
        below.push(item);
      } else {
        rest.push(item);
      }
    }
    return [...visible, ...below, ...rest];
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

  // Error thrown when a provider fetch exceeds its deadline. canSplit stays
  // false: a timeout says nothing about payload size, so bisecting and
  // re-billing the halves would only hang again.
  function createFetchTimeoutError() {
    const error = new Error(FETCH_TIMEOUT_MESSAGE);
    error.code = "FETCH_TIMEOUT";
    error.isTimeout = true;
    error.canSplit = false;
    return error;
  }

  // True for the timeout error fetchWithTimeout produces. Callers rethrow it
  // verbatim instead of wrapping it into generic network errors.
  function isTimeoutError(error) {
    return Boolean(error) &&
      (error.isTimeout === true || error.code === "FETCH_TIMEOUT");
  }

  // True when waiting `delayMs` still leaves enough of the deadline budget
  // for one more meaningful attempt (MIN_ATTEMPT_BUDGET_MS of headroom).
  // translateBatch consults it before every backoff / Retry-After sleep so a
  // wait that cannot fit inside the total deadline never happens at all.
  // Pure so tests drive the retry loop with an injected clock.
  function canRetryWithinBudget(delayMs, deadline, now = Date.now()) {
    if (!Number.isFinite(deadline)) {
      return true;
    }
    return Number(delayMs) + MIN_ATTEMPT_BUDGET_MS <= deadline - now();
  }

  // Bounded retry policy for provider requests: 429 / 5xx / timeout get at
  // most MAX_PROVIDER_RETRIES extra attempts with ~1s / ~3s backoff (±20%
  // jitter). Other 4xx never change outcome on retry and fail fast. A
  // Retry-After header (delay-seconds or HTTP date) overrides the backoff.
  const MAX_PROVIDER_RETRIES = 2;
  const RETRY_BASE_DELAYS_MS = Object.freeze([1000, 3000]);
  const RETRY_JITTER_RATIO = 0.2;
  const RETRY_AFTER_CAP_MS = 10000;

  // True for statuses worth another attempt: rate limiting and server-side
  // trouble. Client errors (400/401/403/404 …) retry identically and only
  // re-bill the user, so they must never re-enter the loop.
  function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  // Retry-After → milliseconds. Accepts delay-seconds ("2") or an HTTP date;
  // returns null when absent or unparseable so callers fall back to backoff.
  // Dates in the past clamp to 0; both forms cap at RETRY_AFTER_CAP_MS so a
  // huge value cannot pin the worker.
  function parseRetryAfterMs(headerValue, now = Date.now()) {
    if (typeof headerValue !== "string" || headerValue.trim() === "") {
      return null;
    }
    const value = headerValue.trim();
    if (/^\d+$/.test(value)) {
      return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS);
    }
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
      return null;
    }
    return Math.min(Math.max(at - now, 0), RETRY_AFTER_CAP_MS);
  }

  // Pure delay computation so tests run the retry loop without sleeping.
  // `attempt` is the 0-based failed attempt: 0 → ~1s before retry 1, 1 → ~3s
  // before retry 2 (later attempts clamp to the last base). rand injects the
  // ±20% jitter; a parseable Retry-After is honored exactly, without jitter —
  // waiting less than the server asked would only earn another 429.
  function computeRetryDelay(attempt, retryAfterHeader, rand = Math.random, now = Date.now()) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }
    const base = RETRY_BASE_DELAYS_MS[
      Math.min(Math.max(attempt, 0), RETRY_BASE_DELAYS_MS.length - 1)
    ];
    const jitter = 1 + (rand() * 2 - 1) * RETRY_JITTER_RATIO;
    return Math.round(base * jitter);
  }

  // fetch() under an AbortController deadline. The signal guards the whole
  // request lifecycle, headers AND body: the returned wrapper keeps the timer
  // armed until text()/json() settles (cleared in finally), so a response
  // whose body stalls mid-stream aborts too. The current provider API is
  // non-streaming; a future chunked read should instead reset the timer on
  // each chunk (idle deadline). Aborting rejects with the user-facing Chinese
  // timeout error, ready for popup/status/toast surfaces.
  //
  // An optional `externalSignal` (tab navigation / removal cancellation)
  // aborts the same controller but must NOT be reported as a timeout: the
  // deadline timer sets `deadlineAborted` first so the catch paths can tell
  // the two abort sources apart — a cancelled request rethrows the raw abort
  // error for the caller to classify as RUN_CANCELLED.
  async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS.translation, externalSignal = null) {
    const controller = new AbortController();
    let deadlineAborted = false;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort);
      }
    }
    let timer = setTimeout(() => {
      deadlineAborted = true;
      controller.abort();
    }, timeoutMs);
    const teardown = () => {
      clearTimeout(timer);
      timer = null;
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    };

    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      teardown();
      if (deadlineAborted) {
        throw createFetchTimeoutError();
      }
      throw error;
    }

    // Return a plain snapshot of the headers-phase fields plus guarded body
    // readers. Never Object.create(response): Response accessors live on the
    // prototype and demand the native receiver, so reading ok/status/headers
    // off a proxy throws "Illegal invocation" in Chrome.
    const guardBodyRead = (method) => async function read(...args) {
      try {
        return await response[method](...args);
      } catch (error) {
        if (deadlineAborted) {
          throw createFetchTimeoutError();
        }
        throw error;
      } finally {
        teardown();
      }
    };
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url,
      text: guardBodyRead("text"),
      json: guardBodyRead("json")
    };
  }

  return {
    DISPLAY_MODES,
    TARGET_LANGUAGE_NAMES,
    X_TRANSLATABLE_SELECTOR,
    FETCH_TIMEOUT_MS,
    FETCH_TIMEOUT_MESSAGE,
    DEEPSEEK_MODEL_IDS,
    DEEPSEEK_DEFAULT_MODEL,
    MAX_INFLIGHT_TRANSLATE_BATCHES,
    migrateModelName,
    MAX_PROVIDER_RETRIES,
    RETRY_BASE_DELAYS_MS,
    RETRY_AFTER_CAP_MS,
    MIN_ATTEMPT_BUDGET_MS,
    MAX_ATTEMPT_TIMEOUT_MS,
    isRetryableStatus,
    parseRetryAfterMs,
    computeRetryDelay,
    canRetryWithinBudget,
    normalizeDisplayMode,
    getTargetLanguageName,
    isTranslatableText,
    isAlreadyTargetLanguage,
    looksLikeEnglish,
    isSameTranslation,
    isSkippableText,
    isXHost,
    preserveWhitespace,
    orderSegmentsByViewport,
    chunkSegments,
    hasMultiParagraphSource,
    countSourceParagraphUnits,
    parseTranslationPayload,
    sanitizeExportFilename,
    buildExportFilename,
    fetchWithTimeout,
    isTimeoutError,
    createFetchTimeoutError
  };
});
