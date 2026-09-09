(function initializeDeepSeekTranslator() {
  "use strict";

  if (globalThis.__deepSeekWebTranslatorLoaded) {
    return;
  }
  globalThis.__deepSeekWebTranslatorLoaded = true;

  const Utils = globalThis.DeepSeekTranslatorUtils;
  const BLOCKED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT",
    "SELECT", "OPTION", "KBD", "SAMP", "SVG", "MATH", "CANVAS"
  ]);
  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE",
    "FIGCAPTION", "DT", "DD", "SUMMARY", "CAPTION", "TD", "TH",
    "ARTICLE", "SECTION", "HEADER", "FOOTER", "ASIDE", "MAIN"
  ]);

  /** @type {Map<Element, {block: Element, originalText: string, translation: string, wrap: HTMLElement|null, wraps: HTMLElement[], companion: HTMLElement, layout: string}>} */
  const blockRecords = new Map();
  const pendingRoots = new Set();
  const pendingRefreshBlocks = new Set();

  let mutationObserver = null;
  let dynamicTimer = null;
  let workQueue = Promise.resolve();
  let generation = 0;
  let toastTimer = null;
  let selectionTimer = null;
  let selectionGeneration = 0;
  let styleHost = null;
  let applyingDom = false;
  let applyingDomGeneration = 0;
  /** @type {{ targetLanguage: string, model: string } | null} */
  let activeRunSettings = null;
  /** @type {{ targetLanguage?: string, model?: string } | null} */
  let deferredRunSettings = null;

  const state = {
    active: false,
    phase: "idle",
    translated: 0,
    total: 0,
    failed: 0,
    error: "",
    targetLanguage: "zh-CN",
    model: "deepseek-v4-flash",
    displayMode: Utils.DISPLAY_MODES.bilingual
  };

  ensureTranslatorStyles();
  applyDocumentDisplayMode(state.displayMode);
  setupSelectionTranslate();

  chrome.storage.local.get({
    displayMode: Utils.DISPLAY_MODES.bilingual,
    targetLanguage: state.targetLanguage,
    model: state.model
  }, (stored) => {
    state.displayMode = Utils.normalizeDisplayMode(stored.displayMode);
    if (stored.targetLanguage) {
      state.targetLanguage = stored.targetLanguage;
    }
    if (stored.model) {
      state.model = stored.model;
    }
    applyDocumentDisplayMode(state.displayMode);
    refreshAllBlockDisplays();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.displayMode) {
      state.displayMode = Utils.normalizeDisplayMode(changes.displayMode.newValue);
      applyDocumentDisplayMode(state.displayMode);
      refreshAllBlockDisplays();
    }
    if (changes.targetLanguage?.newValue) {
      // Keep the active page run stable while translations remain on-screen.
      if (state.active) {
        deferredRunSettings = {
          ...(deferredRunSettings || {}),
          targetLanguage: changes.targetLanguage.newValue
        };
      } else {
        state.targetLanguage = changes.targetLanguage.newValue;
      }
    }
    if (changes.model?.newValue) {
      if (state.active) {
        deferredRunSettings = {
          ...(deferredRunSettings || {}),
          model: changes.model.newValue
        };
      } else {
        state.model = changes.model.newValue;
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_CONTENT") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "GET_STATUS") {
      sendResponse({ ok: true, status: getPublicStatus() });
      return false;
    }

    if (message?.type === "START_TRANSLATION") {
      startTranslation(message.options || {})
        .then(() => sendResponse({ ok: true, status: getPublicStatus() }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "RESTORE_ORIGINAL") {
      restoreOriginal();
      sendResponse({ ok: true, status: getPublicStatus() });
      return false;
    }

    if (message?.type === "SET_DISPLAY_MODE") {
      const mode = Utils.normalizeDisplayMode(message.displayMode);
      state.displayMode = mode;
      applyDocumentDisplayMode(mode);
      refreshAllBlockDisplays();
      chrome.storage.local.set({ displayMode: mode });
      sendResponse({ ok: true, status: getPublicStatus() });
      return false;
    }

    if (message?.type === "EXPORT_HTML") {
      try {
        const filename = downloadHtmlSnapshot();
        sendResponse({ ok: true, filename });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }

    if (message?.type === "PRINT_PAGE") {
      try {
        assertExportReady();
        sendResponse({ ok: true });
        setTimeout(() => {
          // Live print includes fixed overlays; HTML export already strips the host.
          hideSelectionPanel();
          hideToast();
          window.print();
        }, 80);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }

    return false;
  });

  async function startTranslation(options) {
    const targetLanguage = options.targetLanguage || "zh-CN";
    const model = options.model || "deepseek-v4-flash";
    let displayMode = Utils.normalizeDisplayMode(
      options.displayMode || state.displayMode || Utils.DISPLAY_MODES.bilingual
    );
    let coercedFromOriginal = false;
    if (displayMode === Utils.DISPLAY_MODES.original) {
      displayMode = Utils.DISPLAY_MODES.bilingual;
      coercedFromOriginal = true;
      chrome.storage.local.set({ displayMode });
    }

    if (
      state.active &&
      state.targetLanguage === targetLanguage &&
      state.model === model &&
      state.phase === "translating"
    ) {
      return;
    }

    if (blockRecords.size > 0) {
      restoreOriginal({ silent: true });
    }

    generation += 1;
    const runId = generation;
    deferredRunSettings = null;
    activeRunSettings = { targetLanguage, model };
    Object.assign(state, {
      active: true,
      phase: "translating",
      translated: 0,
      total: 0,
      failed: 0,
      error: "",
      targetLanguage,
      model,
      displayMode
    });
    applyDocumentDisplayMode(displayMode);
    // Sync popup immediately when coercing original→bilingual (before long batches).
    if (coercedFromOriginal) {
      notifyPopupStatus();
    }

    showToast("正在识别网页内容…", "loading");
    startObserving();

    const blocks = collectBlocks(document.body || document.documentElement);
    state.total = blocks.length;

    if (blocks.length === 0) {
      state.phase = "translated";
      finishRunSettings();
      showToast("没有发现需要翻译的内容", "info");
      notifyPopupStatus();
      return;
    }

    await translateBlocks(blocks, runId, false);
    if (runId !== generation) {
      return;
    }

    state.phase = state.failed > 0 && state.translated === 0 ? "error" : "translated";
    finishRunSettings();
    notifyPopupStatus();
    if (state.phase === "error") {
      showToast(state.error || "翻译失败", "error", 6000);
    } else if (state.failed > 0) {
      showToast(`已翻译 ${state.translated} 条，${state.failed} 条失败`, "warning", 5000);
    } else {
      showToast(`已翻译 ${state.translated} 条内容`, "success");
    }
  }

  function finishRunSettings() {
    // Keep activeRunSettings pinned for dynamic follow-on translations so this
    // page does not mix languages/models after a mid-run settings save.
    // Deferred prefs apply on the next startTranslation (via popup options) or
    // after restoreOriginal clears the session.
    deferredRunSettings = null;
  }

  function getRunSettings() {
    return activeRunSettings || {
      targetLanguage: state.targetLanguage,
      model: state.model
    };
  }

  function beginApplyingDom() {
    applyingDomGeneration += 1;
    applyingDom = true;
    return applyingDomGeneration;
  }

  function endApplyingDom(gen) {
    // Drain records queued synchronously for our own DOM writes before the
    // observer callback can run with applyingDom already false.
    try {
      mutationObserver?.takeRecords();
    } catch {
      // Observer may be disconnected.
    }
    if (gen === applyingDomGeneration) {
      applyingDom = false;
    }
  }

  function notifyPopupStatus() {
    try {
      chrome.runtime.sendMessage({
        type: "CONTENT_STATUS",
        status: getPublicStatus()
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Popup may be closed; storage + final START_TRANSLATION response still sync.
    }
  }

  function restoreOriginal(options = {}) {
    generation += 1;
    stopObserving();
    activeRunSettings = null;
    deferredRunSettings = null;

    for (const record of blockRecords.values()) {
      teardownBlockRecord(record);
    }

    blockRecords.clear();
    pendingRoots.clear();
    pendingRefreshBlocks.clear();
    Object.assign(state, {
      active: false,
      phase: "idle",
      translated: 0,
      total: 0,
      failed: 0,
      error: ""
    });
    if (!options.silent) {
      showToast("已恢复原文", "info");
    }
  }

  function teardownBlockRecord(record) {
    if (!record) {
      return;
    }

    const gen = beginApplyingDom();
    try {
      const { block, wrap, companion } = record;
      companion?.remove();

      // Fully unwrap even when the host is detached (virtualized lists / SPA reuse).
      // Only unwrap wraps we created — never query by class (page may reuse the name).
      const wraps = [];
      if (wrap) {
        wraps.push(wrap);
      }
      for (const extra of record.wraps || []) {
        if (extra && !wraps.includes(extra)) {
          wraps.push(extra);
        }
      }
      for (const owned of wraps) {
        const parent = owned.parentNode;
        if (!parent) {
          continue;
        }
        while (owned.firstChild) {
          parent.insertBefore(owned.firstChild, owned);
        }
        owned.remove();
      }

      if (block) {
        block.removeAttribute("data-kilocean-block");
        block.removeAttribute("data-kilocean-display");
        block.removeAttribute("data-kilocean-layout");
      }
    } finally {
      endApplyingDom(gen);
    }
  }

  function pruneDetachedBlockRecords() {
    for (const [block, record] of [...blockRecords.entries()]) {
      if (block.isConnected) {
        continue;
      }
      teardownBlockRecord(record);
      blockRecords.delete(block);
      if (state.translated > 0) {
        state.translated -= 1;
      }
    }
  }

  function collectBlocks(root) {
    const textNodes = collectTextNodes(root);
    const blocks = [];
    const seen = new Set();
    const targetLanguage = getRunSettings().targetLanguage;

    for (const node of textNodes) {
      const block = getBlockAncestor(node);
      if (!block || seen.has(block) || blockRecords.has(block)) {
        continue;
      }
      const fullText = extractBlockText(block);
      if (!fullText || !Utils.isTranslatableText(fullText, targetLanguage)) {
        continue;
      }
      seen.add(block);
      blocks.push(block);
    }

    // Prefer deepest blocks, but keep ancestors that still own direct text.
    // Nesting via one DOM-order pass (not O(n^2) contains scans).
    const { deepest, descendantsOf } = indexElementNesting(blocks);
    const deepestSet = new Set(deepest);
    const withOwnText = [];
    for (const block of blocks) {
      if (deepestSet.has(block)) {
        continue;
      }
      const nested = (descendantsOf.get(block) || []).filter((other) => deepestSet.has(other));
      if (nested.length === 0) {
        continue;
      }
      const ownText = extractBlockText(block, nested);
      if (ownText && Utils.isTranslatableText(ownText, targetLanguage)) {
        withOwnText.push(block);
      }
    }
    return [...deepest, ...withOwnText];
  }

  /**
   * Derive parent/descendant relationships for a set of elements in one
   * document-order pass (stack + contains), avoiding quadratic scans.
   * @param {Element[]} elements
   * @returns {{ deepest: Element[], descendantsOf: Map<Element, Element[]> }}
   */
  function indexElementNesting(elements) {
    const list = [...new Set(elements.filter(Boolean))];
    const descendantsOf = new Map(list.map((el) => [el, []]));
    if (list.length <= 1) {
      return { deepest: list.slice(), descendantsOf };
    }

    list.sort((a, b) => {
      if (a === b) {
        return 0;
      }
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });

    const hasListedChild = new Set();
    const stack = [];
    for (const el of list) {
      while (stack.length && !stack[stack.length - 1].contains(el)) {
        stack.pop();
      }
      for (const ancestor of stack) {
        descendantsOf.get(ancestor).push(el);
      }
      if (stack.length) {
        hasListedChild.add(stack[stack.length - 1]);
      }
      stack.push(el);
    }

    const deepest = list.filter((el) => !hasListedChild.has(el));
    return { deepest, descendantsOf };
  }

  function collectTextNodes(root) {
    if (!root || !root.isConnected) {
      return [];
    }

    if (root.nodeType === Node.TEXT_NODE) {
      return shouldTranslateTextNode(root) ? [root] : [];
    }

    const nodes = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return shouldTranslateTextNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  function isHiddenElement(el) {
    if (!el) {
      return true;
    }
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  }

  function isFlexOrGridDisplay(display) {
    return display === "flex" || display === "grid" || display === "inline-flex" || display === "inline-grid";
  }

  function isFlexOrGridElement(el) {
    return Boolean(el) && isFlexOrGridDisplay(getComputedStyle(el).display);
  }

  function isTranslatorUiElement(el) {
    return Boolean(el?.closest?.("[data-deepseek-translator-ui]"));
  }

  function isEligibleTextHost(parent, { skipRecordedBlock = true } = {}) {
    if (!parent) {
      return false;
    }
    if (BLOCKED_TAGS.has(parent.tagName)) {
      return false;
    }
    if (parent.closest('[translate="no"], [contenteditable="true"], [data-deepseek-translator-ui]')) {
      return false;
    }
    if (skipRecordedBlock && parent.closest("[data-kilocean-block]")) {
      return false;
    }
    return !isHiddenElement(parent);
  }

  function shouldTranslateTextNode(node) {
    if (!node?.parentElement) {
      return false;
    }
    if (!isEligibleTextHost(node.parentElement, { skipRecordedBlock: true })) {
      return false;
    }
    return Utils.isTranslatableText(node.data, state.targetLanguage);
  }

  function collectRawTextNodes(root) {
    if (!root || !root.isConnected) {
      return [];
    }

    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      if (!parent || BLOCKED_TAGS.has(parent.tagName) || isTranslatorUiElement(parent) || isHiddenElement(parent)) {
        return [];
      }
      if (parent.closest('[translate="no"], [contenteditable="true"]')) {
        return [];
      }
      return root.data?.trim() ? [root] : [];
    }

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || BLOCKED_TAGS.has(parent.tagName) || isTranslatorUiElement(parent) || isHiddenElement(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('[translate="no"], [contenteditable="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.data?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  function getBlockAncestor(node) {
    let el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.closest("[data-deepseek-translator-ui]")) {
        return null;
      }
      if (BLOCK_TAGS.has(el.tagName)) {
        return el;
      }
      const display = getComputedStyle(el).display;
      // Never promote flex/grid containers to wrap hosts — that collapses items.
      if (isFlexOrGridDisplay(display)) {
        el = el.parentElement;
        continue;
      }
      if (display === "block" || display === "list-item" || display === "table-cell") {
        return el;
      }
      el = el.parentElement;
    }
    const fallback = node.parentElement;
    if (fallback && isFlexOrGridElement(fallback)) {
      return fallback;
    }
    return fallback;
  }

  function extractBlockText(block, excludeBlocks = []) {
    const exclude = excludeBlocks.filter(Boolean);
    const nodes = collectRawTextNodes(block).filter((node) => (
      !exclude.some((other) => other !== block && other.contains(node))
    ));
    return joinRawTextNodes(nodes);
  }

  function joinRawTextNodes(nodes) {
    if (nodes.length === 0) {
      return "";
    }

    let result = nodes[0].data;
    for (let i = 1; i < nodes.length; i += 1) {
      const sep = textNodeBoundarySeparator(nodes[i - 1], nodes[i]);
      const next = nodes[i].data;
      if (sep === "\n") {
        result = `${result.replace(/\s+$/gu, "")}\n${next.replace(/^\s+/gu, "")}`;
      } else if (sep === " ") {
        if (/\s$/u.test(result) || /^\s/u.test(next)) {
          result += next;
        } else {
          result += ` ${next}`;
        }
      } else {
        result += next;
      }
    }

    return result
      .replace(/[^\S\n]+/gu, " ")
      .replace(/\s*\n\s*/gu, "\n")
      .trim();
  }

  function textNodeBoundarySeparator(left, right) {
    try {
      const range = document.createRange();
      range.setStart(left, left.length);
      range.setEnd(right, 0);
      const holder = document.createElement("div");
      holder.appendChild(range.cloneContents());
      if (holder.querySelector("br, hr")) {
        return "\n";
      }
      for (const el of holder.querySelectorAll("*")) {
        if (BLOCK_TAGS.has(el.tagName) || el.tagName === "DIV" || el.tagName === "TR") {
          return "\n";
        }
      }
      const between = holder.textContent || "";
      // Standalone whitespace between inlines (e.g. </span> <span>) must stay a
      // space — returning "" collapses "Hello world" into "Helloworld".
      if (/\s/u.test(between)) {
        return " ";
      }
    } catch {
      return " ";
    }

    const leftParent = left.parentElement;
    const rightParent = right.parentElement;
    if (
      leftParent &&
      rightParent &&
      leftParent !== rightParent &&
      !leftParent.contains(rightParent) &&
      !rightParent.contains(leftParent)
    ) {
      return " ";
    }
    return "";
  }

  async function translateBlocks(blocks, runId, isDynamic) {
    const runSettings = getRunSettings();
    const candidates = [...new Set(blocks)].filter((block) => block?.isConnected && !blockRecords.has(block));

    // Include already-translated descendants so ancestor refresh does not
    // re-send their original text (duplicate translation of nested <p> etc.).
    const recordedConnected = [];
    for (const recorded of blockRecords.keys()) {
      if (recorded?.isConnected) {
        recordedConnected.push(recorded);
      }
    }
    const { descendantsOf } = indexElementNesting(
      candidates.length === 0 ? [] : [...candidates, ...recordedConnected]
    );

    const segments = [];
    for (const block of candidates) {
      const nested = descendantsOf.get(block) || [];
      const text = extractBlockText(block, nested);
      if (!text || !Utils.isTranslatableText(text, runSettings.targetLanguage)) {
        continue;
      }
      segments.push({
        block,
        text,
        nested,
        companionOnly: nested.length > 0
      });
    }

    if (segments.length === 0 || runId !== generation) {
      return;
    }

    if (isDynamic) {
      state.phase = "translating";
      state.total += segments.length;
      showToast("正在翻译新加载的内容…", "loading");
    }

    const batches = Utils.chunkSegments(segments, 5000, 24);

    for (const batch of batches) {
      if (runId !== generation) {
        return;
      }
      await translateBatchWithFallback(batch, runId, runSettings);
    }

    if (isDynamic && runId === generation) {
      // Mirror the initial-run outcome so 401/429 etc. are not reported as success.
      if (state.failed > 0 && state.translated === 0) {
        state.phase = "error";
        showToast(state.error || "翻译失败", "error", 6000);
      } else if (state.failed > 0) {
        state.phase = "translated";
        showToast(`已翻译 ${state.translated} 条，${state.failed} 条失败`, "warning", 5000);
      } else {
        state.phase = "translated";
        showToast("新内容已翻译", "success");
      }
      notifyPopupStatus();
    }
  }

  function findSegmentSplitIndex(text) {
    const length = text.length;
    if (length < 2) {
      return -1;
    }
    const mid = Math.ceil(length / 2);
    const window = Math.min(240, Math.floor(length / 4));
    for (let distance = 0; distance <= window; distance += 1) {
      for (const index of [mid - distance, mid + distance]) {
        if (index <= 0 || index >= length) {
          continue;
        }
        if (/\s/u.test(text[index - 1]) || /\s/u.test(text[index])) {
          return index;
        }
      }
    }
    return mid;
  }

  async function requestSegmentTranslations(texts, runId, runSettings) {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      texts,
      targetLanguage: runSettings.targetLanguage,
      model: runSettings.model
    });

    if (!response?.ok) {
      const error = new Error(response?.error || "翻译请求失败");
      error.canSplit = Boolean(response?.canSplit);
      throw error;
    }

    if (runId !== generation) {
      return null;
    }

    return response.translations;
  }

  async function translateSegmentTextWithSplit(text, runId, runSettings) {
    try {
      const translations = await requestSegmentTranslations([text], runId, runSettings);
      if (!translations) {
        return null;
      }
      return String(translations[0] || "");
    } catch (error) {
      if (!error.canSplit || runId !== generation) {
        throw error;
      }
      const splitAt = findSegmentSplitIndex(text);
      if (splitAt < 1) {
        throw error;
      }
      const left = await translateSegmentTextWithSplit(text.slice(0, splitAt), runId, runSettings);
      if (left == null || runId !== generation) {
        return null;
      }
      const right = await translateSegmentTextWithSplit(text.slice(splitAt), runId, runSettings);
      if (right == null || runId !== generation) {
        return null;
      }
      // Preserve boundary whitespace from the original slice join.
      return `${left}${right}`;
    }
  }

  function applyTranslatedSegment(segment, translation) {
    if (!segment.block.isConnected || blockRecords.has(segment.block)) {
      return false;
    }

    const currentText = extractBlockText(segment.block, segment.nested || []);
    if (currentText !== segment.text) {
      return false;
    }

    const rendered = String(translation || "").trim();
    if (!rendered) {
      return false;
    }

    applyBlockTranslation(segment.block, segment.text, rendered, {
      companionOnly: Boolean(segment.companionOnly),
      nested: segment.nested || []
    });
    state.translated += 1;
    return true;
  }

  async function translateBatchWithFallback(batch, runId, runSettings = getRunSettings()) {
    // Oversized single block: split before the first request (413 may never recover otherwise).
    if (batch.length === 1 && batch[0].text.length > 5000 && runId === generation) {
      const segment = batch[0];
      try {
        const joined = await translateSegmentTextWithSplit(segment.text, runId, runSettings);
        if (joined == null || runId !== generation) {
          return;
        }
        await applyTranslatedSegment(segment, joined);
        return;
      } catch (error) {
        state.failed += 1;
        state.error = error.message;
        return;
      }
    }

    try {
      const translations = await requestSegmentTranslations(
        batch.map((segment) => segment.text),
        runId,
        runSettings
      );

      if (!translations) {
        return;
      }

      translations.forEach((translation, index) => {
        applyTranslatedSegment(batch[index], translation);
      });
    } catch (error) {
      if (error.canSplit && batch.length > 1 && runId === generation) {
        const middle = Math.ceil(batch.length / 2);
        await translateBatchWithFallback(batch.slice(0, middle), runId, runSettings);
        await translateBatchWithFallback(batch.slice(middle), runId, runSettings);
        return;
      }

      // Single oversized segment: bisect text, translate halves, apply once.
      if (error.canSplit && batch.length === 1 && runId === generation) {
        const segment = batch[0];
        try {
          const joined = await translateSegmentTextWithSplit(segment.text, runId, runSettings);
          if (joined == null || runId !== generation) {
            return;
          }
          await applyTranslatedSegment(segment, joined);
          return;
        } catch (splitError) {
          state.failed += 1;
          state.error = splitError.message;
          return;
        }
      }

      state.failed += batch.length;
      state.error = error.message;
    }
  }

  function wrapTextNodesForToggle(block, nestedBlocks, wrapTag) {
    // Wrap text nodes only — never reparent element children — so selectors
    // like `p > a` and interactive descendants stay intact.
    const nested = (nestedBlocks || []).filter(Boolean);
    const textNodes = collectRawTextNodes(block).filter((node) => (
      !nested.some((other) => other !== block && other.contains(node))
    ));
    let firstWrap = null;
    const wraps = [];

    for (const textNode of textNodes) {
      if (!textNode?.isConnected || textNode.parentElement == null) {
        continue;
      }
      if (textNode.parentElement.classList?.contains("kilocean-original-wrap")) {
        // Already wrapped (e.g. prior pass) — do not adopt page-owned same-class nodes.
        continue;
      }
      if (!/\S/u.test(textNode.data || "")) {
        continue;
      }
      const wrap = document.createElement(wrapTag === "div" ? "span" : wrapTag);
      wrap.className = "kilocean-original-wrap";
      // Not UI-marked: SPA edits to owned original text must still refresh.
      textNode.parentNode.insertBefore(wrap, textNode);
      wrap.appendChild(textNode);
      wraps.push(wrap);
      if (!firstWrap) {
        firstWrap = wrap;
      }
    }
    return { firstWrap, wraps };
  }

  function applyBlockTranslation(block, originalText, translation, options = {}) {
    if (blockRecords.has(block)) {
      return;
    }

    const gen = beginApplyingDom();
    try {
      const inlineHosts = new Set([
        "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DT", "DD",
        "FIGCAPTION", "TD", "TH", "CAPTION", "SUMMARY", "A", "SPAN", "LABEL"
      ]);
      const wrapTag = inlineHosts.has(block.tagName) ? "span" : "div";
      let placement = getTranslationPlacement(block);
      // Nested translated descendants must stay visible in translation-only mode;
      // after-host would hide the whole nowrap flex host including those nested blocks.
      if (options.companionOnly) {
        placement = "companion";
      }
      let wrap = null;
      let createdWraps = [];
      let layout = "wrap";

      const companion = document.createElement(wrapTag);
      companion.className = "kilocean-translation";
      companion.setAttribute("data-deepseek-translator-ui", "true");
      companion.setAttribute("lang", getRunSettings().targetLanguage);
      companion.textContent = translation;

      if (placement === "after-host" && block.parentNode && block !== document.body && block !== document.documentElement) {
        // nowrap flex: full-width flex item would squeeze siblings — place as block sibling.
        companion.classList.add("kilocean-translation--after");
        block.parentNode.insertBefore(companion, block.nextSibling);
        block.setAttribute("data-kilocean-layout", "after");
        layout = "after";
      } else if (placement === "companion") {
        // Nested ancestor with own text: wrap owned text nodes so translation-only
        // can hide them without reparenting nested block subtrees or interactive els.
        ({ firstWrap: wrap, wraps: createdWraps } = wrapTextNodesForToggle(block, options.nested || [], wrapTag));
        companion.classList.add("kilocean-translation--flow");
        block.appendChild(companion);
        block.setAttribute("data-kilocean-layout", "companion");
        layout = "companion";
      } else if (placement === "flow") {
        // Preserve flex/grid structure: do not wrap existing children.
        companion.classList.add("kilocean-translation--flow");
        block.appendChild(companion);
        block.setAttribute("data-kilocean-layout", "flow");
        layout = "flow";
      } else {
        // Wrap text nodes only — keep element children in place (p > a, buttons…).
        ({ firstWrap: wrap, wraps: createdWraps } = wrapTextNodesForToggle(block, [], wrapTag));
        block.appendChild(companion);
        block.setAttribute("data-kilocean-layout", "wrap");
        layout = "wrap";
      }

      block.setAttribute("data-kilocean-block", "true");

      const record = {
        block,
        originalText,
        translation,
        wrap,
        wraps: createdWraps,
        companion,
        layout
      };
      blockRecords.set(block, record);
      applyBlockDisplay(record);
    } finally {
      endApplyingDom(gen);
    }
  }

  function getTranslationPlacement(block) {
    const style = getComputedStyle(block);
    const display = style.display;
    if (display === "grid" || display === "inline-grid") {
      return "flow";
    }
    if (display === "flex" || display === "inline-flex") {
      // flex-wrap:nowrap (default) cannot break a 100% basis item onto its own row.
      if ((style.flexWrap || "nowrap") === "nowrap") {
        return "after-host";
      }
      return "flow";
    }
    return "wrap";
  }

  function applyBlockDisplay(record) {
    if (!record?.block) {
      return;
    }
    record.block.setAttribute("data-kilocean-display", state.displayMode);
  }

  function refreshAllBlockDisplays() {
    for (const record of blockRecords.values()) {
      applyBlockDisplay(record);
    }
  }

  function applyDocumentDisplayMode(mode) {
    document.documentElement.setAttribute("data-kilocean-display", Utils.normalizeDisplayMode(mode));
  }

  function ensureTranslatorStyles() {
    if (styleHost?.isConnected) {
      return;
    }

    styleHost = document.createElement("style");
    styleHost.id = "kilocean-translator-style";
    styleHost.setAttribute("data-deepseek-translator-ui", "true");
    styleHost.textContent = `
      [data-kilocean-block] > .kilocean-translation {
        display: block;
        margin-top: 0.4em;
        padding-top: 0.3em;
        border-top: 1px dashed rgba(112, 135, 255, 0.38);
        line-height: inherit;
        white-space: pre-wrap;
      }
      [data-kilocean-block][data-kilocean-layout="flow"] > .kilocean-translation--flow {
        flex: 0 0 100%;
        width: 100%;
        max-width: 100%;
        grid-column: 1 / -1;
        box-sizing: border-box;
      }
      .kilocean-translation--after {
        display: block;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        margin-top: 0.4em;
        padding-top: 0.3em;
        border-top: 1px dashed rgba(112, 135, 255, 0.38);
        line-height: inherit;
        white-space: pre-wrap;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] .kilocean-original-wrap {
        display: contents;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] > .kilocean-translation {
        display: block;
        opacity: 0.96;
      }
      html[data-kilocean-display="bilingual"] .kilocean-translation--after {
        opacity: 0.96;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block] .kilocean-original-wrap {
        display: none !important;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block][data-kilocean-layout="flow"] > :not(.kilocean-translation) {
        display: none !important;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block][data-kilocean-layout="after"] {
        display: none !important;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block] > .kilocean-translation {
        display: block;
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }
      html[data-kilocean-display="translation-only"] .kilocean-translation--after {
        display: block;
        margin-top: 0;
        padding-top: 0;
        border-top: 0;
      }
      html[data-kilocean-display="original"] [data-kilocean-block] .kilocean-original-wrap {
        display: contents;
      }
      html[data-kilocean-display="original"] [data-kilocean-block] > .kilocean-translation,
      html[data-kilocean-display="original"] .kilocean-translation--after {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleHost);
  }

  function isInsideOriginalWrap(el) {
    return Boolean(el?.closest?.(".kilocean-original-wrap"));
  }

  function isExtensionOwnedNode(node) {
    // Only the extension chrome nodes themselves — not page content living inside
    // .kilocean-original-wrap (SPA edits there must still refresh the block).
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return Boolean(
      node.classList?.contains("kilocean-original-wrap") ||
      node.classList?.contains("kilocean-translation") ||
      node.classList?.contains("kilocean-translation--after") ||
      node.classList?.contains("kilocean-translation--flow") ||
      node.hasAttribute?.("data-deepseek-translator-ui")
    );
  }

  function isReparentIntoOriginalWrap(node) {
    // After we wrap a text node, MutationObserver removedNodes still point at the
    // text whose new parent is our wrap — treat that as extension-owned reparent.
    return Boolean(node?.parentElement?.classList?.contains("kilocean-original-wrap"));
  }

  function isIgnoredTranslatorMutation(node) {
    if (isExtensionOwnedNode(node)) {
      return true;
    }
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) {
      // Detached text/comment after a page-owned removal has no parentElement.
      // Do not treat as extension UI — caller refreshes via record.target.
      return false;
    }
    const ui = el.closest?.("[data-deepseek-translator-ui]");
    if (!ui) {
      return false;
    }
    // Original wrap holds live page content; never ignore those mutations as UI chrome.
    return !isInsideOriginalWrap(el) && !ui.classList?.contains("kilocean-original-wrap");
  }

  function findRefreshHostForMutation(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) {
      return null;
    }
    const host = el.closest?.("[data-kilocean-block]");
    if (!host || !blockRecords.has(host)) {
      return null;
    }
    // Ignore mutations that only touch the translation companion.
    const ui = el.closest?.("[data-deepseek-translator-ui]");
    if (ui && (ui.classList?.contains("kilocean-translation") || ui.classList?.contains("kilocean-translation--after"))) {
      return null;
    }
    if (ui && !isInsideOriginalWrap(el) && !ui.classList?.contains("kilocean-original-wrap") && ui !== host) {
      return null;
    }
    return host;
  }

  function startObserving() {
    stopObserving();
    mutationObserver = new MutationObserver((records) => {
      if (!state.active) {
        return;
      }
      // Only skip while we are mid-write. Do not blank whole batches for a
      // post-write suppress window — filter extension-owned records below so
      // page-owned updates still reach pendingRoots / pendingRefreshBlocks.
      if (applyingDom) {
        return;
      }

      for (const record of records) {
        if (record.type === "childList") {
          if (record.removedNodes.length > 0) {
            pruneDetachedBlockRecords();
            // Removal-only SPA updates never appear in addedNodes — refresh via target.
            const removedOnlyUi = [...record.removedNodes].every((node) =>
              isIgnoredTranslatorMutation(node) || isReparentIntoOriginalWrap(node)
            );
            if (!removedOnlyUi) {
              const refreshHost = findRefreshHostForMutation(record.target);
              if (refreshHost) {
                pendingRefreshBlocks.add(refreshHost);
              }
            }
          }
          record.addedNodes.forEach((node) => {
            if (isIgnoredTranslatorMutation(node)) {
              return;
            }
            const refreshHost = findRefreshHostForMutation(node);
            if (refreshHost) {
              pendingRefreshBlocks.add(refreshHost);
              return;
            }
            pendingRoots.add(node);
          });
          continue;
        }

        if (record.type === "characterData") {
          const node = record.target;
          const refreshHost = findRefreshHostForMutation(node);
          if (refreshHost) {
            pendingRefreshBlocks.add(refreshHost);
            continue;
          }
          if (isIgnoredTranslatorMutation(node)) {
            continue;
          }
          pendingRoots.add(node);
        }
      }

      scheduleDynamicTranslation();
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function stopObserving() {
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
      dynamicTimer = null;
    }
  }

  function scheduleDynamicTranslation() {
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
    }
    dynamicTimer = setTimeout(() => {
      dynamicTimer = null;
      pruneDetachedBlockRecords();

      for (const block of pendingRefreshBlocks) {
        const record = blockRecords.get(block);
        if (record) {
          teardownBlockRecord(record);
          blockRecords.delete(block);
          if (state.translated > 0) {
            state.translated -= 1;
          }
        }
        if (block?.isConnected) {
          pendingRoots.add(block);
        }
      }
      pendingRefreshBlocks.clear();

      const roots = [...pendingRoots];
      pendingRoots.clear();
      const blocks = roots.flatMap((root) => collectBlocks(root));
      const runId = generation;
      workQueue = workQueue.then(() => translateBlocks(blocks, runId, true));
    }, 450);
  }

  function getPublicStatus() {
    return {
      active: state.active,
      phase: state.phase,
      translated: state.translated,
      total: state.total,
      failed: state.failed,
      error: state.error,
      targetLanguage: state.targetLanguage,
      displayMode: state.displayMode
    };
  }

  function assertExportReady() {
    if (!state.active || state.translated === 0) {
      throw new Error("请先完成当前网页的翻译");
    }
    if (state.phase === "translating") {
      throw new Error("翻译仍在进行，请完成后再导出");
    }
  }

  function downloadHtmlSnapshot() {
    assertExportReady();

    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(
      "script, iframe, object, embed, #deepseek-translator-toast-host, #kilocean-selection-host"
    ).forEach((element) => element.remove());
    // Keep #kilocean-translator-style so exported HTML honors data-kilocean-display.
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i], base').forEach((element) => element.remove());

    for (const element of clone.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
    const charset = document.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    const base = document.createElement("base");
    base.setAttribute("href", document.baseURI || location.href);
    const generator = document.createElement("meta");
    generator.setAttribute("name", "generator");
    generator.setAttribute("content", "千浩翻译 · Kilocean Translate 1.3.0");
    const source = document.createElement("meta");
    source.setAttribute("name", "deepseek-translator-source");
    source.setAttribute("content", location.href);
    head.prepend(charset, base, generator, source);

    const exportedAt = new Date();
    const exportComment = document.createComment(
      ` Translated snapshot exported from ${location.href} at ${exportedAt.toISOString()} `
    );
    clone.insertBefore(exportComment, clone.firstChild);

    const html = `<!doctype html>\n${clone.outerHTML}`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const filename = Utils.buildExportFilename(document.title, state.targetLanguage, exportedAt);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    showToast("翻译页面 HTML 已保存", "success");
    return filename;
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    const host = document.getElementById("deepseek-translator-toast-host");
    if (!host?.shadowRoot) {
      return;
    }
    const toast = host.shadowRoot.querySelector(".toast");
    toast?.classList.remove("visible");
  }

  function showToast(message, tone, duration = 2600) {
    let host = document.getElementById("deepseek-translator-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "deepseek-translator-toast-host";
      host.dataset.deepseekTranslatorUi = "true";
      Object.assign(host.style, {
        all: "initial",
        position: "fixed",
        right: "22px",
        bottom: "22px",
        zIndex: "2147483647"
      });
      document.documentElement.appendChild(host);

      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .toast {
            display: flex;
            align-items: center;
            gap: 9px;
            max-width: 320px;
            padding: 11px 14px;
            color: #f6f8ff;
            background: rgba(16, 22, 38, 0.94);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 12px;
            box-shadow: 0 12px 34px rgba(0, 0, 0, 0.28);
            font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            opacity: 0;
            transform: translateY(8px);
            transition: opacity 160ms ease, transform 160ms ease;
          }
          .toast.visible { opacity: 1; transform: translateY(0); }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #6c8cff; flex: 0 0 auto; }
          .loading .dot { animation: pulse 1s ease infinite; }
          .success .dot { background: #42d392; }
          .warning .dot { background: #f8b84e; }
          .error .dot { background: #ff6b78; }
          @keyframes pulse { 50% { opacity: .35; transform: scale(.8); } }
        </style>
        <div class="toast"><span class="dot"></span><span class="message"></span></div>
      `;
    }

    const toast = host.shadowRoot.querySelector(".toast");
    toast.className = `toast ${tone}`;
    host.shadowRoot.querySelector(".message").textContent = message;
    requestAnimationFrame(() => toast.classList.add("visible"));

    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    if (tone !== "loading") {
      toastTimer = setTimeout(() => toast.classList.remove("visible"), duration);
    }
  }

  function setupSelectionTranslate() {
    document.addEventListener("mouseup", onSelectionMaybeTranslate, true);
    document.addEventListener("keyup", (event) => {
      if (event.key === "Escape") {
        hideSelectionPanel();
        return;
      }
      if (event.key === "Shift" || event.key.startsWith("Arrow")) {
        onSelectionMaybeTranslate(event);
      }
    }, true);
    document.addEventListener("mousedown", (event) => {
      const host = document.getElementById("kilocean-selection-host");
      if (host && event.target !== host && !host.contains(event.target)) {
        hideSelectionPanel();
      }
    }, true);
  }

  function onSelectionMaybeTranslate(event) {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
    }
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      handleSelectionTranslate(event);
    }, 180);
  }

  function isSelectionInsideTranslatorUi(selection, event) {
    const host = document.getElementById("kilocean-selection-host");
    if (host) {
      // closest() does not cross shadow roots; ignore events/selection inside the panel.
      if (event?.target?.getRootNode?.() === host.shadowRoot) {
        return true;
      }
      if (host.shadowRoot) {
        const anchorRoot = selection.anchorNode?.getRootNode?.();
        const focusRoot = selection.focusNode?.getRootNode?.();
        if (anchorRoot === host.shadowRoot || focusRoot === host.shadowRoot) {
          return true;
        }
      }
      if (
        (selection.anchorNode && host.contains(selection.anchorNode)) ||
        (selection.focusNode && host.contains(selection.focusNode))
      ) {
        return true;
      }
    }

    for (const node of [selection.anchorNode, selection.focusNode]) {
      const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (el?.closest?.("[data-deepseek-translator-ui], #kilocean-selection-host")) {
        return true;
      }
    }
    return false;
  }

  async function handleSelectionTranslate(event) {
    // Ignore synthetic page-script events that could burn the user's API key.
    if (event && event.isTrusted === false) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideSelectionPanel();
      return;
    }

    const text = selection.toString().replace(/\s+/gu, " ").trim();
    if (text.length < 2 || text.length > 5000) {
      // Invalidate before rejecting so a prior in-flight response cannot reopen the panel.
      hideSelectionPanel();
      return;
    }

    if (isSelectionInsideTranslatorUi(selection, event)) {
      return;
    }

    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return;
    }

    // Bump generation so a newer selection or dismiss invalidates in-flight work.
    selectionGeneration += 1;
    const requestId = selectionGeneration;

    try {
      const stored = await chrome.storage.local.get({
        targetLanguage: state.targetLanguage,
        model: state.model,
        apiKey: ""
      });

      if (requestId !== selectionGeneration) {
        return;
      }

      // Keep selection target/model local — never clobber pinned page-run state.
      const targetLanguage = stored.targetLanguage || state.targetLanguage;
      const model = stored.model || state.model;

      if (!Utils.isTranslatableText(text, targetLanguage)) {
        hideSelectionPanel();
        return;
      }

      const panel = ensureSelectionPanel();
      positionSelectionPanel(panel, rect);
      setSelectionPanelState(panel, "loading", "正在翻译选中文本…");

      if (!String(stored.apiKey || "").trim()) {
        setSelectionPanelState(panel, "error", "请先在扩展弹窗中填写 API Key");
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: [text],
        targetLanguage,
        model
      });

      if (requestId !== selectionGeneration) {
        return;
      }

      if (!response?.ok) {
        throw new Error(response?.error || "翻译失败");
      }

      const translation = String(response.translations?.[0] || "").trim();
      if (!translation) {
        throw new Error("未返回译文");
      }

      setSelectionPanelState(panel, "success", translation, text);
    } catch (error) {
      if (requestId !== selectionGeneration) {
        return;
      }
      const panel = ensureSelectionPanel();
      setSelectionPanelState(panel, "error", error.message || "翻译失败");
    }
  }

  function ensureSelectionPanel() {
    let host = document.getElementById("kilocean-selection-host");
    if (host?.shadowRoot) {
      host.hidden = false;
      return host;
    }

    host = document.createElement("div");
    host.id = "kilocean-selection-host";
    host.dataset.deepseekTranslatorUi = "true";
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483646",
      top: "0px",
      left: "0px"
    });
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .panel {
          width: min(360px, calc(100vw - 24px));
          padding: 12px 12px 10px;
          color: #f5f7ff;
          background: rgba(14, 18, 30, 0.96);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32);
          font: 500 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .label {
          color: #91a4ff;
          font-size: 11px;
        }
        .close {
          border: 0;
          background: transparent;
          color: #aab0c1;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          padding: 2px 4px;
        }
        .body {
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 220px;
          overflow: auto;
        }
        .body.loading { color: #9299ae; }
        .body.error { color: #ff8b96; }
        .source {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          color: #7f879b;
          font-size: 11px;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 72px;
          overflow: auto;
        }
        .source[hidden] { display: none; }
      </style>
      <div class="panel" role="dialog" aria-label="选中翻译">
        <div class="top">
          <span class="label">千浩翻译 · 划词</span>
          <button class="close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="body loading">正在翻译选中文本…</div>
        <div class="source" hidden></div>
      </div>
    `;

    shadow.querySelector(".close").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideSelectionPanel();
    });

    return host;
  }

  function positionSelectionPanel(host, rect) {
    const margin = 12;
    const panelWidth = Math.min(360, window.innerWidth - 24);
    const left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - panelWidth - margin
    );
    const estimatedHeight = 140;
    const below = rect.bottom + 10;
    const top = below + estimatedHeight > window.innerHeight
      ? Math.max(margin, rect.top - 10 - estimatedHeight)
      : below;

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function setSelectionPanelState(host, tone, message, sourceText) {
    const body = host.shadowRoot.querySelector(".body");
    const source = host.shadowRoot.querySelector(".source");
    body.className = `body ${tone}`;
    body.textContent = message;
    if (tone === "success" && sourceText) {
      source.hidden = false;
      source.textContent = sourceText;
    } else {
      source.hidden = true;
      source.textContent = "";
    }
    host.hidden = false;
  }

  function hideSelectionPanel() {
    // Invalidate any in-flight TRANSLATE_BATCH so a late response cannot reopen the panel.
    selectionGeneration += 1;
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    const host = document.getElementById("kilocean-selection-host");
    if (host) {
      host.hidden = true;
    }
  }
})();
