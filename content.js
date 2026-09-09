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

  /** @type {Map<Element, {block: Element, originalText: string, translation: string, wrap: HTMLElement|null, companion: HTMLElement, layout: string}>} */
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
  /** Ignore MutationObserver callbacks until this timestamp (ms since epoch). */
  let suppressMutationsUntil = 0;
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

    if (state.active && state.targetLanguage === targetLanguage && state.phase === "translating") {
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
    // Short suppress window covers async MutationObserver delivery after wrap.
    suppressMutationsUntil = Date.now() + 120;
  }

  function shouldSuppressObserver() {
    if (applyingDom) {
      return true;
    }
    if (Date.now() < suppressMutationsUntil) {
      try {
        mutationObserver?.takeRecords();
      } catch {
        // ignore
      }
      return true;
    }
    return false;
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
      // Companion layout may create multiple owned-text wraps — unwrap all of them.
      const wraps = [];
      if (wrap) {
        wraps.push(wrap);
      }
      if (block) {
        for (const extra of block.querySelectorAll(":scope > .kilocean-original-wrap")) {
          if (!wraps.includes(extra)) {
            wraps.push(extra);
          }
        }
      }
      for (const owned of wraps) {
        if (owned.parentNode !== block) {
          continue;
        }
        while (owned.firstChild) {
          block.insertBefore(owned.firstChild, owned);
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
    const deepest = blocks.filter(
      (block) => !blocks.some((other) => other !== block && block.contains(other))
    );
    const deepestSet = new Set(deepest);
    const withOwnText = [];
    for (const block of blocks) {
      if (deepestSet.has(block)) {
        continue;
      }
      const nested = deepest.filter((other) => block.contains(other));
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
      if (/\s/u.test(between)) {
        return "";
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

    const segments = [];
    for (const block of candidates) {
      const nested = candidates.filter((other) => other !== block && block.contains(other));
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

  async function translateBatchWithFallback(batch, runId, runSettings = getRunSettings()) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: batch.map((segment) => segment.text),
        targetLanguage: runSettings.targetLanguage,
        model: runSettings.model
      });

      if (!response?.ok) {
        const error = new Error(response?.error || "翻译请求失败");
        error.canSplit = Boolean(response?.canSplit);
        throw error;
      }

      if (runId !== generation) {
        return;
      }

      response.translations.forEach((translation, index) => {
        const segment = batch[index];
        if (!segment.block.isConnected || blockRecords.has(segment.block)) {
          return;
        }

        const currentText = extractBlockText(segment.block, segment.nested || []);
        if (currentText !== segment.text) {
          return;
        }

        const rendered = String(translation || "").trim();
        if (!rendered) {
          return;
        }

        applyBlockTranslation(segment.block, segment.text, rendered, {
          companionOnly: Boolean(segment.companionOnly),
          nested: segment.nested || []
        });
        state.translated += 1;
      });
    } catch (error) {
      if (error.canSplit && batch.length > 1 && runId === generation) {
        const middle = Math.ceil(batch.length / 2);
        await translateBatchWithFallback(batch.slice(0, middle), runId, runSettings);
        await translateBatchWithFallback(batch.slice(middle), runId, runSettings);
        return;
      }

      state.failed += batch.length;
      state.error = error.message;
    }
  }

  function wrapOwnedContentForCompanion(block, nestedBlocks, wrapTag) {
    const nestedSet = new Set(nestedBlocks || []);
    const children = [...block.childNodes];
    let pending = [];
    let firstWrap = null;

    const flush = () => {
      if (pending.length === 0) {
        return;
      }
      const hasSubstance = pending.some((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return /\S/u.test(node.data || "");
        }
        return node.nodeType === Node.ELEMENT_NODE;
      });
      if (!hasSubstance) {
        pending = [];
        return;
      }
      const wrap = document.createElement(wrapTag);
      wrap.className = "kilocean-original-wrap";
      // Not UI-marked: SPA edits to owned original text must still refresh.
      block.insertBefore(wrap, pending[0]);
      for (const node of pending) {
        wrap.appendChild(node);
      }
      if (!firstWrap) {
        firstWrap = wrap;
      }
      pending = [];
    };

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (
          child.classList?.contains("kilocean-translation") ||
          child.classList?.contains("kilocean-translation--flow") ||
          child.classList?.contains("kilocean-original-wrap")
        ) {
          flush();
          continue;
        }
        const isNestedRoot = nestedSet.has(child);
        const containsNested = [...nestedSet].some((nested) => child.contains(nested));
        if (isNestedRoot || containsNested) {
          flush();
          continue;
        }
      }
      pending.push(child);
    }
    flush();
    return firstWrap;
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
      if (options.companionOnly && placement !== "after-host") {
        placement = "companion";
      }
      let wrap = null;
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
        // Nested ancestor with own text: wrap owned text so translation-only can hide
        // it, without hiding nested block subtrees (unlike flex/grid flow).
        wrap = wrapOwnedContentForCompanion(block, options.nested || [], wrapTag);
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
        wrap = document.createElement(wrapTag);
        wrap.className = "kilocean-original-wrap";
        // Intentionally NOT marked as translator UI: SPA mutations to original content
        // must still refresh this block (companion stays UI-marked).
        while (block.firstChild) {
          wrap.appendChild(block.firstChild);
        }
        block.appendChild(wrap);
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
      html[data-kilocean-display="bilingual"] [data-kilocean-block] > .kilocean-original-wrap {
        display: contents;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] > .kilocean-translation {
        display: block;
        opacity: 0.96;
      }
      html[data-kilocean-display="bilingual"] .kilocean-translation--after {
        opacity: 0.96;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block] > .kilocean-original-wrap {
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
      html[data-kilocean-display="original"] [data-kilocean-block] > .kilocean-original-wrap {
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

  function isIgnoredTranslatorMutation(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) {
      return true;
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
      if (!state.active || shouldSuppressObserver()) {
        return;
      }

      for (const record of records) {
        if (record.type === "childList") {
          if (record.removedNodes.length > 0) {
            pruneDetachedBlockRecords();
            // Removal-only SPA updates never appear in addedNodes — refresh via target.
            const removedOnlyUi = [...record.removedNodes].every((node) =>
              isIgnoredTranslatorMutation(node)
            );
            if (!removedOnlyUi) {
              const refreshHost = findRefreshHostForMutation(record.target);
              if (refreshHost) {
                pendingRefreshBlocks.add(refreshHost);
              }
            }
          }
          record.addedNodes.forEach((node) => {
            const refreshHost = findRefreshHostForMutation(node);
            if (refreshHost) {
              pendingRefreshBlocks.add(refreshHost);
              return;
            }
            if (isIgnoredTranslatorMutation(node)) {
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

      const targetLanguage = stored.targetLanguage || state.targetLanguage;
      const model = stored.model || state.model;
      state.targetLanguage = targetLanguage;
      state.model = model;

      if (!Utils.isTranslatableText(text, targetLanguage)) {
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
    const host = document.getElementById("kilocean-selection-host");
    if (host) {
      host.hidden = true;
    }
  }
})();
