#!/usr/bin/env node
/**
 * Kilocean Translate 1.5.0 — content-script checks (content.js / shared.js).
 *
 * Zero dependencies (node:fs / node:path / node:module + new Function harnesses
 * in the ci-check style). Exports runContent150Checks({ ROOT, fail }) so the
 * repo CI (or a human) can run it against any worktree root:
 *
 *   node -e "import('./scripts/checks-content-150.mjs').then(async m => {
 *     const errors = [];
 *     await m.runContent150Checks({ ROOT: process.cwd(), fail: (x) => errors.push(x) });
 *     console.log(errors.length ? errors : 'OK');
 *   })"
 *
 * Covered:
 *  (a) Utils.orderSegmentsByViewport tiers (visible → next screen → rest,
 *      rect-less items keep DOM order, one rect read per item, new array);
 *  (b) split-half returning empty is a FAILURE (state.failed += 1 +
 *      state.error set) while a stale runId never counts — for both the
 *      proactive >5000 path and the canSplit forceSplit path; failure slots
 *      are replaced, not stacked;
 *  (c) statics: COMMAND_SELECTION_TRANSLATE wiring, no new page-DOM billable
 *      path (trusted-click gates on every in-page button that can bill),
 *      progress pill reads state.translated/state.total, RETRY_FAILED /
 *      retryFailedBlocks never restoreOriginal;
 *  (d) the old "请在扩展弹窗中确认翻译" copy is gone.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Same extraction contract as scripts/ci-check.mjs: pull a top-level
// (2-space indented) function body out of the content.js IIFE.
function extractFunctionFrom(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
  return match ? match[0] : null;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => `${p1}${" ".repeat(m.length - p1.length)}`);
}

export async function runContent150Checks({ ROOT, fail }) {
  const require = createRequire(import.meta.url);
  const contentPath = path.join(ROOT, "content.js");
  if (!fs.existsSync(contentPath)) {
    fail(`missing file: content.js (ROOT=${ROOT})`);
    return;
  }
  const contentRaw = fs.readFileSync(contentPath, "utf8");
  // Regression (found in e2e): orderSegmentsByViewport receives SEGMENTS, so
  // the rect getter must read segment.block — calling getBoundingClientRect on
  // the segment object throws and silently degrades to DOM order.
  {
    const call = /orderSegmentsByViewport\(\s*segments,\s*(?:\/\/[^\n]*\n\s*)*\(([a-zA-Z_]+)\)\s*=>\s*([^,]+),/.exec(contentRaw);
    if (!call || !new RegExp(`^${call[1]}\\.block\\.getBoundingClientRect\\(\\)`).test(call[2].trim())) {
      fail("content.js: orderSegmentsByViewport rect getter must read segment.block.getBoundingClientRect() (items are segments, not elements)");
    }
  }
  const content = stripComments(contentRaw);

  const extract = (name) => extractFunctionFrom(contentRaw, name);

  // Slice one runtime.onMessage handler block out of the listener.
  const handlerSlice = (type) => {
    const at = content.indexOf(`message?.type === "${type}"`);
    if (at < 0) {
      return null;
    }
    const rest = content.slice(at);
    const next = rest.indexOf("if (message?.type ===", 10);
    return next < 0 ? rest : rest.slice(0, next);
  };

  // ------------------------------------------------------------------
  // (a) orderSegmentsByViewport — pure tiering, one rect per item.
  // ------------------------------------------------------------------
  let utils;
  try {
    utils = require(path.join(ROOT, "shared.js"));
  } catch (error) {
    fail(`shared.js: cannot load for 1.5.0 content checks: ${error.message}`);
    return;
  }
  if (typeof utils.orderSegmentsByViewport !== "function") {
    fail("shared.js: orderSegmentsByViewport must be exported on DeepSeekTranslatorUtils");
  } else {
    const vh = 800;
    const item = (id, rect) => ({ id, rect });
    const A = item("A", { top: -500, bottom: -400 });   // above viewport
    const D = item("D", { top: vh * 3, bottom: vh * 3 + 50 }); // far below
    const B = item("B", { top: 10, bottom: 100 });      // visible
    const C = item("C", { top: vh + 50, bottom: vh + 100 }); // one screen below
    const E = item("E", null);                          // rect unavailable
    const B2 = item("B2", { top: vh - 50, bottom: vh + 50 }); // straddles the fold
    const F = item("F", undefined);                     // getRect throws
    const input = [A, D, B, C, E, B2, F];

    let rectReads = 0;
    const ordered = utils.orderSegmentsByViewport(input, (it) => {
      rectReads += 1;
      if (it === F) {
        throw new Error("no layout");
      }
      return it.rect;
    }, vh);

    const ids = ordered.map((it) => it.id).join(",");
    if (ids !== "B,B2,C,A,D,E,F") {
      fail(`orderSegmentsByViewport: expected tiers B,B2 (visible) → C (next screen) → A,D,E,F (rest, DOM order), got ${ids}`);
    }
    if (rectReads !== input.length) {
      fail(`orderSegmentsByViewport: must read the rect exactly once per item, got ${rectReads} reads for ${input.length} items`);
    }
    if (ordered === input) {
      fail("orderSegmentsByViewport: must return a NEW array, not mutate/return the input");
    }
    if (input.map((it) => it.id).join(",") !== "A,D,B,C,E,B2,F") {
      fail("orderSegmentsByViewport: must not reorder the input array in place");
    }
    // Degenerate inputs pass through unchanged.
    if (utils.orderSegmentsByViewport([], () => null, vh).length !== 0) {
      fail("orderSegmentsByViewport: empty input stays empty");
    }
    const solo = { id: "solo" };
    if (utils.orderSegmentsByViewport([solo], () => null, vh)[0] !== solo) {
      fail("orderSegmentsByViewport: single item passes through");
    }
    // A viewport height of 0 (or garbage) must degrade to DOM order, not throw.
    const flat = utils.orderSegmentsByViewport(input, (it) => it.rect, 0).map((it) => it.id).join(",");
    if (flat !== "A,D,B,C,E,B2,F") {
      fail(`orderSegmentsByViewport: zero viewport height must degrade to DOM order, got ${flat}`);
    }
    if (utils.orderSegmentsByViewport(input, (it) => it.rect, Number.NaN).length !== input.length) {
      fail("orderSegmentsByViewport: NaN viewport height must not drop items");
    }
  }

  // Static wiring: the INITIAL page run orders segments; dynamic runs keep
  // discovery order (scheduleDynamicTranslation path must not reorder).
  const translateBlocksSrc = extract("translateBlocks");
  if (!translateBlocksSrc) {
    fail("content.js: cannot extract translateBlocks for ordering wiring test");
  } else {
    if (!/Utils\.orderSegmentsByViewport\(/.test(translateBlocksSrc)) {
      fail("content.js: translateBlocks must order the initial run's segments via Utils.orderSegmentsByViewport");
    }
    if (!/isDynamic\s*\?\s*segments/.test(stripComments(translateBlocksSrc))) {
      fail("content.js: only the initial run may reorder — dynamic runs must keep segments order");
    }
  }
  if (/orderSegmentsByViewport/.test(stripComments(extract("scheduleDynamicTranslation") || ""))) {
    fail("content.js: scheduleDynamicTranslation must not reorder dynamic-run blocks");
  }

  // ------------------------------------------------------------------
  // (b) Split-half empty result is a failure; stale runId never counts.
  // ------------------------------------------------------------------
  const fallbackSrc = extract("translateBatchWithFallback");
  const noteSrc = extract("noteSegmentFailure");
  if (!fallbackSrc || !noteSrc) {
    fail("content.js: cannot extract translateBatchWithFallback/noteSegmentFailure for split-failure test");
  } else {
    const runSettings = { provider: "deepseek", targetLanguage: "zh-CN", model: "deepseek-flash" };
    const SPLIT_EMPTY = "长段落分段翻译返回空结果";

    const buildHarness = (overrides = {}) => {
      const state = { active: true, phase: "translating", translated: 0, total: 1, failed: 0, error: "" };
      const failedBlocks = new Set();
      const splitCalls = [];
      let markerUpdates = 0;
      const translateSegmentTextWithSplit = async (text, runId, settings, options = {}) => {
        splitCalls.push({ text, options });
        return overrides.splitResult !== undefined ? overrides.splitResult : null;
      };
      const requestSegmentTranslations = async () => {
        if (overrides.requestError) {
          throw overrides.requestError;
        }
        return ["译文"];
      };
      // applyTranslatedSegment: defaults to "applied" so the success path is
      // exercised; failure tests never reach it (they stop at the split join).
      const applyResult = overrides.applyResult !== undefined ? overrides.applyResult : true;
      let api;
      try {
        api = new Function(
          "state", "failedBlocks", "Utils",
          "showFailedMarker", "updateFailedMarker", "updateProgressPill",
          "getCachedTranslation", "getRunSettings", "applyTranslatedSegment",
          "translateSegmentTextWithSplit", "requestSegmentTranslations",
          "SPLIT_EMPTY_RESULT_MESSAGE",
          `let generation = ${overrides.generation !== undefined ? overrides.generation : 1};
${noteSrc}
async ${fallbackSrc}
return {
  translateBatchWithFallback,
  bumpGeneration: () => { generation += 1; }
};`
        )(
          state,
          failedBlocks,
          utils,
          () => {},
          () => { markerUpdates += 1; },
          () => {},
          () => null,
          () => runSettings,
          () => applyResult,
          translateSegmentTextWithSplit,
          requestSegmentTranslations,
          SPLIT_EMPTY
        );
      } catch (error) {
        fail(`content.js: split-failure harness cannot run the shipping functions: ${error.message}`);
        return null;
      }
      return { api, state, failedBlocks, splitCalls, markerUpdates };
    };

    const oversizedBatch = () => [{ block: { isConnected: true }, text: "x".repeat(5200) }];

    // Proactive >5000 path: a half returns "" → FAILURE (counted + state.error).
    {
      const h = buildHarness({ splitResult: "" });
      if (h) {
        const batch = oversizedBatch();
        await h.api.translateBatchWithFallback(batch, 1, runSettings);
        if (h.state.failed !== 1) {
          fail(`split failure: empty split half on the >5000 path must count state.failed += 1, got ${h.state.failed}`);
        }
        if (h.state.error !== SPLIT_EMPTY) {
          fail(`split failure: state.error must be "${SPLIT_EMPTY}", got ${JSON.stringify(h.state.error)}`);
        }
        if (h.failedBlocks.size !== 1) {
          fail(`split failure: the failed block must be tracked in failedBlocks, got ${h.failedBlocks.size}`);
        }
        // The SAME block failing again replaces the slot — never stacks a
        // second failed count (retryFailedBlocks reuses the block element).
        await h.api.translateBatchWithFallback(batch, 1, runSettings);
        if (h.state.failed !== 1) {
          fail(`split failure: a retry of the same failed block must replace the slot, got state.failed ${h.state.failed}`);
        }
      }
    }

    // Proactive >5000 path, STALE run: the generation is bumped while the
    // split halves are in flight → no failure may pollute the new run.
    {
      const h = buildHarness({ splitResult: "" });
      if (h) {
        const job = h.api.translateBatchWithFallback(oversizedBatch(), 1, runSettings);
        h.api.bumpGeneration();
        await job;
        if (h.state.failed !== 0 || h.state.error !== "") {
          fail(`split failure: stale runId must not count (failed=${h.state.failed}, error=${JSON.stringify(h.state.error)})`);
        }
      }
    }

    // forceSplit path (canSplit single-segment): null join → FAILURE.
    {
      const canSplitError = new Error("payload too large");
      canSplitError.canSplit = true;
      const h = buildHarness({ requestError: canSplitError, splitResult: null });
      if (h) {
        await h.api.translateBatchWithFallback(
          [{ block: { isConnected: true }, text: "abcdef" }],
          1,
          runSettings
        );
        if (h.splitCalls.length === 0 || h.splitCalls[0].options?.forceSplit !== true) {
          fail("split failure: canSplit single-segment fallback must re-split with { forceSplit: true }");
        }
        if (h.state.failed !== 1) {
          fail(`split failure: null forceSplit join must count state.failed += 1, got ${h.state.failed}`);
        }
        if (h.state.error !== SPLIT_EMPTY) {
          fail(`split failure: forceSplit empty join must set state.error to "${SPLIT_EMPTY}", got ${JSON.stringify(h.state.error)}`);
        }
      }
    }

    // forceSplit path, STALE run (bumped inside the catch): no failure.
    {
      const canSplitError = new Error("payload too large");
      canSplitError.canSplit = true;
      const h = buildHarness({ requestError: canSplitError, splitResult: null });
      if (h) {
        const job = h.api.translateBatchWithFallback(
          [{ block: { isConnected: true }, text: "abcdef" }],
          1,
          runSettings
        );
        h.api.bumpGeneration();
        await job;
        if (h.state.failed !== 0 || h.state.error !== "") {
          fail(`split failure: stale forceSplit run must not count (failed=${h.state.failed}, error=${JSON.stringify(h.state.error)})`);
        }
      }
    }

    // A real joined translation still applies (no false failure).
    {
      const h = buildHarness({ splitResult: "甲\n\n乙" });
      if (h) {
        await h.api.translateBatchWithFallback(oversizedBatch(), 1, runSettings);
        if (h.state.failed !== 0 || h.state.error !== "") {
          fail(`split failure: a successful split join must not count as failure (failed=${h.state.failed})`);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // (c) Statics — trusted command wiring, billing surface, pill, retry.
  // ------------------------------------------------------------------

  // COMMAND_SELECTION_TRANSLATE: synchronous live-selection capture, then the
  // billable path — both inside the runtime.onMessage listener.
  const commandSlice = handlerSlice("COMMAND_SELECTION_TRANSLATE");
  if (!commandSlice) {
    fail("content.js: runtime.onMessage must handle COMMAND_SELECTION_TRANSLATE (Alt+T / context menu)");
  } else {
    if (!/captureSelectionGesture\(\)/.test(commandSlice)) {
      fail("content.js: COMMAND_SELECTION_TRANSLATE must capture the live selection synchronously via captureSelectionGesture()");
    }
    if (!/sendSelectionTranslation\(gesture\)/.test(commandSlice)) {
      fail("content.js: COMMAND_SELECTION_TRANSLATE must run the billable path sendSelectionTranslation(gesture)");
    }
    if (!/先选中要翻译的文字，再按 Alt\+T 或右键「翻译选中文字」/.test(commandSlice)) {
      fail("content.js: the no-selection hint must tell the user how to select (Alt+T / context menu)");
    }
    // The ONLY billable payload is the synchronously captured gesture — the
    // context-menu selectionText (unreadable-iframe case) is never billed.
    const billableCalls = stripComments(commandSlice).match(/sendSelectionTranslation\([^)]*\)/g) || [];
    if (billableCalls.length !== 1 || billableCalls[0] !== "sendSelectionTranslation(gesture)") {
      fail(`content.js: COMMAND_SELECTION_TRANSLATE must bill exactly once, with the captured gesture only (never message.selectionText), found ${JSON.stringify(billableCalls)}`);
    }
    // No gesture → the handler must NOT fall through to the billable path.
    const noGestureBranch = stripComments(commandSlice).split("sendSelectionTranslation(gesture)")[0];
    if (!/if \(!gesture\) \{[\s\S]*?return false;[\s\S]*?\}/.test(noGestureBranch)) {
      fail("content.js: the no-live-selection branch must reply {ok:false} and return before any billing");
    }
    // PR #19 follow-up: a selection INSIDE a textarea / text-like input is a
    // distinct no-gesture case — the hint must say 暂不支持翻译输入框内的文字
    // (the user DID select text), never the generic 先选中 line, and the
    // branch still never bills (the sendSelectionTranslation count above is
    // unchanged at exactly one).
    if (!/activeElementHasTextSelection\(\)/.test(noGestureBranch)) {
      fail("content.js: the no-gesture branch must consult activeElementHasTextSelection() to tell input-field selections apart");
    }
    if (!/暂不支持翻译输入框内的文字/.test(noGestureBranch)) {
      fail("content.js: a selection inside a textarea/input must show 暂不支持翻译输入框内的文字, not the generic 先选中 hint");
    }
    if (!/inputSelection \? "暂不支持翻译输入框内的文字" : "先选中要翻译的文字，再按 Alt\+T 或右键「翻译选中文字」"/.test(stripComments(noGestureBranch))) {
      fail("content.js: the no-gesture hint must pick its copy from the input-selection check");
    }
  }

  // No new page-DOM billable path: sendSelectionTranslation may only be
  // invoked by the two trusted runtime.onMessage handlers (its definition is
  // the third occurrence in the source).
  const sendCallSites = (content.match(/sendSelectionTranslation\(/g) || []).length;
  if (sendCallSites !== 3) {
    fail(`content.js: sendSelectionTranslation must have exactly 3 occurrences (definition + CONFIRM_SELECTION_TRANSLATE + COMMAND_SELECTION_TRANSLATE), found ${sendCallSites}`);
  }

  // PR #19 follow-up, functional: activeElementHasTextSelection over fake
  // focus trees — textarea / text-like inputs with a REAL selection count;
  // checkboxes, collapsed carets, non-fields and empty focus never do; open
  // shadow roots are walked to the deepest focused field.
  {
    const deepSrc = extract("deepActiveElement");
    const hasSrc = extract("activeElementHasTextSelection");
    const typesDecl = /const TEXT_SELECTION_INPUT_TYPES = new Set\(\[[^\]]*\]\);/.exec(contentRaw);
    if (!deepSrc || !hasSrc || !typesDecl) {
      fail("content.js: cannot extract deepActiveElement/activeElementHasTextSelection for the input-selection test");
    } else {
      const api = new Function(
        `${typesDecl[0]}\n${deepSrc}\n${hasSrc}\nreturn { deepActiveElement, activeElementHasTextSelection };`
      )();
      const field = (tagName, props = {}) => ({ tagName, ...props });
      const cases = [
        ["textarea with a selection", field("TEXTAREA", { selectionStart: 2, selectionEnd: 5 }), true],
        ["text input with a selection", field("INPUT", { type: "text", selectionStart: 0, selectionEnd: 3 }), true],
        ["search input with a selection", field("INPUT", { type: "search", selectionStart: 1, selectionEnd: 2 }), true],
        ["password input with a selection", field("INPUT", { type: "password", selectionStart: 1, selectionEnd: 4 }), true],
        ["input with no type defaults to text", field("INPUT", { selectionStart: 1, selectionEnd: 4 }), true],
        ["checkbox input never counts", field("INPUT", { type: "checkbox", selectionStart: 0, selectionEnd: 2 }), false],
        ["number input is not a text-like field", field("INPUT", { type: "number", selectionStart: 0, selectionEnd: 2 }), false],
        ["collapsed caret is no selection", field("TEXTAREA", { selectionStart: 3, selectionEnd: 3 }), false],
        ["no selection API on the field", field("INPUT", { type: "text" }), false],
        ["focused div is not a field", field("DIV"), false],
        ["focused select is not a field", field("SELECT", { selectionStart: 0, selectionEnd: 1 }), false]
      ];
      for (const [label, element, expected] of cases) {
        const got = api.activeElementHasTextSelection({ activeElement: element });
        if (got !== expected) {
          fail(`content.js: activeElementHasTextSelection — ${label}: expected ${expected}, got ${got}`);
        }
      }
      if (api.activeElementHasTextSelection({ activeElement: null }) !== false) {
        fail("content.js: activeElementHasTextSelection must be false with nothing focused");
      }
      // Open shadow roots: the deepest focused element wins (a closed root
      // reads as its host and is covered by the host cases above).
      const innerField = field("TEXTAREA", { selectionStart: 1, selectionEnd: 6 });
      const host = field("DIV", { shadowRoot: { activeElement: innerField } });
      if (api.activeElementHasTextSelection({ activeElement: host }) !== true) {
        fail("content.js: activeElementHasTextSelection must walk open shadow roots to the focused textarea");
      }
      if (api.deepActiveElement({ activeElement: host }) !== innerField) {
        fail("content.js: deepActiveElement must return the deepest focused element, not its host");
      }
      const nestedHost = field("DIV", { shadowRoot: { activeElement: host } });
      if (api.activeElementHasTextSelection({ activeElement: nestedHost }) !== true) {
        fail("content.js: activeElementHasTextSelection must walk nested shadow roots");
      }
      // A field whose selectionStart access throws (some input types) reads
      // as no selection, never crashes the handler.
      const throwing = field("INPUT", { type: "text" });
      Object.defineProperty(throwing, "selectionStart", { get() { throw new Error("boom"); } });
      if (api.activeElementHasTextSelection({ activeElement: throwing }) !== false) {
        fail("content.js: activeElementHasTextSelection must survive a throwing selectionStart getter (false, never a crash)");
      }
    }
  }

  // Every in-page button that can bill (pill 重试, marker 重试) is trusted-click
  // gated inside a closed shadow root.
  const pillClickSrc = extract("onPillClick");
  if (!pillClickSrc) {
    fail("content.js: cannot extract onPillClick for trusted-click test");
  } else {
    if (!/isTrusted === false/.test(pillClickSrc)) {
      fail("content.js: onPillClick must ignore untrusted (page-forged) clicks");
    }
    if (!/retryFailedBlocks\(\)/.test(pillClickSrc)) {
      fail("content.js: the pill retry action must route through retryFailedBlocks()");
    }
  }
  const markerRetrySrc = extract("onFailedMarkerRetry");
  if (!markerRetrySrc) {
    fail("content.js: cannot extract onFailedMarkerRetry for trusted-click test");
  } else {
    if (!/isTrusted === false/.test(markerRetrySrc)) {
      fail("content.js: onFailedMarkerRetry must ignore untrusted (page-forged) clicks");
    }
    if (!/retryFailedBlocks\(block\)/.test(markerRetrySrc)) {
      fail("content.js: the marker retry must retry only its own block via retryFailedBlocks(block)");
    }
  }
  const closedShadowCount = (contentRaw.match(/attachShadow\(\{ mode: "closed" \}\)/g) || []).length;
  if (closedShadowCount < 2) {
    fail(`content.js: progress pill and failure markers must live in closed shadow roots, found ${closedShadowCount}`);
  }
  if (!/id = "kilocean-progress-host"/.test(contentRaw) || !/data-deepseek-translator-ui/.test(extract("ensureProgressPill") || "")) {
    fail("content.js: the pill host must be owned chrome (id + data-deepseek-translator-ui marker)");
  }
  if (!/data-kilocean-failed-marker/.test(extract("showFailedMarker") || "")) {
    fail("content.js: failure markers must carry data-kilocean-failed-marker");
  }

  // ------------------------------------------------------------------
  // (P2-3) Failed-marker placement: a marker host may never land where the
  // HTML content model forbids it (a div directly under tr/tbody/ul/dl…).
  // resolveMarkerPlacement is the ONE pure decider showFailedMarker uses.
  // ------------------------------------------------------------------
  {
    const markerSrc = extract("showFailedMarker") || "";
    if (!/resolveMarkerPlacement\(/.test(markerSrc)) {
      fail("content.js: showFailedMarker must place its marker host through resolveMarkerPlacement()");
    }
    if (/block\.parentNode\.insertBefore\(\s*host/.test(markerSrc)) {
      fail("content.js: showFailedMarker must not insert the marker host as a raw sibling of the block (restricted parents break)");
    }
    const setOf = (name) => {
      const match = contentRaw.match(new RegExp(`const ${name} = new Set\\([\\s\\S]*?\\]\\);`));
      return match ? match[0] : null;
    };
    const insideSetSrc = setOf("MARKER_HOST_INSIDE_TAGS");
    const forbiddenSetSrc = setOf("MARKER_SIBLING_FORBIDDEN_PARENTS");
    const placementSrc = extract("resolveMarkerPlacement");
    if (!insideSetSrc || !forbiddenSetSrc || !placementSrc) {
      fail("content.js: cannot extract MARKER_HOST_INSIDE_TAGS/MARKER_SIBLING_FORBIDDEN_PARENTS/resolveMarkerPlacement for placement test");
    } else {
      // The restricted slots and containers the decider must know about.
      for (const tag of ["TD", "TH", "CAPTION", "LI", "DT", "DD"]) {
        if (!insideSetSrc.includes(`"${tag}"`)) {
          fail(`content.js: MARKER_HOST_INSIDE_TAGS must contain ${tag} (a marker sibling is invalid there)`);
        }
      }
      for (const tag of ["TR", "TABLE", "THEAD", "TBODY", "TFOOT", "UL", "OL", "DL", "SELECT", "COLGROUP"]) {
        if (!forbiddenSetSrc.includes(`"${tag}"`)) {
          fail(`content.js: MARKER_SIBLING_FORBIDDEN_PARENTS must contain ${tag} (no marker div may sit directly under it)`);
        }
      }
      // Drive the REAL extracted decider with plain-object blocks.
      let placement;
      try {
        placement = new Function(
          `${insideSetSrc}\n${forbiddenSetSrc}\n${placementSrc}\nreturn resolveMarkerPlacement;`
        )();
      } catch (error) {
        fail(`content.js: resolveMarkerPlacement is not runnable standalone: ${error.message}`);
      }
      if (typeof placement === "function") {
        const fakeParent = (tag) => ({ nodeType: 1, tagName: tag });
        const afterSibling = {};
        const cases = [
          {
            label: "TD under TR hosts the marker inside the cell",
            block: { tagName: "TD", parentNode: fakeParent("TR"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "TH under TR hosts the marker inside the cell",
            block: { tagName: "TH", parentNode: fakeParent("TR"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "LI under UL hosts the marker inside the item",
            block: { tagName: "LI", parentNode: fakeParent("UL"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "DT under DL hosts the marker inside the term",
            block: { tagName: "DT", parentNode: fakeParent("DL"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "CAPTION under TABLE hosts the marker inside",
            block: { tagName: "CAPTION", parentNode: fakeParent("TABLE"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "a block whose parent is TR goes inside even when the block itself is unrestricted",
            block: { tagName: "DIV", parentNode: fakeParent("TR"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "a block whose parent is TBODY goes inside",
            block: { tagName: "P", parentNode: fakeParent("TBODY"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "a block whose parent is UL goes inside",
            block: { tagName: "P", parentNode: fakeParent("UL"), nextSibling: afterSibling },
            expected: { parent: "block", before: null, tag: "span" }
          },
          {
            label: "P under DIV keeps the sibling div after the block",
            block: { tagName: "P", parentNode: fakeParent("DIV"), nextSibling: afterSibling },
            expected: { parent: "parentNode", before: afterSibling, tag: "div" }
          }
        ];
        for (const { label, block, expected } of cases) {
          const got = placement(block);
          const parentKey = got.parent === block
            ? "block"
            : got.parent === block.parentNode ? "parentNode" : "other";
          const okShape = parentKey === expected.parent &&
            got.before === expected.before &&
            got.tag === expected.tag;
          if (!okShape) {
            fail(`content.js: marker placement — ${label}: expected ${JSON.stringify({ parent: expected.parent, before: expected.before, tag: expected.tag })}, got ${JSON.stringify({ parent: parentKey, before: got.before, tag: got.tag })}`);
          }
        }
        // A last-child block (nextSibling null) still appends as a sibling
        // after it — insertBefore(host, null) appends.
        const lastP = { tagName: "P", parentNode: fakeParent("SECTION"), nextSibling: null };
        const gotLast = placement(lastP);
        if (gotLast.parent !== lastP.parentNode || gotLast.before !== null || gotLast.tag !== "div") {
          fail("content.js: marker placement — a last-child block appends the div sibling after itself");
        }
      }
    }
  }

  // Progress pill reads the REAL counters.
  const renderPillSrc = extract("renderProgressPill");
  const updatePillSrc = extract("updateProgressPill");
  if (!renderPillSrc || !updatePillSrc) {
    fail("content.js: cannot extract renderProgressPill/updateProgressPill for pill test");
  } else {
    for (const src of [renderPillSrc, updatePillSrc]) {
      if (!/state\.translated/.test(src) || !/state\.total/.test(src)) {
        fail("content.js: the progress pill must render the real state.translated / state.total counters");
      }
    }
    if (!/翻译中 \$\{state\.translated\} \/ \$\{state\.total\}/.test(renderPillSrc)) {
      fail("content.js: the translating pill must show 翻译中 N / M from state");
    }
    if (!/先翻可见区域/.test(renderPillSrc)) {
      fail("content.js: the translating pill must carry the 先翻可见区域 hint");
    }
  }

  // PR #19 follow-up: a terminal pill (翻译失败 / partial / done) must never
  // animate — the spin exists ONLY in the translating state, so an error pill
  // cannot read as work still in flight.
  {
    const pillCssMatch = /const PROGRESS_PILL_CSS = `([\s\S]*?)`;/.exec(contentRaw);
    if (!pillCssMatch) {
      fail("content.js: cannot extract PROGRESS_PILL_CSS for the spinner-state test");
    } else {
      const pillCss = stripComments(pillCssMatch[1]);
      // The only rules that may grant an animation are scoped to the
      // translating state; every other rule must leave animation at none.
      const animationRules = pillCss.match(/[^{}]*\{[^}]*animation:[^}]*\}/g) || [];
      for (const rule of animationRules) {
        const selector = rule.split("{")[0].trim();
        if (/animation:(?!\s*none)/.test(rule) && !/\.pill\.translating \.ring$/.test(selector)) {
          fail(`content.js: the progress pill may only animate in the translating state (.pill.translating .ring), found selector "${selector}"`);
        }
      }
      if (!/\.pill\.translating \.ring \{ animation: pill-spin 0\.9s linear infinite; \}/.test(pillCss)) {
        fail("content.js: the translating pill's ring must carry the pill-spin animation");
      }
      if (!/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pill\.translating \.ring \{ animation: none; \}/.test(pillCss)) {
        fail("content.js: prefers-reduced-motion must disable even the translating spinner");
      }
      // The base .ring rule must be inert (border only) — animation lives on
      // the .translating scope above.
      const baseRing = /\.pill \.ring \{[^}]*\}/.exec(pillCss);
      if (!baseRing || /animation/.test(baseRing[0])) {
        fail("content.js: the base .pill .ring rule must not animate on its own");
      }
    }
    if (renderPillSrc) {
      // Exactly one spinning ring exists — in the translating branch — and
      // the error/partial/done branches below it render only static rings
      // (ringp) or none at all.
      const translatingAt = renderPillSrc.indexOf('state.phase === "translating"');
      const errorAt = renderPillSrc.indexOf('state.phase === "error"');
      if (translatingAt < 0 || errorAt < 0 || translatingAt > errorAt) {
        fail("content.js: renderProgressPill must branch on phase (translating before error)");
      } else {
        const spinningRings = renderPillSrc.match(/class="ring"/g) || [];
        if (spinningRings.length !== 1 || renderPillSrc.indexOf('class="ring"') > errorAt) {
          fail('content.js: only the translating pill may render <span class="ring"> (the error/partial/done pills use the static ringp)');
        }
        const terminalBranches = renderPillSrc.slice(errorAt);
        if (/class="ring"/.test(terminalBranches) || /pill-spin/.test(terminalBranches)) {
          fail("content.js: the error/partial/done pill branches must not render the spinning ring");
        }
      }
    }
  }

  // RETRY_FAILED retries failed blocks only — never a restore/re-run.
  const retrySlice = handlerSlice("RETRY_FAILED");
  if (!retrySlice) {
    fail("content.js: runtime.onMessage must handle RETRY_FAILED (popup retry action)");
  } else if (!/retryFailedBlocks\(/.test(retrySlice) || /restoreOriginal/.test(retrySlice)) {
    fail("content.js: the RETRY_FAILED handler must call retryFailedBlocks() and must not restoreOriginal()");
  }
  const retryFnSrc = extract("retryFailedBlocks");
  if (!retryFnSrc) {
    fail("content.js: cannot extract retryFailedBlocks for retry test");
  } else {
    if (/restoreOriginal/.test(retryFnSrc)) {
      fail("content.js: retryFailedBlocks must never restoreOriginal (a retry must keep finished translations)");
    }
    if (!/translateBlocks\(/.test(retryFnSrc) || !/workQueue/.test(retryFnSrc)) {
      fail("content.js: retryFailedBlocks must run through translateBlocks on the shared workQueue");
    }
    if (!/isConnected/.test(retryFnSrc)) {
      fail("content.js: retryFailedBlocks must build segments only from connected failed blocks");
    }
  }
  if (!/failedRetryable/.test(extract("getPublicStatus") || "")) {
    fail("content.js: getPublicStatus must expose failedRetryable (connected failed blocks)");
  }

  // Exports/print strip the new hosts.
  const snapshotSrc = extract("downloadHtmlSnapshot");
  if (!snapshotSrc) {
    fail("content.js: cannot extract downloadHtmlSnapshot for export-strip test");
  } else {
    if (!/#kilocean-progress-host/.test(snapshotSrc)) {
      fail("content.js: downloadHtmlSnapshot must strip the progress pill host");
    }
    if (!/\[data-kilocean-failed-marker\]/.test(snapshotSrc)) {
      fail("content.js: downloadHtmlSnapshot must strip in-place failure markers");
    }
  }

  // PR #19 follow-up: live print must hide failure markers (HTML export
  // already strips them, but PRINT_PAGE previously only hid the pill).
  {
    const printSlice = handlerSlice("PRINT_PAGE") || "";
    if (!printSlice) {
      fail("content.js: runtime.onMessage must handle PRINT_PAGE");
    } else if (!/window\.print\(/.test(printSlice)) {
      fail("content.js: PRINT_PAGE must call window.print()");
    } else if (!/querySelectorAll\("\[data-kilocean-failed-marker\]"\)/.test(printSlice)) {
      fail("content.js: PRINT_PAGE must query [data-kilocean-failed-marker] hosts to hide them for print");
    } else if (!/markerHosts[\s\S]{0,200}style\.display\s*=\s*"none"/.test(printSlice)) {
      fail("content.js: PRINT_PAGE must set failure-marker hosts to display:none before window.print()");
    } else if (!/#kilocean-progress-host|progressPillHost/.test(printSlice)) {
      fail("content.js: PRINT_PAGE must still hide the progress pill around window.print()");
    }
  }

  // PR #19 follow-up: a key error mid-run (translated + failed) lands in the
  // partial pill — offer 「打开设置」, never Retry (which would re-bill).
  if (renderPillSrc) {
    const partialAt = renderPillSrc.indexOf("if (state.failed > 0)");
    if (partialAt < 0) {
      fail("content.js: renderProgressPill must have a partial (state.failed > 0) branch");
    } else {
      const partialSrc = renderPillSrc.slice(partialAt);
      if (!/isKeyRelatedError\(state\.error\)/.test(partialSrc)) {
        fail("content.js: the partial pill must consult isKeyRelatedError(state.error)");
      }
      if (!/data-action="settings"/.test(partialSrc) || !/打开设置/.test(partialSrc)) {
        fail('content.js: the partial pill must offer 「打开设置」 for key-related errors');
      }
      // When the error IS key-related, the retry button must not be the one offered.
      const keyBranch = /isKeyRelatedError\(state\.error\)\s*\?[\s\S]*?:/.exec(partialSrc);
      if (!keyBranch) {
        fail("content.js: the partial pill must ternary-choose settings vs retry by isKeyRelatedError");
      } else if (/data-action="retry"/.test(keyBranch[0])) {
        fail("content.js: the key-related arm of the partial pill must not include a retry action");
      }
    }
  }

  // ------------------------------------------------------------------
  // (d) Copy + version.
  // ------------------------------------------------------------------
  if (contentRaw.includes("请在扩展弹窗中确认翻译")) {
    fail("content.js: the old copy “请在扩展弹窗中确认翻译” must be gone (selection now bills via Alt+T / context menu / popup fallback)");
  }
  if (!contentRaw.includes("按 Alt+T 翻译选中文字 · 右键也可以")) {
    fail("content.js: the selection preview hint must be the non-billable Alt+T copy");
  }
  if (!contentRaw.includes("还没有配置 API Key")) {
    fail("content.js: the key-gate bubble must render the friendly “还没有配置 API Key” copy");
  }
  if (!contentRaw.includes("Kilocean Translate 1.5.0")) {
    fail("content.js: export generator meta must carry Kilocean Translate 1.5.0");
  }
}

// Direct-run convenience (`node scripts/checks-content-150.mjs`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = [];
  await runContent150Checks({
    ROOT: path.resolve(path.dirname(process.argv[1]), ".."),
    fail: (message) => errors.push(message)
  });
  if (errors.length > 0) {
    console.error("CHECKS-CONTENT-150 FAILED:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("OK: checks-content-150 (orderSegmentsByViewport tiers, split-empty failure accounting, COMMAND_SELECTION_TRANSLATE wiring incl. input-field selection hint, trusted in-page buttons, progress pill counters + translating-only spinner, retry-failed path, copy)");
}
