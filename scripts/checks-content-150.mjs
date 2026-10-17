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
  }

  // No new page-DOM billable path: sendSelectionTranslation may only be
  // invoked by the two trusted runtime.onMessage handlers (its definition is
  // the third occurrence in the source).
  const sendCallSites = (content.match(/sendSelectionTranslation\(/g) || []).length;
  if (sendCallSites !== 3) {
    fail(`content.js: sendSelectionTranslation must have exactly 3 occurrences (definition + CONFIRM_SELECTION_TRANSLATE + COMMAND_SELECTION_TRANSLATE), found ${sendCallSites}`);
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
  console.log("OK: checks-content-150 (orderSegmentsByViewport tiers, split-empty failure accounting, COMMAND_SELECTION_TRANSLATE wiring, trusted in-page buttons, progress pill counters, retry-failed path, copy)");
}
