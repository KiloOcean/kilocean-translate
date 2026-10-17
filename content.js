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
  // Mutation roots that can never yield translatable text — never queued, so
  // script/style/template churn cannot pin the dynamic phase busy.
  const NON_CONTENT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE",
    "FIGCAPTION", "DT", "DD", "SUMMARY", "CAPTION", "TD", "TH",
    "ARTICLE", "SECTION", "HEADER", "FOOTER", "ASIDE", "MAIN"
  ]);
  // Nested interactive labels must stay visible/usable in translation-only mode.
  const INTERACTIVE_TAGS = new Set([
    "A", "BUTTON", "SUMMARY", "LABEL", "SELECT", "OPTION", "TEXTAREA", "INPUT"
  ]);
  // Selection-path-only rate limit (full-page runs are unaffected): every
  // TRANSLATE_BATCH send spends the user's API key, so a page that turns each
  // real gesture into a request must not drain it in a tight loop.
  const SELECTION_SEND_MIN_INTERVAL_MS = 1000;
  const SELECTION_SEND_WINDOW_MS = 10000;
  const SELECTION_SEND_WINDOW_LIMIT = 8;
  // A >5000-char segment split into halves came back with an empty/blank half:
  // that segment FAILED (never silently skipped) — surfaced via state.error,
  // the progress pill and the in-place failed marker.
  const SPLIT_EMPTY_RESULT_MESSAGE = "长段落分段翻译返回空结果";
  // On X hosts the page is mostly untranslated UI chrome (sidebar, trends,
  // follow rows, footer); only tweet bodies and profile bios get translated.
  // Generic sites keep the full-page behavior.
  const IS_X_HOST = Utils.isXHost(location.hostname);

  /** @type {Map<Element, {block: Element, originalText: string, translation: string, wrap: HTMLElement|null, wraps: HTMLElement[], companion: HTMLElement, layout: string, nested: Element[]}>} */
  const blockRecords = new Map();
  const pendingRoots = new Set();
  const pendingRefreshBlocks = new Set();
  // Extension-created original wraps. The data-kilocean-original-wrap
  // attribute alone is page-settable — any site can plant it on its own
  // hidden span and step our hidden-content walk over it — so ownership is
  // recorded here at creation time and only members of this set count as
  // ours (hasHiddenAncestor bypass, refresh triggers, mutation ownership).
  const ownedOriginalWraps = new WeakSet();
  /** Blocks holding a failure slot in state.failed — a retry replaces the slot. */
  const failedBlocks = new Set();
  // In-place failure markers we own (owned element per failed block; tracked
  // like ownedOriginalWraps so page-planted data-kilocean-failed-marker nodes
  // never count as ours). WeakMap: entries die with their block.
  const failedMarkers = new WeakMap();

  let mutationObserver = null;
  let dynamicTimer = null;
  let workQueue = Promise.resolve();
  let generation = 0;
  let toastTimer = null;
  /** Progress pill host + closed shadow ref (page can never reach inside). */
  let progressPillHost = null;
  let progressPillShadow = null;
  /** Last rendered pill signature (phase/counts/mode) — re-render only on change. */
  let progressPillSignature = "";
  let pillCollapseTimer = null;
  let pillCollapsed = false;
  let selectionTimer = null;
  let selectionGeneration = 0;
  /** Last selection translate key (target\0model\0text\0range) to avoid rebill on Shift release. */
  let lastSelectionKey = "";
  /** Gesture snapshot previewed in the panel; billed only by the extension popup's confirm. */
  let pendingSelectionGesture = null;
  /** @type {string} text\0rangeIdentity of the selection last scheduled for translate. */
  let lastScheduledSelectionSnapshot = "";
  /** Send times of recent selection-path TRANSLATE_BATCHs (rate limiting). */
  const selectionSendTimes = [];
  let nextSelectionNodeId = 1;
  const selectionNodeIds = new WeakMap();
  let styleHost = null;
  /** Owned selection panel host — pages may duplicate the id, so keep the ref. */
  let selectionHostEl = null;
  let applyingDom = false;
  let applyingDomGeneration = 0;
  /** @type {{ provider: string, targetLanguage: string, model: string } | null} */
  let activeRunSettings = null;
  /** @type {{ provider?: string, targetLanguage?: string, model?: string } | null} */
  let deferredRunSettings = null;
  /** Last seen URL for same-document SPA navigation detection. */
  let lastSeenUrl = location.href;
  /**
   * Blocks whose source the provider already echoed back unchanged under the
   * current run settings — re-requesting them would only re-bill. Keyed by
   * block element, invalidated by comparing text + run settings on read.
   * @type {WeakMap<Element, { text: string, provider: string, targetLanguage: string, model: string }>}
   */
  const skippedEchoBlocks = new WeakMap();
  // Bounded LRU of source→translation under the current run settings:
  // virtualized lists remount tweets with identical text, and re-requesting
  // the same source would only re-bill the provider. Keyed by text + provider
  // + target + model so any run-setting change misses; displayMode only
  // picks how an entry is rendered, never its content, so toggling it keeps
  // hitting the same cache. Cleared when the session ends (restoreOriginal).
  const TRANSLATION_CACHE_LIMIT = 500;
  /** @type {Map<string, string>} */
  const translationCache = new Map();
  // In-flight TRANSLATE_BATCH slot accounting, shared across ALL run
  // generations: a generation bump abandons the old run's queue, but its
  // provider requests (and worker-side retries) stay on the wire and stay
  // billed, so the cap must survive SPA navigation / restore / restart and
  // is never reset to zero by them.
  let inflightTranslateBatches = 0;
  const inflightTranslateWaiters = [];

  const state = {
    active: false,
    phase: "idle",
    translated: 0,
    total: 0,
    failed: 0,
    error: "",
    provider: "deepseek",
    targetLanguage: "zh-CN",
    model: "deepseek-flash",
    displayMode: Utils.DISPLAY_MODES.bilingual
  };

  ensureTranslatorStyles();
  applyDocumentDisplayMode(state.displayMode);
  setupSelectionTranslate();
  setupSpaNavigationWatch();

  chrome.storage.local.get({
    displayMode: Utils.DISPLAY_MODES.bilingual,
    provider: state.provider,
    targetLanguage: state.targetLanguage,
    model: state.model
  }, (stored) => {
    state.displayMode = Utils.normalizeDisplayMode(stored.displayMode);
    if (stored.provider === "kimi" || stored.provider === "deepseek") {
      state.provider = stored.provider;
    }
    if (stored.targetLanguage) {
      state.targetLanguage = stored.targetLanguage;
    }
    if (stored.model) {
      // Map legacy deepseek-v4-flash → deepseek-flash on read; background's
      // loadSettings persists the rename.
      state.model = Utils.migrateModelName(stored.model);
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
      updateProgressPill();
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
          model: Utils.migrateModelName(changes.model.newValue)
        };
      } else {
        state.model = Utils.migrateModelName(changes.model.newValue);
      }
    }
    if (changes.provider?.newValue) {
      const nextProvider = changes.provider.newValue === "kimi" ? "kimi" : "deepseek";
      if (state.active) {
        deferredRunSettings = {
          ...(deferredRunSettings || {}),
          provider: nextProvider
        };
      } else {
        state.provider = nextProvider;
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
      setDisplayModePreference(message.displayMode);
      sendResponse({ ok: true, status: getPublicStatus() });
      return false;
    }

    if (message?.type === "COMMAND_SELECTION_TRANSLATE") {
      // Trusted billing trigger: runtime messages cannot be forged by page
      // script, and this one originates from the browser Alt+T command /
      // context-menu item (relayed by our background). The Alt+T / popup
      // gesture itself is the billing consent — same model as CONFIRM below.
      // Capture the LIVE selection synchronously: page script must never get
      // a window to swap it in during any await.
      const gesture = captureSelectionGesture();
      if (!gesture) {
        // Nothing selected here (or the selection lives in a frame we cannot
        // read — message.selectionText is then stale/unverifiable text the
        // user cannot see, so it is never billed): non-billable hint state.
        // A selection INSIDE a textarea / text-like input is a special case
        // (PR #19 follow-up): the user did select text, but input-field text
        // is not page content this extension can annotate — say so instead
        // of the generic 先选中 hint. Still never billed.
        const inputSelection = activeElementHasTextSelection();
        showSelectionHintPanel(
          inputSelection ? "暂不支持翻译输入框内的文字" : "先选中要翻译的文字，再按 Alt+T 或右键「翻译选中文字」"
        );
        sendResponse({
          ok: false,
          error: inputSelection
            ? "暂不支持翻译输入框内的文字"
            : "先选中要翻译的文字，再按 Alt+T 或右键「翻译选中文字」"
        });
        return false;
      }
      // The live selection wins over message.selectionText: the context-menu
      // text can be stale, while the live selection is what the user sees.
      // sendSelectionTranslation revalidates it, runs the key gate + rate
      // limit, and drives the bubble loading/result/error states.
      sendSelectionTranslation(gesture)
        .then((result) => sendResponse(result?.ok === false
          ? { ok: false, error: result.error || "划词翻译失败" }
          : { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "RETRY_FAILED") {
      // Retry ONLY the currently failed blocks — never restoreOriginal, never
      // a full re-run (that would re-bill finished segments).
      retryFailedBlocks()
        .then(() => sendResponse({ ok: true, status: getPublicStatus() }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "CONFIRM_SELECTION_TRANSLATE") {
      // Billable consent arrives only from the extension popup (page-inaccessible UI).
      const text = String(message.text || "").trim();
      const rangeId = String(message.rangeId || "");
      const gesture = pendingSelectionGesture;
      if (
        !gesture ||
        !text ||
        !rangeId ||
        gesture.text !== text ||
        gesture.rangeId !== rangeId
      ) {
        lastSelectionKey = "";
        hideSelectionPanel();
        sendResponse({ ok: false, error: "没有待确认的划词翻译" });
        return false;
      }
      pendingSelectionGesture = null;
      sendSelectionTranslation(gesture)
        .then((result) => sendResponse(result?.ok === false
          ? { ok: false, error: result.error || "划词翻译失败" }
          : { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "DISMISS_SELECTION") {
      hideSelectionPanel();
      sendResponse({ ok: true });
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
          // Live print includes fixed overlays; HTML export already strips our hosts.
          // Failure markers must hide too — otherwise the red “这段没翻译成功”
          // banner and its Retry control land in the printed page / PDF.
          hideSelectionPanel();
          hideToast();
          const pillHost = progressPillHost;
          if (pillHost) {
            pillHost.style.display = "none";
          }
          const markerHosts = [...document.querySelectorAll("[data-kilocean-failed-marker]")];
          for (const host of markerHosts) {
            host.style.display = "none";
          }
          window.print();
          if (pillHost) {
            pillHost.style.display = "";
          }
          for (const host of markerHosts) {
            host.style.display = "";
          }
        }, 80);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }

    return false;
  });

  async function startTranslation(options) {
    const provider = options.provider === "kimi" ? "kimi" : "deepseek";
    const targetLanguage = options.targetLanguage || "zh-CN";
    const model = Utils.migrateModelName(options.model) || "deepseek-flash";
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
      state.provider === provider &&
      state.targetLanguage === targetLanguage &&
      state.model === model &&
      state.phase === "translating"
    ) {
      return;
    }

    if (blockRecords.size > 0) {
      restoreOriginal({ silent: true });
    }

    const abandonedRunId = generation;
    generation += 1;
    const runId = generation;
    // Detach from the cancelled run's queue tail: its in-flight network results
    // are already invalidated by the bump, so this run must not wait on them.
    // The stale chain keeps its own catch, so its late settle cannot reject here.
    workQueue = Promise.resolve();
    cancelAbandonedRunBatches(abandonedRunId);
    deferredRunSettings = null;
    activeRunSettings = { provider, targetLanguage, model };
    Object.assign(state, {
      active: true,
      phase: "translating",
      translated: 0,
      total: 0,
      failed: 0,
      error: "",
      provider,
      targetLanguage,
      model,
      displayMode
    });
    applyDocumentDisplayMode(displayMode);
    // Sync popup immediately when coercing original→bilingual (before long batches).
    if (coercedFromOriginal) {
      notifyPopupStatus();
    }

    // Fresh run: stale failure markers (and their failedBlocks slots — even
    // when blockRecords is empty because EVERY block failed last time) must
    // not leak into this run's counts.
    clearFailedMarkers();
    failedBlocks.clear();
    startObserving();

    const blocks = collectBlocks(document.body || document.documentElement);
    state.total = blocks.length;
    // Page-run feedback lives in the bottom-right progress pill (real
    // state.translated / state.total), replacing the old static loading toast.
    updateProgressPill();

    if (blocks.length === 0) {
      state.phase = "translated";
      finishRunSettings();
      updateProgressPill();
      showToast("没有发现需要翻译的内容", "info");
      notifyPopupStatus();
      return;
    }

    // Serialize on workQueue so a mid-run dynamic job cannot publish a terminal
    // phase (and enable export) while initial batches are still in flight.
    const initialJob = workQueue.then(() => translateBlocks(blocks, runId, false));
    workQueue = initialJob.catch(() => {});
    await initialJob;
    if (runId !== generation) {
      return;
    }

    // A mutation may have scheduled the 450 ms dynamic debounce during the
    // initial batches. Keep the busy phase until that pending work drains so
    // export cannot accept an incomplete snapshot.
    if (hasPendingDynamicWork()) {
      state.phase = "translating";
      finishRunSettings();
      updateProgressPill();
      notifyPopupStatus();
      return;
    }

    state.phase = state.failed > 0 && state.translated === 0 ? "error" : "translated";
    finishRunSettings();
    // Terminal state shows in the pill (partial/error stay persistent there
    // with their retry/settings exits — no vanishing toast).
    updateProgressPill();
    notifyPopupStatus();
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
      provider: state.provider || "deepseek",
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
    const abandonedRunId = generation;
    generation += 1;
    // Drop the cancelled run's queue tail — a fresh startTranslation chained on
    // the old workQueue would otherwise wait on stale in-flight requests.
    workQueue = Promise.resolve();
    cancelAbandonedRunBatches(abandonedRunId);
    stopObserving();
    activeRunSettings = null;
    deferredRunSettings = null;
    // Pill and in-place failure markers are session UI — both go away here.
    hideProgressPill();
    clearFailedMarkers();
    failedBlocks.clear();
    // Session end: cached translations belong to the translated session, not
    // to the restored page.
    translationCache.clear();

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

  function setupSpaNavigationWatch() {
    // X (and other SPAs) navigate via history.pushState without reloading the
    // document, so this content script stays alive across views. Page script
    // may patch history methods, so polling location.href is the only signal
    // we can trust; popstate/hashchange merely accelerate detection of the
    // navigations that do fire an event. Both are plain window events, safe
    // to hear from the content-script isolated world; pushState itself fires
    // nothing observable without page-script injection, which we never do.
    window.addEventListener("popstate", () => {
      checkSpaNavigation();
    }, true);
    window.addEventListener("hashchange", () => {
      checkSpaNavigation();
    }, true);
    setInterval(checkSpaNavigation, 500);
  }

  // URL identity for SPA navigation ignores the fragment: an in-page anchor
  // jump (#feed → #about) keeps the same document view and must not abort the
  // running translation session as if it were a navigation.
  function spaNavigationUrl(href) {
    const value = String(href || "");
    const hashAt = value.indexOf("#");
    return hashAt === -1 ? value : value.slice(0, hashAt);
  }

  /** @returns {boolean} true when a navigation was detected and handled. */
  function checkSpaNavigation() {
    if (spaNavigationUrl(location.href) === spaNavigationUrl(lastSeenUrl)) {
      return false;
    }
    lastSeenUrl = location.href;
    handleSpaNavigation();
    return true;
  }

  function handleSpaNavigation() {
    if (!state.active) {
      // Fresh documents/tabs start inactive — no auto-translate there. This
      // handler only continues a session the user started in this tab.
      return;
    }
    // Same-tab in-app navigation: abort the old view's in-flight run. Bumping
    // the generation marks every late response stale, so aborted segments are
    // ignored (never counted as failures, never toasted), and detaching the
    // queue tail means the next run cannot wait on the cancelled chain. The
    // session itself survives: still-connected blocks keep their translations
    // and the new view gets translated below, until the user clears/restores.
    const abandonedRunId = generation;
    generation += 1;
    cancelAbandonedRunBatches(abandonedRunId);
    workQueue = Promise.resolve();
    pendingRoots.clear();
    // Keep refresh entries whose blocks survived the view swap (still
    // connected): the scheduled flush re-validates each one against its
    // recorded source text. Only blocks that left the DOM with the old view
    // are dropped here.
    for (const block of pendingRefreshBlocks) {
      if (!block?.isConnected) {
        pendingRefreshBlocks.delete(block);
      }
    }
    clearFailedMarkers();
    failedBlocks.clear();
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
      dynamicTimer = null;
    }
    // Drop records that left the DOM with the old view; route-shared chrome
    // that is still connected keeps its translation — no re-billing.
    pruneDetachedBlockRecords();
    state.translated = blockRecords.size;
    state.total = blockRecords.size;
    state.failed = 0;
    state.error = "";
    state.phase = "translating";
    updateProgressPill();
    notifyPopupStatus();
    // Re-discover once the SPA swap settles; the dynamic path reuses the
    // pinned run settings and every runId race-token check.
    pendingRoots.add(document.body || document.documentElement);
    scheduleDynamicTranslation();
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

  function discardBlockRecord(block) {
    const record = blockRecords.get(block);
    if (!record) {
      return false;
    }
    teardownBlockRecord(record);
    blockRecords.delete(block);
    // Keep total aligned with live records — dynamic re-translate adds total again.
    if (state.translated > 0) {
      state.translated -= 1;
    }
    if (state.total > 0) {
      state.total -= 1;
    }
    return true;
  }

  function pruneDetachedBlockRecords() {
    for (const [block, record] of [...blockRecords.entries()]) {
      if (block.isConnected) {
        continue;
      }
      discardBlockRecord(block);
    }
    // Failed blocks that left the page release their failed/total slots too
    // (and their in-place markers, which usually left with them).
    for (const block of [...failedBlocks]) {
      if (block.isConnected) {
        continue;
      }
      removeFailedMarker(block);
      failedBlocks.delete(block);
      if (state.failed > 0) {
        state.failed -= 1;
      }
      if (state.total > 0) {
        state.total -= 1;
      }
    }
  }

  // Full gate for a candidate block text: translatable shape, not page chrome
  // (@handle / URL / counter / bare date), and not already in the target
  // language (re-translating those duplicates them: "Home Home", "宝玉宝玉").
  function shouldTranslateBlockText(text, targetLanguage, block) {
    if (!Utils.isTranslatableText(text, targetLanguage)) {
      return false;
    }
    if (Utils.isSkippableText(text)) {
      return false;
    }
    if (Utils.isAlreadyTargetLanguage(text, targetLanguage)) {
      return false;
    }
    return !isSkippedEchoBlock(block, text);
  }

  // True when the provider already echoed this exact source back unchanged
  // under the same run settings: re-requesting it would only re-bill for
  // another echo. The cached skip self-invalidates by comparison — a changed
  // source text or a changed provider/target/model run simply stops matching.
  function isSkippedEchoBlock(block, text) {
    if (!block) {
      return false;
    }
    const skipped = skippedEchoBlocks.get(block);
    if (!skipped || skipped.text !== text) {
      return false;
    }
    const runSettings = getRunSettings();
    return skipped.provider === runSettings.provider &&
      skipped.targetLanguage === runSettings.targetLanguage &&
      skipped.model === runSettings.model;
  }

  function translationCacheKey(text, runSettings) {
    return [
      runSettings.provider,
      runSettings.targetLanguage,
      runSettings.model,
      text
    ].join("\u0000");
  }

  function getCachedTranslation(text, runSettings) {
    const key = translationCacheKey(text, runSettings);
    if (!translationCache.has(key)) {
      return null;
    }
    const translation = translationCache.get(key);
    // Refresh recency: Map iterates in insertion order, so delete+set moves
    // the entry to the back (most recently used).
    translationCache.delete(key);
    translationCache.set(key, translation);
    return translation;
  }

  function setCachedTranslation(text, translation, runSettings) {
    if (typeof translation !== "string" || !translation.trim()) {
      return;
    }
    const key = translationCacheKey(text, runSettings);
    translationCache.delete(key);
    translationCache.set(key, translation);
    if (translationCache.size > TRANSLATION_CACHE_LIMIT) {
      const oldestKey = translationCache.keys().next().value;
      translationCache.delete(oldestKey);
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
      // Mark considered before extract/filter so multi-fragment rejected
      // blocks are not re-walked per text node (quadratic discovery).
      seen.add(block);
      const fullText = extractBlockText(block);
      if (!shouldTranslateBlockText(fullText, targetLanguage, block)) {
        continue;
      }
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
      // Exclude every nested candidate when testing ancestor-owned text — a
      // mid-level candidate (not deepest) must not leak into the ancestor's
      // provisional ownText and inflate state.total with an untranslatable block.
      const nested = descendantsOf.get(block) || [];
      if (nested.length === 0) {
        continue;
      }
      const ownText = extractBlockText(block, nested);
      if (shouldTranslateBlockText(ownText, targetLanguage, block)) {
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

  function hasHiddenAncestor(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
      // Our own original wraps sit at display:none in translation-only mode —
      // that is a display preference, not invisible content. Skipping them
      // here would blind extractBlockText during refresh comparison (empty
      // text ≠ recorded original → false "source changed" → re-bill), so the
      // walk steps over them. Page-owned hidden ancestors still count, and
      // discovery stays safe because recorded blocks are excluded earlier.
      if (isOwnedOriginalWrap(cur)) {
        continue;
      }
      if (isHiddenElement(cur)) {
        return true;
      }
    }
    return false;
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

  // Text living outside any scope we translate: <time> timestamps and, on X,
  // anything outside tweetText / UserDescription (usernames, handles, counts,
  // nav chrome). Covers both discovery (isEligibleTextHost) and extraction
  // (collectRawTextNodes) so neither path can pick it up.
  function isNonTranslatableScope(parent) {
    if (!parent) {
      return true;
    }
    // <time> holds timestamps ("Oct 12", "2h"); translating them glues
    // duplicates like "Oct 1210月12日".
    if (parent.closest("time")) {
      return true;
    }
    return IS_X_HOST && !parent.closest(Utils.X_TRANSLATABLE_SELECTOR);
  }

  function isEligibleTextHost(parent) {
    if (!parent) {
      return false;
    }
    if (BLOCKED_TAGS.has(parent.tagName)) {
      return false;
    }
    if (parent.closest('[translate="no"], [contenteditable="true"], [data-deepseek-translator-ui]')) {
      return false;
    }
    if (isNonTranslatableScope(parent)) {
      return false;
    }
    return !hasHiddenAncestor(parent);
  }

  // Mutation-queueing counterpart of isNonTranslatableScope for X: a
  // page-owned mutation root is worth scheduling only when it lives inside
  // tweetText / UserDescription, or carries one in its subtree (a freshly
  // inserted timeline article nests tweetText several levels down).
  // Everything else — sidebar, counters, nav chrome — can never yield an
  // eligible block, and queueing it would endlessly reset the 450 ms
  // debounce and pin state.phase at "translating" while export stays locked.
  function isInXTranslatableMutationScope(node) {
    if (!IS_X_HOST) {
      return true;
    }
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el?.isConnected) {
      return false;
    }
    return (
      el.closest(Utils.X_TRANSLATABLE_SELECTOR) != null ||
      el.querySelector(Utils.X_TRANSLATABLE_SELECTOR) != null
    );
  }

  function shouldTranslateTextNode(node) {
    if (!node?.parentElement) {
      return false;
    }
    if (!isEligibleTextHost(node.parentElement)) {
      return false;
    }
    // Skip only when the nearest block ancestor still has a live record.
    // A torn-down nested block under a recorded ancestor must stay collectible
    // (closest("[data-kilocean-block]") alone would permanently exclude it).
    const block = getBlockAncestor(node);
    if (block && blockRecords.has(block)) {
      return false;
    }
    // Discover any non-empty visible fragment here; isTranslatableText applies
    // only to aggregated block text in collectBlocks (letter-per-span headings).
    return Boolean(node.data?.trim());
  }

  function collectRawTextNodes(root) {
    if (!root || !root.isConnected) {
      return [];
    }

    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      if (!parent || BLOCKED_TAGS.has(parent.tagName) || isTranslatorUiElement(parent) || hasHiddenAncestor(parent) || isNonTranslatableScope(parent)) {
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
        if (!parent || BLOCKED_TAGS.has(parent.tagName) || isTranslatorUiElement(parent) || hasHiddenAncestor(parent) || isNonTranslatableScope(parent)) {
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
      // On X, the tweetText / UserDescription container is always the block so
      // the translation can land as its block-level sibling — never inline in
      // the flex header / username rows that wrap tweet bodies.
      if (IS_X_HOST && el.matches(Utils.X_TRANSLATABLE_SELECTOR)) {
        return el;
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
      // Trim horizontal space around newlines only — do not collapse \n\n to \n.
      .replace(/[^\S\n]*\n[^\S\n]*/gu, "\n")
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

    // Only insert a separator when the cloned range has whitespace or a visual
    // block break. Distinct inline parents with no intervening whitespace
    // (<span>foo</span><strong>bar</strong>) must stay adjacent.
    return "";
  }

  async function translateBlocks(blocks, runId, isDynamic, options = {}) {
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
      if (!shouldTranslateBlockText(text, runSettings.targetLanguage, block)) {
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
      // Dynamic schedule may have marked translating before discovery found work.
      if (isDynamic && runId === generation) {
        finalizeDynamicPhase();
      }
      return;
    }

    if (isDynamic) {
      state.phase = "translating";
      // Blocks already holding a failure slot keep their total slot — a retry
      // of the same block must not be counted in total a second time.
      let newTotalSlots = 0;
      for (const segment of segments) {
        if (!failedBlocks.has(segment.block)) {
          newTotalSlots += 1;
        }
      }
      state.total += newTotalSlots;
      showToast(options.retry ? "正在重试未完成的段落…" : "正在翻译新加载的内容…", "loading");
      updateProgressPill();
    }

    // Visible-area-first for the INITIAL run: viewport blocks land in the
    // first batches so the user watching the page sees progress immediately,
    // then the next screen below, then the rest. Dynamic follow-ups and
    // failed-block retries keep discovery (DOM) order. One rect read per
    // block, inside orderSegmentsByViewport.
    const orderedSegments = isDynamic
      ? segments
      : Utils.orderSegmentsByViewport(
        segments,
        // Items are segments ({ block, text, ... }), not elements.
        (segment) => segment.block.getBoundingClientRect(),
        window.innerHeight
      );

    const batches = Utils.chunkSegments(orderedSegments, 5000, 24);

    // Concurrency cap: at most Utils.MAX_INFLIGHT_TRANSLATE_BATCHES batches
    // may be in flight. The sequential loop below (one await per batch) keeps
    // a run at 1, safely under the cap — never parallelize past it or the
    // provider starts answering with 429s.
    for (const batch of batches) {
      if (runId !== generation) {
        return;
      }
      await translateBatchWithFallback(batch, runId, runSettings);
      updateProgressPill();
    }

    if (isDynamic && runId === generation) {
      // Newer dynamic work scheduled while these batches were in flight keeps
      // the phase busy — do not publish (or toast) completion until it lands,
      // or export could accept a page with untranslated content.
      if (hasPendingDynamicWork()) {
        notifyPopupStatus();
        return;
      }
      // Mirror the initial-run outcome so 401/429 etc. are not reported as success.
      if (state.failed > 0 && state.translated === 0) {
        state.phase = "error";
        showToast(state.error || "翻译失败", "error", 6000);
      } else if (state.failed > 0) {
        state.phase = "translated";
        showToast(`已翻译 ${state.translated} 条，${state.failed} 条失败`, "warning", 5000);
      } else {
        state.phase = "translated";
        showToast(options.retry ? "重试完成" : "新内容已翻译", "success");
      }
      updateProgressPill();
      notifyPopupStatus();
    }
  }

  function findSegmentSplitIndex(text) {
    const length = text.length;
    if (length < 2) {
      return -1;
    }
    const mid = Math.ceil(length / 2);
    const window = Math.min(Math.max(240, Math.floor(length / 4)), Math.floor(length / 2));

    // Never land between a UTF-16 high/low surrogate (emoji / astral chars).
    function adjustSplitAwayFromSurrogatePair(index) {
      if (index <= 0 || index >= length) {
        return index;
      }
      const prev = text.charCodeAt(index - 1);
      const curr = text.charCodeAt(index);
      if (prev >= 0xD800 && prev <= 0xDBFF && curr >= 0xDC00 && curr <= 0xDFFF) {
        if (index + 1 < length) {
          return index + 1;
        }
        return index - 1;
      }
      return index;
    }

    // Scan outward from the midpoint, alternating sides, so the first index
    // matching a predicate is also the most balanced split that satisfies it.
    function findNearMid(predicate) {
      for (let distance = 0; distance <= window; distance += 1) {
        for (const index of [mid - distance, mid + distance]) {
          if (index <= 0 || index >= length) {
            continue;
          }
          if (predicate(index)) {
            return index;
          }
        }
      }
      return -1;
    }

    // X-style long posts are one span with \n\n paragraph breaks: prefer
    // splitting right after a blank line so halves keep whole paragraphs.
    let splitAt = findNearMid((index) => index >= 2 && text.slice(index - 2, index) === "\n\n");
    if (splitAt > 0) {
      return adjustSplitAwayFromSurrogatePair(splitAt);
    }

    // Then a single line break, then any whitespace, then a raw midpoint cut.
    splitAt = findNearMid((index) => text[index - 1] === "\n");
    if (splitAt > 0) {
      return adjustSplitAwayFromSurrogatePair(splitAt);
    }

    splitAt = findNearMid((index) => /\s/u.test(text[index - 1]) || /\s/u.test(text[index]));
    if (splitAt > 0) {
      return adjustSplitAwayFromSurrogatePair(splitAt);
    }

    return adjustSplitAwayFromSurrogatePair(mid);
  }

  // Cap concurrent TRANSLATE_BATCH sends at MAX_INFLIGHT_TRANSLATE_BATCHES
  // across ALL generations: abandoned generations keep their slots until
  // their requests settle, so a fresh run after an SPA navigation queues
  // behind the stale run's in-flight batches instead of stacking on top of
  // them (which would breach the provider cap and earn 429s).
  function acquireInflightTranslateSlot(runId) {
    if (inflightTranslateBatches < Utils.MAX_INFLIGHT_TRANSLATE_BATCHES) {
      inflightTranslateBatches += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      inflightTranslateWaiters.push(() => resolve(runId === generation));
    });
  }

  function releaseInflightTranslateSlot() {
    const next = inflightTranslateWaiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — the count stays put.
      next();
      return;
    }
    inflightTranslateBatches = Math.max(0, inflightTranslateBatches - 1);
  }

  // Tell the worker a run generation is abandoned (SPA navigation / restore /
  // fresh start): its in-flight TRANSLATE_BATCHes and their worker-side
  // backoff retries would only re-bill a generation whose results this side
  // drops anyway. Best-effort — the worker may be waking up.
  function cancelAbandonedRunBatches(runId) {
    if (!Number.isInteger(runId)) {
      return;
    }
    try {
      void chrome.runtime.sendMessage({
        type: "CANCEL_TRANSLATE_BATCHES",
        runId
      }).catch(() => {});
    } catch {
      // Extension context may be gone during teardown.
    }
  }

  async function requestSegmentTranslations(texts, runId, runSettings) {
    await acquireInflightTranslateSlot(runId);
    try {
      // Stale while queued behind full slots (navigation bumped the
      // generation) — sending would only re-bill a dead run.
      if (runId !== generation) {
        return null;
      }
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts,
        runId,
        provider: runSettings.provider || "deepseek",
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
    } finally {
      releaseInflightTranslateSlot();
    }
  }

  function isWhitespaceDelimitedTarget(targetLanguage) {
    const code = String(targetLanguage || "").toLowerCase();
    // CJK scripts generally do not need an inserted inter-word space.
    return !(code.startsWith("zh") || code.startsWith("ja"));
  }

  function joinSplitTranslations(left, right, leftSource, rightSource, targetLanguage) {
    const leftStr = String(left || "");
    const rightStr = String(right || "");
    // Derive source boundary first so blank-line splits win over partial
    // translated edge whitespace (DeepSeek may leave only a single \n).
    const leftTrail = (String(leftSource || "").match(/\s+$/u) || [""])[0];
    const rightLead = (String(rightSource || "").match(/^\s+/u) || [""])[0];
    const boundary = leftTrail || rightLead;

    // Source blank-line always rejoins with \n\n after trimming translated edges.
    if (/\n\n/u.test(boundary)) {
      return `${leftStr.replace(/\s+$/u, "")}\n\n${rightStr.replace(/^\s+/u, "")}`;
    }

    // If either translated half already retains edge whitespace, keep direct concat.
    if (/\s$/u.test(leftStr) || /^\s/u.test(rightStr)) {
      return `${leftStr}${rightStr}`;
    }

    if (!boundary) {
      // Midpoint char-split (e.g. CJK with no nearby whitespace) would otherwise
      // glue whitespace-delimited target halves: lastwordNextword.
      if (
        leftStr &&
        rightStr &&
        isWhitespaceDelimitedTarget(targetLanguage)
      ) {
        return `${leftStr} ${rightStr}`;
      }
      return `${leftStr}${rightStr}`;
    }
    const sep = /\n/u.test(boundary) ? "\n" : " ";
    return `${leftStr}${sep}${rightStr}`;
  }

  function translationOrNull(value) {
    const raw = String(value ?? "");
    // Reject empty/whitespace-only halves so joinSplitTranslations cannot hide a missing half.
    if (!raw.trim()) {
      return null;
    }
    return raw;
  }

  async function translateSegmentTextWithSplit(text, runId, runSettings, options = {}) {
    // Proactively bisect oversized text before any request: a whole-body
    // TRANSLATE_BATCH can fail with a non-canSplit error (X long posts are a
    // single ~9k-char span), which would leave the body untranslated.
    if (text.length > 5000) {
      const splitAt = findSegmentSplitIndex(text);
      if (splitAt < 1 || splitAt >= text.length) {
        // Cannot split further — attempt once (may still fail).
        const translations = await requestSegmentTranslations([text], runId, runSettings);
        if (!translations) {
          return null;
        }
        return translationOrNull(translations[0]);
      }
      const leftSource = text.slice(0, splitAt);
      const rightSource = text.slice(splitAt);
      const left = await translateSegmentTextWithSplit(leftSource, runId, runSettings);
      if (left == null || !String(left).trim() || runId !== generation) {
        return null;
      }
      const right = await translateSegmentTextWithSplit(rightSource, runId, runSettings);
      if (right == null || !String(right).trim() || runId !== generation) {
        return null;
      }
      // Preserve boundary whitespace from the original slice join.
      return joinSplitTranslations(left, right, leftSource, rightSource, runSettings.targetLanguage);
    }

    // forceSplit: caller already saw this exact text fail with canSplit —
    // re-requesting the identical text would only fail again. Bisect at once.
    if (options.forceSplit) {
      const splitAt = findSegmentSplitIndex(text);
      if (splitAt < 1 || splitAt >= text.length) {
        throw new Error("无法继续拆分该文本段");
      }
      const leftSource = text.slice(0, splitAt);
      const rightSource = text.slice(splitAt);
      const left = await translateSegmentTextWithSplit(leftSource, runId, runSettings);
      if (left == null || !String(left).trim() || runId !== generation) {
        return null;
      }
      const right = await translateSegmentTextWithSplit(rightSource, runId, runSettings);
      if (right == null || !String(right).trim() || runId !== generation) {
        return null;
      }
      // Preserve boundary whitespace from the original slice join.
      return joinSplitTranslations(left, right, leftSource, rightSource, runSettings.targetLanguage);
    }

    try {
      const translations = await requestSegmentTranslations([text], runId, runSettings);
      if (!translations) {
        return null;
      }
      return translationOrNull(translations[0]);
    } catch (error) {
      if (!error.canSplit || runId !== generation) {
        throw error;
      }
      const splitAt = findSegmentSplitIndex(text);
      if (splitAt < 1) {
        throw error;
      }
      const leftSource = text.slice(0, splitAt);
      const rightSource = text.slice(splitAt);
      const left = await translateSegmentTextWithSplit(leftSource, runId, runSettings);
      if (left == null || !String(left).trim() || runId !== generation) {
        return null;
      }
      const right = await translateSegmentTextWithSplit(rightSource, runId, runSettings);
      if (right == null || !String(right).trim() || runId !== generation) {
        return null;
      }
      // Preserve boundary whitespace from the original slice join.
      return joinSplitTranslations(left, right, leftSource, rightSource, runSettings.targetLanguage);
    }
  }

  function noteSegmentFailure(segment, reason = "") {
    const block = segment?.block;
    // A block already holding a failure slot keeps it: when the observer
    // retries the same block, the retry must replace the slot (see the
    // success path below), never stack a second failed/total count.
    if (block && failedBlocks.has(block)) {
      updateFailedMarker(block, reason);
      updateProgressPill();
      return;
    }
    if (block) {
      failedBlocks.add(block);
      showFailedMarker(block, reason);
    }
    state.failed += 1;
    updateProgressPill();
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

    // Provider echoed the source back unchanged (text already reads as the
    // target language): inserting a block would only duplicate it on screen.
    // Count as skipped — reclaim any failure slot and drop the total slot —
    // never as a failure. Cache the skip for this block + source text + run
    // settings so a rescan does not re-request (and re-bill) the same echo.
    if (Utils.isSameTranslation(segment.text, rendered)) {
      const runSettings = getRunSettings();
      skippedEchoBlocks.set(segment.block, {
        text: segment.text,
        provider: runSettings.provider,
        targetLanguage: runSettings.targetLanguage,
        model: runSettings.model
      });
      if (failedBlocks.delete(segment.block)) {
        if (state.failed > 0) {
          state.failed -= 1;
        }
      }
      removeFailedMarker(segment.block);
      if (state.total > 0) {
        state.total -= 1;
      }
      updateProgressPill();
      return true;
    }

    applyBlockTranslation(segment.block, segment.text, rendered, {
      companionOnly: Boolean(segment.companionOnly),
      nested: segment.nested || []
    });
    // Store only real (validated, non-echo) translations — the cache must
    // never resurrect an echo as an insertable "translation".
    setCachedTranslation(segment.text, rendered, getRunSettings());
    if (failedBlocks.delete(segment.block)) {
      // Dynamic retry landed for a previously failed block — reclaim its
      // failure slot instead of counting the block as both failed and translated.
      if (state.failed > 0) {
        state.failed -= 1;
      }
    }
    removeFailedMarker(segment.block);
    state.translated += 1;
    updateProgressPill();
    return true;
  }

  async function translateBatchWithFallback(batch, runId, runSettings = getRunSettings()) {
    // Cache-first: virtualized-list remounts re-request identical text under
    // identical run settings; a hit re-inserts the stored translation without
    // a billable request. Misses (and blocks whose source changed since) fall
    // through to the normal request path.
    const uncached = [];
    for (const segment of batch) {
      const cached = runId === generation ? getCachedTranslation(segment.text, runSettings) : null;
      if (cached != null && applyTranslatedSegment(segment, cached)) {
        continue;
      }
      uncached.push(segment);
    }
    if (uncached.length === 0) {
      return;
    }
    batch = uncached;

    // Oversized single block: split before the first request (413 may never recover otherwise).
    if (batch.length === 1 && batch[0].text.length > 5000 && runId === generation) {
      const segment = batch[0];
      try {
        const joined = await translateSegmentTextWithSplit(segment.text, runId, runSettings);
        if (runId !== generation) {
          // Stale run — no failure accounting for the replacement run.
          return;
        }
        if (joined == null || !String(joined).trim()) {
          // A half came back empty: the whole segment is UNTRANSLATED — the
          // old code silently skipped it (silent long-paragraph loss). Count
          // it as a failure so the pill/marker/summary surface the gap.
          noteSegmentFailure(segment, SPLIT_EMPTY_RESULT_MESSAGE);
          if (!state.error) {
            state.error = SPLIT_EMPTY_RESULT_MESSAGE;
          }
          return;
        }
        if (!applyTranslatedSegment(segment, joined)) {
          noteSegmentFailure(segment);
        }
        return;
      } catch (error) {
        if (runId !== generation) {
          // Stale run — must not pollute the replacement run's failure counts.
          return;
        }
        noteSegmentFailure(segment, error.message);
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
        // Stale/empty/disconnected segments reject here — count them so the
        // run summary does not silently under-report.
        if (!applyTranslatedSegment(batch[index], translation)) {
          noteSegmentFailure(batch[index], translation ? "译文无效" : "未返回译文");
        }
      });
    } catch (error) {
      if (runId !== generation) {
        // Stale run — no failure accounting, no further billable recursion.
        return;
      }
      if (error.canSplit && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await translateBatchWithFallback(batch.slice(0, middle), runId, runSettings);
        if (runId !== generation) {
          // Cancellation while the first half was pending — do not send the second.
          return;
        }
        await translateBatchWithFallback(batch.slice(middle), runId, runSettings);
        return;
      }

      // Single oversized segment: bisect text, translate halves, apply once.
      if (error.canSplit && batch.length === 1) {
        const segment = batch[0];
        try {
          const joined = await translateSegmentTextWithSplit(segment.text, runId, runSettings, { forceSplit: true });
          if (runId !== generation) {
            // Stale run — must not pollute the replacement run's failure counts.
            return;
          }
          if (joined == null || !String(joined).trim()) {
            // Empty split half = untranslated segment, never a silent skip.
            noteSegmentFailure(segment, SPLIT_EMPTY_RESULT_MESSAGE);
            if (!state.error) {
              state.error = SPLIT_EMPTY_RESULT_MESSAGE;
            }
            return;
          }
          if (!applyTranslatedSegment(segment, joined)) {
            noteSegmentFailure(segment);
          }
          return;
        } catch (splitError) {
          if (runId !== generation) {
            // Stale run — must not pollute the replacement run's failure counts.
            return;
          }
          noteSegmentFailure(segment, splitError.message);
          state.error = splitError.message;
          return;
        }
      }

      for (const segment of batch) {
        noteSegmentFailure(segment, error.message);
      }
      state.error = error.message;
    }
  }

  function isInsideInteractiveDescendant(node, block) {
    let el = node?.parentElement;
    while (el && el !== block) {
      if (INTERACTIVE_TAGS.has(el.tagName)) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function wrapTextNodesForToggle(block, nestedBlocks, wrapTag) {
    // Wrap text nodes only — never reparent element children — so selectors
    // like `p > a` and interactive descendants stay intact.
    // Also skip text inside nested interactive elements: translation-only hides
    // wraps, and the companion sits outside the control, which would blank labels.
    const nested = (nestedBlocks || []).filter(Boolean);
    const textNodes = collectRawTextNodes(block).filter((node) => (
      !nested.some((other) => other !== block && other.contains(node)) &&
      !(block && !INTERACTIVE_TAGS.has(block.tagName) && isInsideInteractiveDescendant(node, block))
    ));
    let firstWrap = null;
    const wraps = [];

    for (const textNode of textNodes) {
      if (!textNode?.isConnected || textNode.parentElement == null) {
        continue;
      }
      if (isOwnedOriginalWrap(textNode.parentElement)) {
        // Already wrapped by us (e.g. prior pass). Page-owned nodes merely
        // carrying the attribute are not ours and still get wrapped.
        continue;
      }
      if (!/\S/u.test(textNode.data || "")) {
        continue;
      }
      const wrap = document.createElement(wrapTag === "div" ? "span" : wrapTag);
      wrap.className = "kilocean-original-wrap";
      wrap.setAttribute("data-kilocean-original-wrap", "true");
      // The attribute stays for the CSS display toggle; real ownership is
      // the WeakSet — page-planted same-attribute nodes are never ours.
      ownedOriginalWraps.add(wrap);
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

    // Publishing translation DOM without the stylesheet would flash unstyled;
    // recreate first if the SPA dropped our <style>.
    ensureTranslatorStyles();

    const gen = beginApplyingDom();
    try {
      // Phrasing-content / common inline hosts must use <span> companions —
      // a block <div> inside button/strong (flex/grid items) distorts layout.
      const inlineHosts = new Set([
        "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DT", "DD",
        "FIGCAPTION", "TD", "TH", "CAPTION", "SUMMARY", "A", "SPAN", "LABEL",
        "BUTTON", "STRONG", "EM", "B", "I", "SMALL", "MARK", "CITE", "Q",
        "DFN", "ABBR", "TIME", "SUB", "SUP", "U", "S", "VAR", "OUTPUT"
      ]);
      const wrapTag = inlineHosts.has(block.tagName) ? "span" : "div";
      // True phrasing hosts need inline companions — block display would break
      // button/strong flex items. Blockish span hosts (P/H1/LI/…) keep block.
      const phrasingCompanionHosts = new Set([
        "A", "SPAN", "LABEL",
        "BUTTON", "STRONG", "EM", "B", "I", "SMALL", "MARK", "CITE", "Q",
        "DFN", "ABBR", "TIME", "SUB", "SUP", "U", "S", "VAR", "OUTPUT"
      ]);
      let placement = getTranslationPlacement(block);
      // Nested translated descendants must stay visible in translation-only mode;
      // after-host would hide the whole nowrap flex host including those nested blocks.
      if (options.companionOnly) {
        placement = "companion";
      }
      // X tweetText / UserDescription: the translation must be a block-level
      // sibling AFTER the container (display:block; width:100%). Inserting it
      // inside flex header/username rows squeezes quoted-tweet translations
      // into narrow columns and stacks @handles vertically.
      if (IS_X_HOST && block.matches(Utils.X_TRANSLATABLE_SELECTOR)) {
        placement = "after-host";
      }
      let wrap = null;
      let createdWraps = [];
      let layout = "wrap";

      let companion = document.createElement(wrapTag);
      companion.className = "kilocean-translation";
      companion.setAttribute("data-deepseek-translator-ui", "true");
      companion.setAttribute("lang", getRunSettings().targetLanguage);
      companion.textContent = translation;
      if (phrasingCompanionHosts.has(block.tagName)) {
        companion.classList.add("kilocean-translation--inline");
      }

      if (placement === "after-host" && block.parentNode && block !== document.body && block !== document.documentElement) {
        // nowrap flex: full-width flex item would squeeze siblings — place as block sibling.
        // Restricted parents (ul/ol/tr/…) need a valid sibling tag, or fall back in-host.
        const afterTag = resolveAfterHostCompanionTag(block, wrapTag);
        ({ firstWrap: wrap, wraps: createdWraps } = wrapTextNodesForToggle(block, options.nested || [], wrapTag));
        if (!afterTag) {
          companion.classList.add("kilocean-translation--flow");
          block.appendChild(companion);
          block.setAttribute("data-kilocean-layout", "flow");
          layout = "flow";
        } else {
          if (afterTag !== companion.tagName) {
            const replacement = document.createElement(afterTag);
            replacement.className = companion.className;
            for (const attr of companion.attributes) {
              replacement.setAttribute(attr.name, attr.value);
            }
            replacement.textContent = companion.textContent;
            companion = replacement;
          }
          companion.classList.add("kilocean-translation--after");
          block.parentNode.insertBefore(companion, block.nextSibling);
          block.setAttribute("data-kilocean-layout", "after");
          layout = "after";
        }
      } else if (placement === "companion") {
        // Nested ancestor with own text: wrap owned text nodes so translation-only
        // can hide them without reparenting nested block subtrees or interactive els.
        ({ firstWrap: wrap, wraps: createdWraps } = wrapTextNodesForToggle(block, options.nested || [], wrapTag));
        companion.classList.add("kilocean-translation--flow");
        block.appendChild(companion);
        block.setAttribute("data-kilocean-layout", "companion");
        layout = "companion";
      } else if (placement === "flow") {
        // Preserve flex/grid element children, but wrap owned text nodes so
        // translation-only can hide them (CSS cannot target bare text nodes).
        ({ firstWrap: wrap, wraps: createdWraps } = wrapTextNodesForToggle(block, options.nested || [], wrapTag));
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
        layout,
        nested: options.nested || []
      };
      blockRecords.set(block, record);
      applyBlockDisplay(record);
    } finally {
      endApplyingDom(gen);
    }
  }

  function resolveAfterHostCompanionTag(block, fallbackTag) {
    const parent = block?.parentElement;
    if (!parent) {
      return null;
    }
    switch (parent.tagName) {
      case "UL":
      case "OL":
      case "MENU":
        return "LI";
      case "TR":
        return block.tagName === "TH" ? "TH" : "TD";
      case "DL":
        return block.tagName === "DT" ? "DD" : "DD";
      case "TABLE":
      case "THEAD":
      case "TBODY":
      case "TFOOT":
      case "SELECT":
      case "COLGROUP":
        // No valid after-host sibling — caller keeps companion inside the host.
        return null;
      default:
        return fallbackTag;
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
    // SPA head replacement can drop the style host — recreate before the
    // display attribute depends on its rules.
    ensureTranslatorStyles();
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
      /* Translated text (1.5.0): color-only separation — no dashed top border,
         no padding-top; inherits the page font/size (CONTRACT light tokens). */
      [data-kilocean-block] > .kilocean-translation {
        display: block;
        margin-top: 0.3em;
        color: #4B5563;
        line-height: inherit;
        white-space: pre-wrap;
      }
      [data-kilocean-block] > .kilocean-translation.kilocean-translation--inline {
        display: inline;
        margin-top: 0;
        color: inherit;
      }
      [data-kilocean-block][data-kilocean-layout="flow"] > .kilocean-translation--flow {
        flex: 0 0 100%;
        width: 100%;
        max-width: 100%;
        grid-column: 1 / -1;
        box-sizing: border-box;
      }
      .kilocean-translation--after[data-deepseek-translator-ui] {
        display: block;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        margin-top: 0.3em;
        color: #4B5563;
        line-height: inherit;
        white-space: pre-wrap;
      }
      li.kilocean-translation--after[data-deepseek-translator-ui] {
        list-style: none;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] [data-kilocean-original-wrap] {
        display: contents;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] > .kilocean-translation {
        display: block;
        opacity: 0.96;
      }
      html[data-kilocean-display="bilingual"] [data-kilocean-block] > .kilocean-translation.kilocean-translation--inline {
        display: inline;
      }
      html[data-kilocean-display="bilingual"] .kilocean-translation--after[data-deepseek-translator-ui] {
        opacity: 0.96;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block] [data-kilocean-original-wrap] {
        display: none !important;
      }
      /* flow/after: hide only owned original wraps — never page-owned images/inputs */
      html[data-kilocean-display="translation-only"] [data-kilocean-block] > .kilocean-translation {
        display: block;
      }
      html[data-kilocean-display="translation-only"] [data-kilocean-block] > .kilocean-translation.kilocean-translation--inline {
        display: inline;
      }
      html[data-kilocean-display="translation-only"] .kilocean-translation--after[data-deepseek-translator-ui] {
        display: block;
      }
      html[data-kilocean-display="original"] [data-kilocean-block] [data-kilocean-original-wrap] {
        display: contents;
      }
      html[data-kilocean-display="original"] [data-kilocean-block] > .kilocean-translation,
      html[data-kilocean-display="original"] .kilocean-translation--after[data-deepseek-translator-ui] {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleHost);
  }

  function isOwnedOriginalWrap(el) {
    // Ownership is WeakSet membership, never the attribute: the page can set
    // data-kilocean-original-wrap on its own nodes (hidden-content bypass),
    // but only wraps created by wrapTextNodesForToggle ever enter the set.
    return ownedOriginalWraps.has(el);
  }

  function isInsideOriginalWrap(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
      if (isOwnedOriginalWrap(cur)) {
        return true;
      }
    }
    return false;
  }

  function isExtensionOwnedNode(node) {
    // Only the extension chrome nodes themselves — not page content living inside
    // owned original wraps (SPA edits there must still refresh the block).
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return Boolean(
      isOwnedOriginalWrap(node) ||
      node.classList?.contains("kilocean-translation") ||
      node.classList?.contains("kilocean-translation--after") ||
      node.classList?.contains("kilocean-translation--flow") ||
      node.hasAttribute?.("data-deepseek-translator-ui")
    );
  }

  function isReparentIntoOriginalWrap(node) {
    // After we wrap a text node, MutationObserver removedNodes still point at the
    // text whose new parent is our wrap — treat that as extension-owned reparent.
    return isOwnedOriginalWrap(node?.parentElement);
  }

  function isDefinitelyIneligibleNode(node) {
    // Script/style/noscript/template churn can never hold translatable text —
    // skip it before queueing so it cannot mark the run busy or reset the debounce.
    if (node?.nodeType === Node.ELEMENT_NODE) {
      return NON_CONTENT_TAGS.has(node.tagName);
    }
    const parent = node?.parentElement;
    return Boolean(parent && NON_CONTENT_TAGS.has(parent.tagName));
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
    return !isInsideOriginalWrap(el) && !isOwnedOriginalWrap(ui);
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
    if (ui && !isInsideOriginalWrap(el) && !isOwnedOriginalWrap(ui) && ui !== host) {
      return null;
    }
    return host;
  }

  // True when a current eligible source text node of the block lives outside
  // every owned original wrap: the SPA re-rendered equivalent text around our
  // still-connected wraps, and that bare node would stay visible untranslated
  // in translation-only mode unless repair rebuilds for it as well. Uses the
  // same eligibility filter wrapTextNodesForToggle applies when collecting
  // nodes it would wrap.
  function hasUnwrappedOriginalTextNode(block, nestedBlocks) {
    const nested = (nestedBlocks || []).filter(Boolean);
    return collectRawTextNodes(block).some((node) => (
      !nested.some((other) => other !== block && other.contains(node)) &&
      !(block && !INTERACTIVE_TAGS.has(block.tagName) && isInsideInteractiveDescendant(node, block)) &&
      !isOwnedOriginalWrap(node.parentElement)
    ));
  }

  // Same source text but the SPA re-rendered the DOM around it: our own
  // original wraps (and possibly the companion) left the tree with the old
  // subtree, or fresh text nodes appeared outside every wrap. Rebuild the
  // record's owned DOM from the cached translation — never via a fresh
  // TRANSLATE_BATCH — so translation-only toggling and the visible
  // translation survive equivalent-text re-renders without re-billing.
  function repairBlockRecordDom(record) {
    if (!record?.block?.isConnected) {
      return;
    }
    const gen = beginApplyingDom();
    try {
      const wraps = record.wraps || [];
      if (
        wraps.length === 0 ||
        wraps.some((wrap) => !wrap?.isConnected) ||
        hasUnwrappedOriginalTextNode(record.block, record.nested)
      ) {
        const rebuilt = wrapTextNodesForToggle(record.block, record.nested || [], "span");
        if (rebuilt.wraps.length > 0) {
          // wrapTextNodesForToggle skips nodes already inside owned wraps, so a
          // partial rebuild yields only the NEW wraps — keep the still-connected
          // old ones too, or a later teardown could never unwrap them.
          record.wraps = wraps.filter((wrap) => wrap?.isConnected).concat(rebuilt.wraps);
          record.wrap = rebuilt.firstWrap || record.wrap;
        }
      }
      if (record.companion && !record.companion.isConnected) {
        if (record.layout === "after") {
          // relocateAfterHostCompanion re-inserts the detached sibling after
          // the host and manages its own applyingDom guard.
          relocateAfterHostCompanion(record);
        } else {
          record.block.appendChild(record.companion);
        }
      }
    } finally {
      endApplyingDom(gen);
    }
  }

  function relocateAfterHostCompanion(record) {
    // A reordered/reparented after-host block must carry its sibling companion
    // along (local move only — no teardown, no rebill).
    if (!record || record.layout !== "after" || !record.companion) {
      return;
    }
    const host = record.block;
    if (!host?.parentNode) {
      return;
    }
    if (record.companion.parentNode === host.parentNode && record.companion.previousSibling === host) {
      return;
    }
    const gen = beginApplyingDom();
    try {
      host.parentNode.insertBefore(record.companion, host.nextSibling);
    } finally {
      endApplyingDom(gen);
    }
  }

  function restoreRemovedCompanions(removedNodes) {
    // A page update that removes only our companion (innerHTML wipes, framework
    // child swaps) leaves the record claiming "translated" while the UI is gone
    // forever — re-insert the cached companion while the source block survives.
    // Restore from the cached record only; never rebill.
    for (const record of blockRecords.values()) {
      const { block, companion } = record;
      if (!block?.isConnected || !companion || companion.isConnected) {
        continue;
      }
      const wasRemoved = [...removedNodes].some((node) => (
        node === companion || node?.contains?.(companion)
      ));
      if (!wasRemoved) {
        continue;
      }
      if (record.layout === "after") {
        // relocateAfterHostCompanion re-inserts the detached sibling after the
        // host and manages its own applyingDom guard.
        relocateAfterHostCompanion(record);
      } else {
        const gen = beginApplyingDom();
        try {
          block.appendChild(companion);
        } finally {
          endApplyingDom(gen);
        }
      }
    }
  }

  function collectRemovedRecordedBlocks(removedNodes) {
    const found = new Set();
    for (const node of removedNodes) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      if (blockRecords.has(node)) {
        found.add(node);
      }
      // Unrecorded wrappers around recorded nested blocks (e.g. remove <div>
      // from <section>Hello<div><p>World</p></div></section>) must count too.
      for (const block of blockRecords.keys()) {
        if (block !== node && node.contains(block)) {
          found.add(block);
        }
      }
    }
    return found;
  }

  function isRemovalOfOnlyRecordedContent(node, removedRecordedBlocks) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    if (removedRecordedBlocks.has(node)) {
      return true;
    }
    const nested = [...removedRecordedBlocks].filter((block) => node.contains(block));
    if (nested.length === 0) {
      return false;
    }
    // Detached subtrees cannot use getComputedStyle-backed collectors — walk text
    // nodes directly and ignore text owned by the nested recorded blocks.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let textNode;
    let leftover = "";
    while ((textNode = walker.nextNode())) {
      if (nested.some((block) => block.contains(textNode))) {
        continue;
      }
      leftover += textNode.data || "";
    }
    return !/\S/u.test(leftover);
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

      let queuedDynamicWork = false;
      for (const record of records) {
        if (record.type === "childList") {
          if (record.removedNodes.length > 0) {
            // Head replacement / style pruning disconnects our <style> without
            // any later apply pass — recreate it right here. The insertion is
            // drained via begin/endApplyingDom so it cannot re-enter us.
            if (styleHost && !styleHost.isConnected) {
              const styleGen = beginApplyingDom();
              try {
                ensureTranslatorStyles();
              } finally {
                endApplyingDom(styleGen);
              }
            }
            // Snapshot recorded removed children/descendants BEFORE prune deletes
            // their records — permanently removed nested translated blocks must
            // not look like content edits of the still-connected ancestor.
            const removedRecordedBlocks = collectRemovedRecordedBlocks(record.removedNodes);
            pruneDetachedBlockRecords();
            // A companion-only removal must be restored even though the batch is
            // otherwise ignorable — without it the record claims translated forever.
            restoreRemovedCompanions(record.removedNodes);
            // Removal-only SPA updates never appear in addedNodes — refresh via target.
            // Recorded blocks in removedNodes (direct or inside an unrecorded wrapper)
            // are moves or permanent removals — do not queue the ancestor for
            // teardown/rebill when the wrapper contributes no other source text.
            const removedOnlyUi = [...record.removedNodes].every((node) =>
              isIgnoredTranslatorMutation(node) ||
              isReparentIntoOriginalWrap(node) ||
              removedRecordedBlocks.has(node) ||
              isRemovalOfOnlyRecordedContent(node, removedRecordedBlocks)
            );
            if (!removedOnlyUi) {
              const refreshHost = findRefreshHostForMutation(record.target);
              if (refreshHost) {
                pendingRefreshBlocks.add(refreshHost);
                queuedDynamicWork = true;
              } else if (record.target?.isConnected && isInXTranslatableMutationScope(record.target)) {
                // In-flight translate may have no blockRecords yet — queue target
                // so discovery retries after the pending request rejects the stale segment.
                pendingRoots.add(record.target);
                queuedDynamicWork = true;
              }
            }
          }
          record.addedNodes.forEach((node) => {
            if (isDefinitelyIneligibleNode(node) || isIgnoredTranslatorMutation(node)) {
              return;
            }
            // Whole recorded block reparented/reordered — treat as a move, not
            // a content edit (avoids teardown + rebill on sortable lists).
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              blockRecords.has(node) &&
              node.isConnected
            ) {
              relocateAfterHostCompanion(blockRecords.get(node));
              return;
            }
            const refreshHost = findRefreshHostForMutation(node);
            if (refreshHost) {
              pendingRefreshBlocks.add(refreshHost);
              queuedDynamicWork = true;
              return;
            }
            if (!isInXTranslatableMutationScope(node)) {
              return;
            }
            pendingRoots.add(node);
            queuedDynamicWork = true;
          });
          continue;
        }

        if (record.type === "characterData") {
          const node = record.target;
          const refreshHost = findRefreshHostForMutation(node);
          if (refreshHost) {
            pendingRefreshBlocks.add(refreshHost);
            queuedDynamicWork = true;
            continue;
          }
          if (
            isDefinitelyIneligibleNode(node) ||
            isIgnoredTranslatorMutation(node) ||
            !isInXTranslatableMutationScope(node)
          ) {
            continue;
          }
          pendingRoots.add(node);
          queuedDynamicWork = true;
        }
      }

      // Only real pending work may mark the phase translating / reset the
      // 450 ms debounce — ineligible churn (script/style swaps, noise inside
      // ignored nodes) must not keep exports disabled forever.
      if (queuedDynamicWork) {
        scheduleDynamicTranslation();
      }
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

  // Pill 停止: cancel the in-flight run but KEEP finished translations —
  // unlike restoreOriginal nothing is unwrapped, the session stays active
  // (display-mode toggling / export / later retry keep working), and the
  // translation cache survives so a retry never re-bills finished segments.
  function stopTranslation() {
    if (!state.active) {
      return;
    }
    const abandonedRunId = generation;
    generation += 1;
    workQueue = Promise.resolve();
    cancelAbandonedRunBatches(abandonedRunId);
    stopObserving();
    pendingRoots.clear();
    pendingRefreshBlocks.clear();
    finishRunSettings();
    state.phase = state.translated > 0 ? "translated" : "idle";
    updateProgressPill();
    notifyPopupStatus();
  }

  function hasPendingDynamicWork() {
    return dynamicTimer != null || pendingRoots.size > 0 || pendingRefreshBlocks.size > 0;
  }

  function finalizeDynamicPhase() {
    // Publish the terminal phase for a dynamic pass that ran out of work —
    // unless newer dynamic work is still pending: it must keep the run
    // "translating" so export cannot accept untranslated content.
    if (!state.active || state.phase !== "translating") {
      return;
    }
    if (!hasPendingDynamicWork()) {
      state.phase = state.failed > 0 && state.translated === 0 ? "error" : "translated";
    }
    notifyPopupStatus();
  }

  function scheduleDynamicTranslation() {
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
    }
    // Mark busy before the debounce window so export cannot race pending work.
    if (state.active) {
      state.phase = "translating";
      notifyPopupStatus();
    }
    dynamicTimer = setTimeout(() => {
      dynamicTimer = null;
      // The 450 ms debounce can land between the 500 ms SPA poll ticks:
      // right after a pushState route swap, the new view's queued mutations
      // would flush under the pre-navigation generation — those requests stay
      // billed even after the poll catches up, bumps the generation and
      // re-discovers the same content. Reconcile the URL synchronously before
      // this flush can issue anything; when a navigation was handled,
      // handleSpaNavigation has already bumped the generation, dropped the
      // stale pendingRoots and re-armed discovery from document.body, so this
      // flush must simply stop and let the re-queued one run.
      if (checkSpaNavigation()) {
        return;
      }
      pruneDetachedBlockRecords();

      // X "Show more" expands a recorded tweetText in place: that content
      // mutation lands in pendingRefreshBlocks, and only a real source-text
      // change (current text vs. the recorded original) tears the block down
      // — discardBlockRecord removes the stale companion translation + wraps
      // and the dynamic pass re-translates the expanded text in place (the
      // new translation replaces the old block; no duplicate companion).
      // Equivalent-text churn (SPA re-render of the same words) keeps the
      // live translation: no teardown, no re-bill — extractBlockText reads
      // through our own translation-only display:none wraps, and if the
      // re-render swapped out our owned DOM, repairBlockRecordDom rebuilds
      // it from the cached translation instead of re-requesting.
      // The comparison must extract exactly the way record.originalText was
      // captured: excluding record.nested (separately-translated descendant
      // blocks). Including their text would flag every ancestor-of-translated
      // block as "source changed" and tear it down for a pointless re-bill.
      for (const block of pendingRefreshBlocks) {
        const record = blockRecords.get(block);
        if (record && block.isConnected) {
          if (extractBlockText(block, record.nested || []) === record.originalText) {
            repairBlockRecordDom(record);
            continue;
          }
          discardBlockRecord(block);
        }
        if (block?.isConnected && !blockRecords.has(block)) {
          pendingRoots.add(block);
        }
      }
      pendingRefreshBlocks.clear();

      const roots = [...pendingRoots];
      pendingRoots.clear();
      const blocks = roots.flatMap((root) => collectBlocks(root));
      const runId = generation;
      if (blocks.length === 0) {
        if (runId === generation) {
          finalizeDynamicPhase();
        }
        return;
      }
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
      // Failed blocks still on the page and individually retryable (pill
      // 重试 / marker 重试 / popup RETRY_FAILED).
      failedRetryable: [...failedBlocks].filter((block) => block?.isConnected).length,
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
    // Strip every extension-owned host: toast, selection bubble, progress pill
    // and the in-place failed-segment markers.
    clone.querySelectorAll(
      "script, iframe, object, embed, #deepseek-translator-toast-host, " +
      "#kilocean-selection-host, #kilocean-progress-host, [data-kilocean-failed-marker]"
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
    generator.setAttribute("content", "千浩翻译 · Kilocean Translate 1.5.0");
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
          /* ---- toast · light theme (CONTRACT 1.5.0 tokens: #fff card, #111827
             text, brand #3D5AFE, ok #15803D, warn #B45309, err #C62828) ---- */
          .toast {
            display: flex;
            align-items: center;
            gap: 9px;
            max-width: 320px;
            padding: 11px 14px;
            color: #111827;
            background: #ffffff;
            border: 1px solid #E5E7EB;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(17, 24, 39, 0.12);
            font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
            opacity: 0;
            transform: translateY(8px);
            transition: opacity 160ms ease, transform 160ms ease;
          }
          .toast.visible { opacity: 1; transform: translateY(0); }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #6B7280; flex: 0 0 auto; }
          .loading .dot { background: #3D5AFE; animation: pulse 1s ease infinite; }
          .success .dot { background: #15803D; }
          .warning .dot { background: #B45309; }
          .error .dot { background: #C62828; }
          @keyframes pulse { 50% { opacity: .35; transform: scale(.8); } }
          @media (prefers-reduced-motion: reduce) {
            .toast { transition: none; }
            .loading .dot { animation: none; }
          }
        </style>
        <div class="toast"><span class="dot"></span><span class="message"></span></div>
      `;
    }

    // Keep the toast clear of the progress pill: it sits above the pill while
    // a page run shows one (pill = bottom 16px + ~44px tall).
    host.style.bottom = progressPillHost?.isConnected ? "76px" : "22px";
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

  // ====================================================================
  // 1.5.0 page-run UI: progress pill + in-place failed-segment markers.
  // Security model: everything rendered here lives in CLOSED shadow roots on
  // hosts marked data-deepseek-translator-ui (ignored by collectBlocks / the
  // mutation observer, stripped from exports and print). Billing-capable
  // actions (重试) fire only from trusted clicks (event.isTrusted) — page
  // script can neither forge the click nor reach inside the shadow root.
  // ====================================================================

  // ---- shared helpers ----

  // Key-shaped failures (missing key / 401) get an 打开设置 exit in the pill;
  // everything else offers 重试.
  function isKeyRelatedError(message) {
    const text = String(message || "");
    return /API Key/i.test(text) && /无效|填写|配置/.test(text);
  }

  // Marker/pill reason lines stay one short line.
  function shortenReason(reason) {
    return String(reason || "").replace(/\s+/gu, " ").trim().slice(0, 24);
  }

  function escapePillText(value) {
    return String(value ?? "")
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  // Non-billable exit: opens the extension settings focused on the key field.
  // Harmless if a page somehow forges the click (worst case: a settings tab).
  function openSettingsForKey() {
    try {
      void chrome.runtime.sendMessage({ type: "OPEN_SETTINGS", focus: "key" }).catch?.(() => {});
    } catch {
      // Worker may be asleep.
    }
  }

  // Same effect as the SET_DISPLAY_MODE message, used by the pill's segmented
  // control (trusted click only).
  function setDisplayModePreference(mode) {
    const normalized = Utils.normalizeDisplayMode(mode);
    if (!normalized) {
      return;
    }
    state.displayMode = normalized;
    applyDocumentDisplayMode(normalized);
    refreshAllBlockDisplays();
    chrome.storage.local.set({ displayMode: normalized });
    updateProgressPill();
  }

  // ---- progress pill ----

  /* ---- pill CSS · light theme (CONTRACT 1.5.0 tokens: #fff card, #111827
     text, #6B7280 muted, #3D5AFE brand, #B45309 warn, #C62828 err, radius 12,
     shadow 0 8px 24px rgba(17,24,39,.12)) — keep in one template string so a
     UI pass can restyle it wholesale. ---- */
  const PROGRESS_PILL_CSS = `
    .pill {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: min(92vw, 520px);
      padding: 5px 6px 5px 8px;
      background: #fff;
      border: 1px solid #E5E7EB;
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(17, 24, 39, 0.12);
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
      color: #111827;
    }
    .pill.error { border-color: #FECACA; }
    .pill .tx { display: flex; flex-direction: column; line-height: 1.25; padding: 2px 2px; }
    .pill .tx b { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
    .pill.error .tx b { color: #C62828; }
    .pill .tx span { font-size: 11px; color: #6B7280; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill .ring { width: 16px; height: 16px; flex: 0 0 auto; border-radius: 50%; border: 2px solid #EEF1FF; border-top-color: #3D5AFE; }
    /* The spin animation exists ONLY in the translating state (PR #19
       follow-up): error / partial / done must never animate — a terminal
       state showing a spinner reads as work still in flight. */
    .pill.translating .ring { animation: pill-spin 0.9s linear infinite; }
    .pill .ringp { position: relative; width: 16px; height: 16px; flex: 0 0 auto; border-radius: 50%; }
    .pill .ringp::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: #fff; }
    .pill .cb {
      height: 26px; min-height: 24px; padding: 0 10px;
      border-radius: 999px; border: 1px solid #E5E7EB; background: #fff;
      color: #374151; font-family: inherit; font-size: 12px; line-height: 1;
      cursor: pointer; white-space: nowrap;
    }
    .pill .cb:hover { background: #F9FAFB; }
    .pill .cb.primary { background: #3D5AFE; border-color: #3D5AFE; color: #fff; }
    .pill .cb.primary:hover { background: #2F48D8; }
    .pill .cb.warnb { border-color: #FDE68A; background: #FFFBEB; color: #B45309; }
    .pill .mseg { display: flex; gap: 2px; padding: 2px; background: #F3F4F6; border-radius: 999px; }
    .pill .mseg button { height: 24px; padding: 0 9px; border: 0; border-radius: 999px; background: transparent; color: #6B7280; font-family: inherit; font-size: 12px; cursor: pointer; }
    .pill .mseg button[aria-checked="true"] { background: #fff; color: #111827; font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
    .pill .count { padding: 0 2px; color: #4B5563; white-space: nowrap; }
    .pill[data-collapsed="true"] .count { display: none; }
    @keyframes pill-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .pill.translating .ring { animation: none; }
    }
  `;

  function ensureProgressPill() {
    if (progressPillHost?.isConnected && progressPillShadow) {
      return progressPillHost;
    }
    const host = document.createElement("div");
    host.id = "kilocean-progress-host";
    host.setAttribute("data-deepseek-translator-ui", "true");
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483646"
    });
    document.documentElement.appendChild(host);
    // Closed shadow root: page script can never reach (or restyle) the pill
    // internals; all our access goes through the stored ref below.
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PROGRESS_PILL_CSS;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "pill";
    root.addEventListener("click", onPillClick);
    shadow.appendChild(root);
    progressPillHost = host;
    progressPillShadow = shadow;
    return host;
  }

  // Render the pill for the current state; no-op when nothing changed. Called
  // on every applied batch / failure / phase transition / displayMode toggle.
  function updateProgressPill() {
    if (!state.active || state.total === 0) {
      hideProgressPill();
      return;
    }
    ensureProgressPill();
    const signature = [
      state.phase,
      state.translated,
      state.total,
      state.failed,
      state.displayMode,
      isKeyRelatedError(state.error)
    ].join("\u0000");
    if (signature === progressPillSignature) {
      return;
    }
    const phaseChanged = !progressPillSignature.startsWith(state.phase);
    progressPillSignature = signature;
    renderProgressPill(phaseChanged);
  }

  function renderProgressPill(resetCollapse = true) {
    const shadow = progressPillShadow;
    const root = shadow?.querySelector(".pill");
    if (!root) {
      return;
    }
    if (resetCollapse) {
      if (pillCollapseTimer) {
        clearTimeout(pillCollapseTimer);
        pillCollapseTimer = null;
      }
      pillCollapsed = false;
    }
    root.className = "pill";
    root.removeAttribute("data-collapsed");

    if (state.phase === "translating") {
      root.classList.add("translating");
      root.innerHTML = `
        <span class="ring" aria-hidden="true"></span>
        <span class="tx"><b>翻译中 ${state.translated} / ${state.total}</b><span>先翻可见区域</span></span>
        <button class="cb" type="button" data-action="stop" title="停止（保留已翻译内容）">✕ 停止</button>`;
      return;
    }

    if (state.phase === "error") {
      // Persistent (never auto-hides): what happened + the next step.
      root.classList.add("error");
      const reason = escapePillText(shortenReason(state.error));
      const action = isKeyRelatedError(state.error)
        ? '<button class="cb primary" type="button" data-action="settings">打开设置</button>'
        : '<button class="cb primary" type="button" data-action="retry">重试</button>';
      root.innerHTML = `
        <span class="ringp" style="background: conic-gradient(#C62828 25%, #FECACA 0)" aria-hidden="true"></span>
        <span class="tx"><b>翻译失败</b><span>${reason || "未知原因"}</span></span>
        ${action}`;
      return;
    }

    // Terminal on this run (phase translated / stopped mid-run): pick the
    // view from the counts so a stopped run still shows its outcome.
    if (state.failed > 0) {
      const progress = state.total > 0 ? Math.round((state.translated / state.total) * 100) : 0;
      root.classList.add("partial");
      // A key error that lands mid-run (some segments already translated)
      // still has state.failed > 0, so we reach this branch — not the pure
      // error branch. Offer 「打开设置」 instead of Retry, or every click
      // would re-bill the known-invalid credential (Codex PR #19 P2).
      const action = isKeyRelatedError(state.error)
        ? '<button class="cb primary" type="button" data-action="settings">打开设置</button>'
        : `<button class="cb warnb" type="button" data-action="retry">重试 ${state.failed} 段</button>`;
      root.innerHTML = `
        <span class="ringp" style="background: conic-gradient(#B45309 ${progress}%, #FDE68A 0)" aria-hidden="true"></span>
        <span class="tx"><b>${state.translated} / ${state.total}</b><span>${state.failed} 段未完成</span></span>
        ${action}
        <button class="cb" type="button" data-action="jump">跳到未完成 ↓</button>`;
      return;
    }

    root.classList.add("done");
    const modes = [
      [Utils.DISPLAY_MODES.bilingual, "双语"],
      [Utils.DISPLAY_MODES.translationOnly, "译文"],
      [Utils.DISPLAY_MODES.original, "原文"]
    ];
    root.innerHTML = `
      <span class="count">已翻译 ${state.translated} 段</span>
      <div class="mseg" role="radiogroup" aria-label="显示方式">
        ${modes.map(([mode, label]) =>
    `<button type="button" role="radio" data-action="mode" data-mode="${mode}" aria-checked="${state.displayMode === mode}">${label}</button>`
  ).join("")}
      </div>
      <button class="cb" type="button" data-action="restore">还原</button>`;
    // Never covers content badly: after ~4 s only the compact segmented
    // control + 还原 remain (the count line collapses away).
    if (pillCollapseTimer) {
      clearTimeout(pillCollapseTimer);
    }
    pillCollapseTimer = setTimeout(() => {
      pillCollapseTimer = null;
      pillCollapsed = true;
      progressPillShadow?.querySelector(".pill")?.setAttribute("data-collapsed", "true");
    }, 4000);
  }

  function hideProgressPill() {
    if (pillCollapseTimer) {
      clearTimeout(pillCollapseTimer);
      pillCollapseTimer = null;
    }
    pillCollapsed = false;
    progressPillSignature = "";
    const host = progressPillHost;
    progressPillHost = null;
    progressPillShadow = null;
    host?.remove();
  }

  // One delegated listener for every pill button. Trusted clicks only: the
  // pill lives in page DOM, so synthetic page-script events must be inert —
  // especially the retry actions, which spend the user's API key.
  function onPillClick(event) {
    if (event.isTrusted === false) {
      return;
    }
    const button = event.target?.closest?.("button[data-action]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.action;
    if (action === "stop") {
      stopTranslation();
    } else if (action === "restore") {
      restoreOriginal();
    } else if (action === "mode") {
      setDisplayModePreference(button.dataset.mode);
    } else if (action === "retry") {
      void retryFailedBlocks();
    } else if (action === "jump") {
      scrollNextFailedBlockIntoView();
    } else if (action === "settings") {
      openSettingsForKey();
    }
  }

  function scrollNextFailedBlockIntoView() {
    const blocks = [...failedBlocks].filter((block) => block?.isConnected);
    if (blocks.length === 0) {
      return;
    }
    const next = blocks.find((block) => {
      try {
        return block.getBoundingClientRect().bottom > window.innerHeight;
      } catch {
        return false;
      }
    });
    const target = next || blocks[0];
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      // Detached between the filter and here — ignore.
    }
  }

  // ---- in-place failed-segment markers ----

  /* ---- marker CSS · light theme (err #C62828 on #FEF2F2, radius 12) — one
     template string for easy restyling. ---- */
  const FAILED_MARKER_CSS = `
    .marker {
      display: block;
      max-width: 640px;
      margin: 4px 0;
      padding: 5px 10px;
      background: #FEF2F2;
      border: 1px solid #FECACA;
      border-radius: 10px;
      color: #C62828;
      font: 500 12.5px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
    }
    .marker button.retry {
      margin-left: 8px;
      height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid #FECACA;
      background: #fff;
      color: #C62828;
      font: inherit;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }
    .marker button.retry:hover { background: #FEF2F2; }
  `;

  // Codex PR #19 P2-3: where may a failed-segment marker live? HTML's content
  // models forbid most direct children of table/list structures — a div can
  // never sit under tr/tbody/ul/dl, and a stray wrapper there breaks layout
  // or gets relocated by the parser. Blocks that ARE those restricted slots
  // (cells, captions, list items, definition terms) and any block whose
  // PARENT is a restricted container get the marker INSIDE the block (a span
  // appended as its last child); every other block gets a sibling div after
  // it, as before.
  const MARKER_HOST_INSIDE_TAGS = new Set(["TD", "TH", "CAPTION", "LI", "DT", "DD"]);
  const MARKER_SIBLING_FORBIDDEN_PARENTS = new Set([
    "TR", "TABLE", "THEAD", "TBODY", "TFOOT", "UL", "OL", "DL",
    "SELECT", "COLGROUP", "OPTGROUP", "DATALIST"
  ]);

  // Pure: given the failed block, return { parent, before, tag } describing
  // the marker host's insertion — parent.insertBefore(host, before) (a null
  // `before` appends). Deliberately free of Node.* constants so plain-object
  // harnesses can drive it.
  function resolveMarkerPlacement(block) {
    const tagName = String(block?.tagName || "").toUpperCase();
    const parentNode = block?.parentNode || null;
    const parentElement = parentNode && parentNode.nodeType === 1 ? parentNode : null;
    const parentTag = String(parentElement?.tagName || "").toUpperCase();
    if (MARKER_HOST_INSIDE_TAGS.has(tagName) || MARKER_SIBLING_FORBIDDEN_PARENTS.has(parentTag)) {
      return { parent: block, before: null, tag: "span" };
    }
    return { parent: parentElement || block, before: block.nextSibling, tag: "div" };
  }

  // Small owned marker right after a failed block: "这段没翻译成功（原因）·
  // 重试". Closed shadow root; the retry only fires on a trusted click.
  // Restricted-parent blocks (table cells, list items…) host the marker
  // INSIDE themselves — see resolveMarkerPlacement above.
  function showFailedMarker(block, reason = "") {
    if (!block?.isConnected || !block.parentNode) {
      return;
    }
    removeFailedMarker(block);
    const gen = beginApplyingDom();
    try {
      const placement = resolveMarkerPlacement(block);
      const host = document.createElement(placement.tag);
      host.setAttribute("data-kilocean-failed-marker", "true");
      host.setAttribute("data-deepseek-translator-ui", "true");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = FAILED_MARKER_CSS;
      const root = document.createElement("div");
      root.className = "marker";
      const text = document.createElement("span");
      text.className = "tx";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "重试";
      root.appendChild(text);
      root.appendChild(retry);
      root.addEventListener("click", (event) => onFailedMarkerRetry(event, block));
      shadow.appendChild(style);
      shadow.appendChild(root);
      // null `before` appends — for inside-placement hosts the marker becomes
      // the block's last child; the data-deepseek-translator-ui ownership
      // flags already keep it out of text collection and mutation handling.
      placement.parent.insertBefore(host, placement.before);
      failedMarkers.set(block, { host, shadow });
      updateFailedMarkerText(shadow, reason);
    } finally {
      endApplyingDom(gen);
    }
  }

  function updateFailedMarker(block, reason = "") {
    const entry = failedMarkers.get(block);
    if (!entry?.shadow || !entry.host?.isConnected) {
      return;
    }
    updateFailedMarkerText(entry.shadow, reason);
  }

  function updateFailedMarkerText(shadow, reason) {
    const text = shadow?.querySelector(".tx");
    if (!text) {
      return;
    }
    const short = shortenReason(reason);
    text.textContent = short ? `这段没翻译成功（${short}）` : "这段没翻译成功";
  }

  function removeFailedMarker(block) {
    const entry = failedMarkers.get(block);
    if (!entry) {
      return;
    }
    failedMarkers.delete(block);
    entry.host?.remove();
  }

  function clearFailedMarkers() {
    for (const block of [...failedBlocks]) {
      removeFailedMarker(block);
    }
  }

  // Marker button: retry ONLY this block. Trusted click only — this is a
  // billable action rendered in page DOM.
  function onFailedMarkerRetry(event, block) {
    if (event.isTrusted === false) {
      return;
    }
    const button = event.target?.closest?.("button.retry");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!block?.isConnected) {
      return;
    }
    void retryFailedBlocks(block);
  }

  // ---- failed-block retry (pill 重试 N 段 / marker 重试 / popup RETRY_FAILED) ----

  /**
   * Re-translate ONLY the currently failed blocks: never restoreOriginal,
   * never reset translated counts. Failure slots are replaced, not stacked
   * (the existing failedBlocks logic inside translateBlocks/
   * applyTranslatedSegment), and the requests run on the CURRENT generation
   * through the shared workQueue.
   */
  async function retryFailedBlocks(onlyBlock = null) {
    if (!state.active) {
      return;
    }
    const targets = [...failedBlocks].filter((block) =>
      block?.isConnected && (!onlyBlock || block === onlyBlock));
    if (targets.length === 0) {
      updateProgressPill();
      return;
    }
    const runId = generation;
    state.phase = "translating";
    updateProgressPill();
    notifyPopupStatus();
    // translateBlocks re-extracts each block's text exactly like the normal
    // path; the isDynamic accounting keeps retried (already-slotted) blocks
    // from double-counting state.total.
    const job = workQueue.then(() => translateBlocks(targets, runId, true, { retry: true }));
    workQueue = job.catch(() => {});
    await job;
  }

  // Same DOM event reaches both window and document capture listeners. Process
  // only the first (window) hit so a later document pass cannot overwrite a
  // good early snapshot after a page window listener poisons Selection.
  const handledSelectionEvents = new WeakSet();

  function setupSelectionTranslate() {
    // Capture on window as well as document, as early as possible: a page's
    // window-capture listener registered before ours would otherwise always
    // see (and could replace) the Selection before any listener we own runs.
    // Best-effort only — the real billable gate is the extension popup confirm.
    for (const target of [window, document]) {
      target.addEventListener("mouseup", onSelectionMaybeTranslate, true);
      target.addEventListener("keyup", onSelectionKeyUp, true);
      target.addEventListener("mousedown", onSelectionMouseDown, true);
    }
  }

  function claimSelectionEvent(event) {
    if (!event || handledSelectionEvents.has(event)) {
      return false;
    }
    handledSelectionEvents.add(event);
    return true;
  }

  function onSelectionKeyUp(event) {
    if (!claimSelectionEvent(event)) {
      return;
    }
    if (event.key === "Escape") {
      hideSelectionPanel();
      return;
    }
    if (event.key === "Shift" || event.key.startsWith("Arrow")) {
      onSelectionMaybeTranslate(event, true);
    }
  }

  function onSelectionMouseDown(event) {
    if (!claimSelectionEvent(event)) {
      return;
    }
    const host = selectionHostEl;
    if (host && (event.target === host || host.contains(event.target))) {
      return;
    }
    // A trusted outside press starts a fresh pointer gesture — drop the
    // dedupe key so re-selecting the same range translates again. This must
    // also run when the host was already removed (dismissed earlier), or a
    // stale key from the previous request dead-ends the next identical drag
    // with 该选中文本已翻译.
    // The card itself stays open on a blank-page/outside press: only ×,
    // Escape, or a new selection replacing it may close it. Billing safety is
    // unchanged — the popup confirm revalidates the live Selection against
    // the previewed gesture before anything is billed.
    if (event.isTrusted !== false) {
      lastSelectionKey = "";
    }
  }

  // True when the event's innermost target lives inside our selection panel
  // (composedPath pierces the shadow boundary; window-level listeners only see
  // the retargeted host). Panel mouseups — clicking 翻译 or × — must not be
  // treated as a fresh page selection gesture that would re-open the confirm
  // state and clobber the in-flight translation.
  function isEventInsideSelectionPanel(event) {
    const host = selectionHostEl;
    if (!host?.shadowRoot || typeof event?.composedPath !== "function") {
      return false;
    }
    try {
      const innermost = event.composedPath()[0];
      return innermost?.getRootNode?.() === host.shadowRoot;
    } catch {
      return false;
    }
  }

  function onSelectionMaybeTranslate(event, alreadyClaimed = false) {
    if (!alreadyClaimed && !claimSelectionEvent(event)) {
      return;
    }
    // Ignore synthetic page-script events that could burn the user's API key.
    if (event && event.isTrusted === false) {
      return;
    }
    if (isEventInsideSelectionPanel(event)) {
      return;
    }

    // Snapshot the selection synchronously at the trusted gesture: page script
    // can replace window.getSelection() while the debounce is pending, so only
    // this snapshot — never a post-delay read — may become the billable text.
    // A page window-capture listener registered before any of ours can still
    // poison the Selection before we see it, so the snapshot alone never bills:
    // the user must confirm in the extension popup (page-inaccessible UI).
    const gesture = captureSelectionGesture();

    // Invalidate in-flight storage awaits when the live selection actually
    // changed (keyboard mid-await). Unchanged Shift must not bump or an
    // in-flight TRANSLATE_BATCH response would be discarded. A collapse to
    // empty (blank click) must not bump either: a confirmed request is
    // already billed and its card outlives the selection — bumping here is
    // what stranded the card at loading forever.
    const snapshot = gesture ? `${gesture.text}\0${gesture.rangeId}` : "";
    if (snapshot !== lastScheduledSelectionSnapshot) {
      lastScheduledSelectionSnapshot = snapshot;
      if (snapshot) {
        // Only a NEW non-empty selection may supersede in-flight work.
        selectionGeneration += 1;
      }
    }
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    if (!gesture) {
      // Collapsed / empty / oversized at gesture time — never schedule a
      // handler that could bill a selection a page injects after the delay.
      // The card stays open (only ×/Escape/a new selection closes it); just
      // reset the dedupe key so re-selecting the same range bills again.
      lastSelectionKey = "";
      return;
    }
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      showSelectionConfirm(event, gesture);
    }, 180);
  }

  /**
   * Capture the current Selection synchronously at a trusted gesture.
   * A page window-capture listener registered before ours may already have
   * replaced the Selection — this snapshot is only a billing candidate, never
   * billed until the extension popup confirms.
   * @returns {{ text: string, rangeId: string } | null} null unless the user
   *   genuinely holds a non-collapsed selection of billable length.
   */
  // ---- input-field selection detection (COMMAND_SELECTION_TRANSLATE hint) ----

  // Input types whose value the user can select with the caret (and that
  // expose selectionStart/selectionEnd). Checkbox/radio/file/… never carry a
  // text selection; <select> is not an editable field at all.
  const TEXT_SELECTION_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", "email"]);

  // The deepest focused element, walking into OPEN shadow roots (a closed
  // root is unreachable by design — it reads as its host and cannot be a
  // textarea anyway). Pure over (activeElement, shadowRoot) so tests can
  // drive it with a fake tree.
  function deepActiveElement(root) {
    let element = (root || document).activeElement;
    let guard = 0;
    while (element && element.shadowRoot && guard < 64) {
      element = element.shadowRoot.activeElement;
      guard += 1;
    }
    return element || null;
  }

  // True when focus sits in a textarea / text-like input with a REAL
  // selection (selectionStart !== selectionEnd) — text the user selected,
  // but inside a field this extension cannot annotate in place (PR #19
  // follow-up: the no-gesture hint must explain that, not claim nothing is
  // selected).
  function activeElementHasTextSelection(root) {
    const element = deepActiveElement(root);
    if (!element) {
      return false;
    }
    const tag = element.tagName;
    const isField =
      tag === "TEXTAREA" ||
      (tag === "INPUT" && TEXT_SELECTION_INPUT_TYPES.has(String(element.type || "text").toLowerCase()));
    if (!isField) {
      return false;
    }
    try {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      return typeof start === "number" && typeof end === "number" && start !== end;
    } catch {
      // Some input types throw on selectionStart access — no selection then.
      return false;
    }
  }

  function captureSelectionGesture() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const text = selection.toString().replace(/\s+/gu, " ").trim();
    if (text.length < 2 || text.length > 5000) {
      return null;
    }
    const rangeId = getSelectionRangeIdentity(selection);
    return rangeId ? { text, rangeId } : null;
  }

  function isSelectionSendRateLimited(now = Date.now()) {
    while (
      selectionSendTimes.length > 0 &&
      now - selectionSendTimes[0] >= SELECTION_SEND_WINDOW_MS
    ) {
      selectionSendTimes.shift();
    }
    const last = selectionSendTimes[selectionSendTimes.length - 1];
    if (last !== undefined && now - last < SELECTION_SEND_MIN_INTERVAL_MS) {
      return true;
    }
    return selectionSendTimes.length >= SELECTION_SEND_WINDOW_LIMIT;
  }

  function isSelectionInsideTranslatorUi(selection, event) {
    // Owned ref only — a page element carrying our host id must not influence
    // whether we treat a selection as extension UI.
    const host = selectionHostEl;
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
      // Marker attribute only — our host carries it; a page id impostor does not.
      if (el?.closest?.("[data-deepseek-translator-ui]")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Open the page panel as a non-billable preview for a gesture snapshot.
   * The panel lives in the page DOM behind an open shadow root, so it can
   * never be a billing-consent surface: it previews the selection and hints
   * at the trusted entries (Alt+T / context menu / popup fallback confirm).
   * SELECTION_TRANSLATE_BATCH fires only after COMMAND_SELECTION_TRANSLATE
   * (trusted browser gesture) or the popup confirm
   * (CONFIRM_SELECTION_TRANSLATE), and sendSelectionTranslation revalidates
   * the live Selection against the gesture snapshot before anything is billed.
   */
  function showSelectionConfirm(event, gesture) {
    // The gesture snapshot taken synchronously at the trusted event is the
    // only billable payload (defensive — scheduling always passes one).
    if (!gesture?.text || !gesture.rangeId) {
      lastSelectionKey = "";
      hideSelectionPanel();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      // Real selection change (collapse / clear) — allow the same words again
      // later. The card stays open per the dismissal rules (×/Escape/new
      // selection); nothing new is previewed for the collapsed selection.
      lastSelectionKey = "";
      return;
    }

    if (isSelectionInsideTranslatorUi(selection, event)) {
      return;
    }

    // Require the live Selection to still be exactly what the user held at the
    // trusted gesture: text swapped in by page script during the debounce must
    // never reach the preview (or the later TRANSLATE_BATCH). Any rejection
    // clears the prior key so reselecting a previously translated range is not
    // silently no-op'd by stale dedupe. The card itself keeps its last state.
    if (
      selection.toString().replace(/\s+/gu, " ").trim() !== gesture.text ||
      getSelectionRangeIdentity(selection) !== gesture.rangeId
    ) {
      lastSelectionKey = "";
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

    // Preview-only: showing this page panel never bills — the panel is
    // page-hosted DOM and cannot be a consent surface. Billing happens via the
    // trusted browser entries (Alt+T command / context menu →
    // COMMAND_SELECTION_TRANSLATE) or the extension popup's confirm
    // (CONFIRM_SELECTION_TRANSLATE), always bound to this stored gesture
    // snapshot.
    pendingSelectionGesture = gesture;
    const panel = ensureSelectionPanel();
    positionSelectionPanel(panel, rect);
    setSelectionPanelState(panel, "confirm", "", gesture.text);
    try {
      void chrome.runtime.sendMessage({
        type: "SET_PENDING_SELECTION",
        text: gesture.text,
        rangeId: gesture.rangeId
      });
    } catch {
      // Service worker may be waking; popup can still fail closed without pending.
    }
  }

  /**
   * Billable selection path — runs only after a TRUSTED trigger:
   * COMMAND_SELECTION_TRANSLATE (Alt+T command / context menu, relayed by the
   * background) or the extension-popup confirm (CONFIRM_SELECTION_TRANSLATE),
   * always with the stored gesture snapshot (never a fresh selection read).
   * Never triggered by page-DOM controls. Guard rejections resolve to
   * { ok: false, error } so the caller learns the confirm did not produce a
   * translation; only superseded requests (a newer selection generation
   * claimed the slot) resolve without a rejection.
   */
  async function sendSelectionTranslation(gesture) {
    // The gesture snapshot the panel previewed is the only billable payload.
    if (!gesture?.text || !gesture.rangeId) {
      lastSelectionKey = "";
      hideSelectionPanel();
      return { ok: false, error: "没有待确认的划词翻译" };
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      // Real selection change (collapse / clear) — allow the same words again later.
      lastSelectionKey = "";
      hideSelectionPanel();
      return { ok: false, error: "划词已收起，请重新选中后确认" };
    }

    // Require the live Selection to still be exactly what the panel previewed:
    // text swapped in by page script since popup confirm must never reach
    // SELECTION_TRANSLATE_BATCH even though the popup click itself is trusted.
    if (
      selection.toString().replace(/\s+/gu, " ").trim() !== gesture.text ||
      getSelectionRangeIdentity(selection) !== gesture.rangeId
    ) {
      lastSelectionKey = "";
      hideSelectionPanel();
      return { ok: false, error: "划词已变化，请重新选中后确认" };
    }

    if (isSelectionInsideTranslatorUi(selection)) {
      return { ok: false, error: "划词位于扩展界面内，请重新选择页面文本" };
    }

    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return { ok: false, error: "无法定位划词位置，请重新选中后确认" };
    }

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return { ok: false, error: "无法定位划词位置，请重新选中后确认" };
    }

    // Snapshot only — do not bump yet so an unchanged Shift release cannot
    // cancel an in-flight translation for the same selection.
    const gate = selectionGeneration;
    let requestId = 0;

    try {
      // Array form (only present keys come back): "per-provider key field
      // absent" (a <=1.3.x store that never had them) must stay
      // distinguishable from "present but empty" (the user cleared the key) —
      // a defaults-object read would fill absent key fields with "" and
      // re-arm the legacy apiKey fallback below for every cleared key.
      // provider/targetLanguage/model are absent-safe through the fallbacks
      // applied where they are read.
      const stored = await chrome.storage.local.get([
        "provider",
        "targetLanguage",
        "model",
        "deepseekApiKey",
        "kimiApiKey",
        "apiKey"
      ]);

      // Dismiss / newer work during the storage await.
      if (gate !== selectionGeneration) {
        return;
      }

      // Revalidate live Selection — keyboard changes may not bump via mousedown.
      const liveSel = window.getSelection();
      if (!liveSel || liveSel.isCollapsed || liveSel.rangeCount === 0) {
        lastSelectionKey = "";
        hideSelectionPanel();
        return { ok: false, error: "划词已收起，请重新选中后确认" };
      }
      const liveText = liveSel.toString().replace(/\s+/gu, " ").trim();
      const liveRangeId = getSelectionRangeIdentity(liveSel);
      // Compare against the gesture snapshot (the payload that would be sent);
      // its 2..5000 bounds are already guaranteed by captureSelectionGesture.
      if (liveText !== gesture.text || liveRangeId !== gesture.rangeId) {
        lastSelectionKey = "";
        hideSelectionPanel();
        return { ok: false, error: "划词已变化，请重新选中后确认" };
      }
      try {
        rect = liveSel.getRangeAt(0).getBoundingClientRect();
      } catch {
        lastSelectionKey = "";
        hideSelectionPanel();
        return { ok: false, error: "无法定位划词位置，请重新选中后确认" };
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        lastSelectionKey = "";
        hideSelectionPanel();
        return { ok: false, error: "无法定位划词位置，请重新选中后确认" };
      }

      // Keep selection provider/target/model local — never clobber pinned page-run state.
      const provider = stored.provider === "kimi" ? "kimi" : "deepseek";
      const targetLanguage = stored.targetLanguage || state.targetLanguage;
      const model = Utils.migrateModelName(stored.model) || state.model;

      if (!Utils.isTranslatableText(gesture.text, targetLanguage)) {
        // Range changed to non-translatable text — drop stale dedupe key.
        lastSelectionKey = "";
        hideSelectionPanel();
        return { ok: false, error: "选中文本无需翻译" };
      }

      // Deduplicate unchanged selections (e.g. standalone Shift release) before
      // bumping generation or issuing another billable TRANSLATE_BATCH.
      // Include range identity so the same words elsewhere (or a fresh re-select
      // after collapse) still reopen/reposition the panel.
      const selectionKey = `${targetLanguage}\0${model}\0${gesture.text}\0${liveRangeId}`;
      if (selectionKey === lastSelectionKey) {
        // Already billed this exact selection — popup confirm must not
        // dead-end silently, but it must not re-bill either.
        const panel = ensureSelectionPanel();
        setSelectionPanelState(panel, "success", "该选中文本已翻译");
        return;
      }

      // Claim + bump atomically (no await between) so overlapping handlers
      // cannot double-bill the same selection.
      lastSelectionKey = selectionKey;
      selectionGeneration += 1;
      requestId = selectionGeneration;

      const panel = ensureSelectionPanel();
      positionSelectionPanel(panel, rect);
      setSelectionPanelState(panel, "loading", "正在翻译选中文本…");

      // Gate on the SELECTED provider's key, not the legacy apiKey mirror:
      // the mirror is written best-effort by popup views and can lag a
      // provider switch (kimi selected with a valid kimiApiKey but a stale
      // or empty mirror would block, or a stale mirror would let a
      // key-less provider through). The legacy single-key field is honored
      // only on a <=1.3.x store where NEITHER per-provider key field exists.
      const providerKeyField = provider === "kimi" ? "kimiApiKey" : "deepseekApiKey";
      const legacyKeyStore = !("deepseekApiKey" in stored) && !("kimiApiKey" in stored);
      const gateKey = legacyKeyStore ? stored.apiKey : stored[providerKeyField];
      if (!String(gateKey || "").trim()) {
        lastSelectionKey = "";
        // keyGate renders "还没有配置 API Key" + the 打开设置 exit (non-billable
        // button); the message/reply keep the canonical gate error string.
        setSelectionPanelState(panel, "error", "请先在扩展弹窗中填写 API Key", "", { keyGate: true });
        return { ok: false, error: "请先在扩展弹窗中填写 API Key" };
      }

      // Worker-side SELECTION_TRANSLATE_BATCH enforces the 1s / 8-per-10s quota
      // (page DOM cannot bypass it). Full-page TRANSLATE_BATCH is never limited.
      const response = await chrome.runtime.sendMessage({
        type: "SELECTION_TRANSLATE_BATCH",
        texts: [gesture.text],
        provider,
        targetLanguage,
        model
      });

      if (requestId !== selectionGeneration) {
        return;
      }

      // Revalidate the live Selection after the network await (same pattern as
      // the storage await) — never publish a stale translation into a CHANGED
      // selection. A merely collapsed/cleared selection (blank click after
      // confirm) must NOT discard: the request was consented in the popup and
      // is already billed, so its lifecycle belongs to the card, which stays
      // open per the dismissal rules. `gesture.text` / `gesture.rangeId` are
      // what was sent.
      const postNetworkSel = window.getSelection();
      const selectionGone = !postNetworkSel || postNetworkSel.isCollapsed || postNetworkSel.rangeCount === 0;
      if (!selectionGone) {
        const postNetworkText = postNetworkSel.toString().replace(/\s+/gu, " ").trim();
        const postNetworkRangeId = getSelectionRangeIdentity(postNetworkSel);
        if (postNetworkText !== gesture.text || postNetworkRangeId !== gesture.rangeId) {
          // Page script changed the range without a handled input event, or a
          // genuinely new selection claimed the slot (its own bump already
          // failed the requestId check above) — clear the claimed key and hide
          // the panel.
          lastSelectionKey = "";
          hideSelectionPanel();
          return { ok: false, error: "划词已变化，译文已丢弃" };
        }
      }

      if (!response?.ok) {
        throw new Error(response?.error || "翻译失败");
      }

      const translation = String(response.translations?.[0] || "").trim();
      if (!translation) {
        throw new Error("未返回译文");
      }

      setSelectionPanelState(panel, "success", translation, gesture.text);
      // The popup confirm one-shots the worker-side pending before the
      // content message runs; clear again defensively so no replaced pending
      // can leave a stale badge the popup would confirm against.
      try {
        void chrome.runtime.sendMessage({ type: "CLEAR_PENDING_SELECTION" });
      } catch {
        // Worker may be asleep; the pending one-shots on its own.
      }
    } catch (error) {
      if (requestId && requestId !== selectionGeneration) {
        return;
      }
      // Allow retry after a failed attempt for the same selection.
      lastSelectionKey = "";
      const panel = ensureSelectionPanel();
      setSelectionPanelState(panel, "error", error.message || "翻译失败");
      // The popup must learn the confirm did not produce a translation.
      return { ok: false, error: error.message || "翻译失败" };
    }
  }

  function ensureSelectionPanel() {
    // Never trust getElementById alone — a page element may carry the same id
    // (or adopt ours). Reuse only a host we can prove we own: our marker plus a
    // shadow root. The module-level ref keeps hide/dismiss on the owned node.
    if (
      selectionHostEl?.isConnected &&
      selectionHostEl.shadowRoot &&
      selectionHostEl.dataset.deepseekTranslatorUi === "true"
    ) {
      selectionHostEl.hidden = false;
      return selectionHostEl;
    }

    // Re-injection fallback: adopt only a marked, shadow-bearing host (ours
    // from a previous injection); a page impostor with the same id never matches.
    const candidate = document.getElementById("kilocean-selection-host");
    if (candidate?.shadowRoot && candidate.dataset.deepseekTranslatorUi === "true") {
      selectionHostEl = candidate;
      candidate.hidden = false;
      return candidate;
    }

    const host = document.createElement("div");
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
    selectionHostEl = host;

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        /* ---- selection bubble · light theme (CONTRACT 1.5.0 tokens: #fff
           card, #111827 text, #4B5563 secondary, #6B7280 muted, brand
           #3D5AFE, err #C62828, radius 12, shadow 0 8px 24px rgba(17,24,39,.12)) ---- */
        .panel {
          width: min(360px, calc(100vw - 24px));
          padding: 12px 12px 10px;
          color: #111827;
          background: #ffffff;
          border: 1px solid #E5E7EB;
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(17, 24, 39, 0.12);
          font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
        }
        .top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .label {
          color: #6B7280;
          font-size: 11px;
        }
        .close {
          border: 0;
          background: transparent;
          color: #6B7280;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          padding: 4px 6px;
        }
        .close:hover { color: #111827; }
        .source {
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 72px;
          overflow: auto;
          color: #4B5563;
          font-size: 12px;
        }
        .source[hidden] { display: none; }
        .body {
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 220px;
          overflow: auto;
        }
        .body[hidden] { display: none; }
        .body.loading { color: #4B5563; }
        .body.error { color: #C62828; }
        .body.hint { color: #111827; }
        .hint {
          margin-top: 8px;
          color: #4B5563;
          font-size: 11.5px;
        }
        .hint[hidden] { display: none; }
        .actions {
          margin-top: 10px;
          display: flex;
          gap: 8px;
        }
        .actions[hidden] { display: none; }
        .actions .settings {
          height: 28px;
          padding: 0 12px;
          border: 0;
          border-radius: 8px;
          background: #3D5AFE;
          color: #fff;
          font: inherit;
          cursor: pointer;
        }
        .actions .settings:hover { background: #2F48D8; }
      </style>
      <div class="panel" role="dialog" aria-label="选中翻译">
        <div class="top">
          <span class="label">千浩翻译 · 划词</span>
          <button class="close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="source" hidden></div>
        <div class="body loading">正在翻译选中文本…</div>
        <div class="hint" hidden>按 Alt+T 翻译选中文字 · 右键也可以</div>
        <div class="actions" hidden><button class="settings" type="button">打开设置</button></div>
      </div>
    `;

    shadow.querySelector(".close").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideSelectionPanel();
    });

    // Clicking into the panel must not collapse the page selection: the
    // popup confirm still revalidates the live Selection against the
    // previewed gesture, so a panel tap losing the selection would dead-end
    // the confirm with 划词已收起.
    shadow.querySelector(".panel").addEventListener("mousedown", (event) => {
      if (event.target?.closest?.(".close")) {
        return;
      }
      event.preventDefault();
    });

    // Non-billable exit for key-gate errors: 打开设置 just asks the background
    // to open the settings view (harmless even if a page forges the click —
    // trusted-click gated anyway). Still deliberately NO translate button
    // here: the panel is page-hosted DOM behind an open shadow root, so page
    // script could restyle or overlay any button and a trusted click on it
    // would not establish informed consent. Billing consent stays with the
    // trusted browser entries: popup confirm (CONFIRM_SELECTION_TRANSLATE →
    // sendSelectionTranslation) and Alt+T / context menu
    // (COMMAND_SELECTION_TRANSLATE), both arriving via runtime.onMessage.
    shadow.querySelector(".settings").addEventListener("click", (event) => {
      if (event.isTrusted === false) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openSettingsForKey();
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
    const estimatedHeight = 170;
    const below = rect.bottom + 10;
    const top = below + estimatedHeight > window.innerHeight
      ? Math.max(margin, rect.top - 10 - estimatedHeight)
      : below;

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  // No-rect positioning for the COMMAND_SELECTION_TRANSLATE hint state: near
  // the viewport top-right, never over the selection the user is about to make.
  function positionSelectionPanelTopRight(host) {
    const panelWidth = Math.min(360, window.innerWidth - 24);
    host.style.left = `${Math.round(Math.max(12, window.innerWidth - panelWidth - 16))}px`;
    host.style.top = "16px";
  }

  // Non-billable hint bubble: Alt+T / context menu arrived with nothing (or
  // only frame-inaccessible text) selected. Pure guidance — no request. The
  // optional message overrides the generic copy (the input-field case).
  function showSelectionHintPanel(message) {
    const panel = ensureSelectionPanel();
    positionSelectionPanelTopRight(panel);
    setSelectionPanelState(
      panel,
      "hint",
      message || "先选中要翻译的文字，再按 Alt+T 或右键「翻译选中文字」"
    );
  }

  function setSelectionPanelState(host, tone, message, sourceText, options = {}) {
    const body = host.shadowRoot.querySelector(".body");
    const source = host.shadowRoot.querySelector(".source");
    const hint = host.shadowRoot.querySelector(".hint");
    const actions = host.shadowRoot.querySelector(".actions");
    body.className = `body ${tone}`;
    // Key-gate failures render the friendly "还没有配置 API Key" copy plus the
    // 打开设置 exit; `message` stays the canonical gate error string that the
    // popup/background (and ci-check) rely on.
    body.textContent = options.keyGate ? "还没有配置 API Key" : message;
    // Confirm/preview state: show the selected text plus the Alt+T hint. The
    // panel itself holds no billable control — consent lives in the trusted
    // extension surfaces only.
    body.hidden = tone === "confirm";
    if ((tone === "confirm" || tone === "success") && sourceText) {
      source.hidden = false;
      source.textContent = sourceText;
    } else {
      source.hidden = true;
      source.textContent = "";
    }
    if (hint) {
      hint.hidden = tone !== "confirm";
    }
    if (actions) {
      actions.hidden = !options.keyGate;
    }
    host.hidden = false;
  }

  function getSelectionNodeId(node) {
    if (!node) {
      return "0";
    }
    let id = selectionNodeIds.get(node);
    if (!id) {
      id = String(nextSelectionNodeId);
      nextSelectionNodeId += 1;
      selectionNodeIds.set(node, id);
    }
    return id;
  }

  function getSelectionRangeIdentity(selection) {
    try {
      const range = selection.getRangeAt(0);
      return [
        getSelectionNodeId(range.startContainer),
        String(range.startOffset),
        getSelectionNodeId(range.endContainer),
        String(range.endOffset)
      ].join(":");
    } catch {
      return "";
    }
  }

  function hideSelectionPanel() {
    // Invalidate any in-flight selection send so a late response cannot reopen the panel.
    selectionGeneration += 1;
    // Dismissal (×/Escape/outside press) must never leave a confirm pending.
    pendingSelectionGesture = null;
    try {
      void chrome.runtime.sendMessage({ type: "CLEAR_PENDING_SELECTION" });
    } catch {
      // Ignore — worker may be asleep.
    }
    // Keep lastSelectionKey so ×/Escape dismiss does not allow Shift to rebill
    // the same unchanged selection; cleared on failure / real selection change.
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    // Fully remove the card and drop our ref: listeners, shadow content and
    // page-visible chrome all go away; ensureSelectionPanel rebuilds on demand.
    const host = selectionHostEl;
    selectionHostEl = null;
    host?.remove();
  }
})();
