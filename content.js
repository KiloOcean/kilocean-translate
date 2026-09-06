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
  const originalTexts = new Map();
  const lastAppliedTexts = new WeakMap();
  const pendingRoots = new Set();

  let mutationObserver = null;
  let dynamicTimer = null;
  let workQueue = Promise.resolve();
  let generation = 0;
  let toastTimer = null;

  const state = {
    active: false,
    phase: "idle",
    translated: 0,
    total: 0,
    failed: 0,
    error: "",
    targetLanguage: "zh-CN",
    model: "deepseek-v4-flash"
  };

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
        setTimeout(() => window.print(), 80);
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

    if (state.active && state.targetLanguage === targetLanguage && state.phase === "translating") {
      return;
    }

    if (originalTexts.size > 0) {
      restoreOriginal();
    }

    generation += 1;
    const runId = generation;
    Object.assign(state, {
      active: true,
      phase: "translating",
      translated: 0,
      total: 0,
      failed: 0,
      error: "",
      targetLanguage,
      model
    });

    showToast("正在识别网页内容…", "loading");
    startObserving();

    const nodes = collectTextNodes(document.body || document.documentElement);
    state.total = nodes.length;

    if (nodes.length === 0) {
      state.phase = "translated";
      showToast("没有发现需要翻译的内容", "info");
      return;
    }

    await translateNodes(nodes, runId, false);
    if (runId !== generation) {
      return;
    }

    state.phase = state.failed > 0 && state.translated === 0 ? "error" : "translated";
    if (state.phase === "error") {
      showToast(state.error || "翻译失败", "error", 6000);
    } else if (state.failed > 0) {
      showToast(`已翻译 ${state.translated} 条，${state.failed} 条失败`, "warning", 5000);
    } else {
      showToast(`已翻译 ${state.translated} 条内容`, "success");
    }
  }

  function restoreOriginal() {
    generation += 1;
    stopObserving();

    for (const [node, original] of originalTexts) {
      if (!node.isConnected) {
        continue;
      }
      const lastApplied = lastAppliedTexts.get(node);
      if (lastApplied === undefined || node.data === lastApplied) {
        node.data = original;
      }
    }

    originalTexts.clear();
    pendingRoots.clear();
    Object.assign(state, {
      active: false,
      phase: "idle",
      translated: 0,
      total: 0,
      failed: 0,
      error: ""
    });
    showToast("已恢复原文", "info");
  }

  function collectTextNodes(root) {
    if (!root || !root.isConnected) {
      return [];
    }

    if (root.nodeType === Node.TEXT_NODE) {
      return shouldTranslateNode(root) ? [root] : [];
    }

    const nodes = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return shouldTranslateNode(node)
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

  function shouldTranslateNode(node) {
    if (!node?.parentElement || originalTexts.has(node)) {
      return false;
    }

    const parent = node.parentElement;
    if (BLOCKED_TAGS.has(parent.tagName)) {
      return false;
    }

    if (parent.closest('[translate="no"], [contenteditable="true"], [data-deepseek-translator-ui]')) {
      return false;
    }

    if (!Utils.isTranslatableText(node.data, state.targetLanguage)) {
      return false;
    }

    const style = getComputedStyle(parent);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  async function translateNodes(nodes, runId, isDynamic) {
    const uniqueNodes = [...new Set(nodes)].filter((node) => shouldTranslateNode(node));
    if (uniqueNodes.length === 0 || runId !== generation) {
      return;
    }

    if (isDynamic) {
      state.phase = "translating";
      state.total += uniqueNodes.length;
      showToast("正在翻译新加载的内容…", "loading");
    }

    const segments = uniqueNodes.map((node) => ({ node, text: node.data }));
    const batches = Utils.chunkSegments(segments, 5000, 24);

    for (const batch of batches) {
      if (runId !== generation) {
        return;
      }
      await translateBatchWithFallback(batch, runId);
    }

    if (isDynamic && runId === generation) {
      state.phase = "translated";
      showToast("新内容已翻译", "success");
    }
  }

  async function translateBatchWithFallback(batch, runId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        texts: batch.map((segment) => segment.text),
        targetLanguage: state.targetLanguage,
        model: state.model
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
        if (!segment.node.isConnected || segment.node.data !== segment.text) {
          return;
        }

        const rendered = Utils.preserveWhitespace(segment.text, translation);
        originalTexts.set(segment.node, segment.text);
        lastAppliedTexts.set(segment.node, rendered);
        segment.node.data = rendered;
        state.translated += 1;
      });
    } catch (error) {
      if (error.canSplit && batch.length > 1 && runId === generation) {
        const middle = Math.ceil(batch.length / 2);
        await translateBatchWithFallback(batch.slice(0, middle), runId);
        await translateBatchWithFallback(batch.slice(middle), runId);
        return;
      }

      state.failed += batch.length;
      state.error = error.message;
    }
  }

  function startObserving() {
    stopObserving();
    mutationObserver = new MutationObserver((records) => {
      if (!state.active) {
        return;
      }

      for (const record of records) {
        if (record.type === "childList") {
          record.addedNodes.forEach((node) => pendingRoots.add(node));
          continue;
        }

        if (record.type === "characterData") {
          const node = record.target;
          const lastApplied = lastAppliedTexts.get(node);
          if (lastApplied !== undefined && node.data === lastApplied) {
            continue;
          }

          if (originalTexts.has(node)) {
            originalTexts.delete(node);
            lastAppliedTexts.delete(node);
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
      const roots = [...pendingRoots];
      pendingRoots.clear();
      const nodes = roots.flatMap((root) => collectTextNodes(root));
      const runId = generation;
      workQueue = workQueue.then(() => translateNodes(nodes, runId, true));
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
      targetLanguage: state.targetLanguage
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
      "script, iframe, object, embed, [data-deepseek-translator-ui], #deepseek-translator-toast-host"
    ).forEach((element) => element.remove());
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
    generator.setAttribute("content", "千浩翻译 · Kilocean Translate 1.2.0");
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
})();
