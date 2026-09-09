"use strict";

const Utils = globalThis.DeepSeekTranslatorUtils;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "deepseek-v4-flash",
  targetLanguage: "zh-CN",
  displayMode: Utils.DISPLAY_MODES.bilingual
};

const elements = {
  apiKey: document.getElementById("api-key"),
  targetLanguage: document.getElementById("target-language"),
  model: document.getElementById("model"),
  toggleKey: document.getElementById("toggle-key"),
  testConnection: document.getElementById("test-connection"),
  translate: document.getElementById("translate"),
  restore: document.getElementById("restore"),
  exportHtml: document.getElementById("export-html"),
  printPdf: document.getElementById("print-pdf"),
  statusCard: document.querySelector(".status-card"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
  modeButtons: [...document.querySelectorAll(".mode-button")],
  selectionConfirmPanel: document.getElementById("selection-confirm-panel"),
  selectionConfirmText: document.getElementById("selection-confirm-text"),
  selectionConfirmBtn: document.getElementById("selection-confirm-btn"),
  selectionConfirmDismiss: document.getElementById("selection-confirm-dismiss")
};

let currentTab = null;
let statusTimer = null;
let currentDisplayMode = Utils.DISPLAY_MODES.bilingual;
let initialized = false;
let displayModeOp = 0;
/** @type {{ text: string, rangeId: string } | null} */
let pendingSelection = null;

initialize().catch((error) => setStatus("无法初始化", error.message, "error"));

// Keep radiogroup in sync when content coerces original→bilingual mid-start.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.displayMode) {
    return;
  }
  const nextMode = Utils.normalizeDisplayMode(changes.displayMode.newValue);
  if (nextMode !== currentDisplayMode) {
    currentDisplayMode = nextMode;
    renderDisplayMode();
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "CONTENT_STATUS" || !message.status) {
    return;
  }
  // Ignore status from other tabs while this popup is bound to currentTab.
  if (
    sender?.tab?.id != null &&
    currentTab?.id != null &&
    sender.tab.id !== currentTab.id
  ) {
    return;
  }
  if (message.status.displayMode) {
    const nextMode = Utils.normalizeDisplayMode(message.status.displayMode);
    if (nextMode !== currentDisplayMode) {
      currentDisplayMode = nextMode;
      renderDisplayMode();
    }
  }
  renderTranslationStatus(message.status);
  if (message.status.active && message.status.phase === "translating") {
    startStatusPolling();
  }
});


elements.selectionConfirmBtn.addEventListener("click", () => {
  void confirmPendingSelection();
});

elements.selectionConfirmDismiss.addEventListener("click", () => {
  void dismissPendingSelection();
});

elements.toggleKey.addEventListener("click", () => {
  const revealing = elements.apiKey.type === "password";
  elements.apiKey.type = revealing ? "text" : "password";
  elements.toggleKey.textContent = revealing ? "隐藏" : "显示";
  elements.toggleKey.setAttribute("aria-label", revealing ? "隐藏 API Key" : "显示 API Key");
});

// Persist settings as the user edits so selection translate reads fresh storage
// without requiring Test Connection / full-page Translate first.
let persistTimer = null;
function schedulePersistSettings() {
  if (!initialized) {
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!initialized) {
      return;
    }
    void saveSettings();
  }, 200);
}

function persistSettingsNow() {
  if (!initialized) {
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  void saveSettings();
}

elements.apiKey.addEventListener("input", schedulePersistSettings);
elements.apiKey.addEventListener("change", persistSettingsNow);
elements.apiKey.addEventListener("blur", persistSettingsNow);
elements.targetLanguage.addEventListener("change", persistSettingsNow);
elements.model.addEventListener("change", persistSettingsNow);
window.addEventListener("pagehide", persistSettingsNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    persistSettingsNow();
  }
});

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const mode = Utils.normalizeDisplayMode(button.dataset.mode);
    const op = ++displayModeOp;
    currentDisplayMode = mode;
    renderDisplayMode();
    await chrome.storage.local.set({ displayMode: mode });
    if (op !== displayModeOp || mode !== currentDisplayMode) {
      return;
    }

    if (!currentTab?.id) {
      return;
    }

    try {
      await ensureContentScript(currentTab.id);
      if (op !== displayModeOp || mode !== currentDisplayMode) {
        return;
      }
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        type: "SET_DISPLAY_MODE",
        displayMode: mode
      });
      if (op !== displayModeOp || mode !== currentDisplayMode) {
        return;
      }
      if (response?.ok) {
        if (response.status?.displayMode) {
          currentDisplayMode = Utils.normalizeDisplayMode(response.status.displayMode);
          renderDisplayMode();
        }
        renderTranslationStatus(response.status);
      }
    } catch {
      // Page may not allow injection yet; mode is still saved for next translate.
    }
  });
});

elements.testConnection.addEventListener("click", async () => {
  if (!validateApiKey()) {
    return;
  }

  elements.testConnection.disabled = true;
  elements.testConnection.textContent = "正在测试…";
  setStatus("正在连接 DeepSeek", "发送一条最小测试请求", "loading");

  try {
    const settings = await saveSettings();
    const response = await chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      targetLanguage: settings.targetLanguage,
      model: settings.model
    });

    if (!response?.ok) {
      throw new Error(response?.error || "连接测试失败");
    }
    setStatus("连接成功", "API Key 与模型均可正常使用", "success");
  } catch (error) {
    setStatus("连接失败", error.message, "error");
  } finally {
    elements.testConnection.disabled = false;
    elements.testConnection.textContent = "测试 API 连接";
  }
});

elements.translate.addEventListener("click", async () => {
  if (!validateApiKey()) {
    return;
  }

  elements.translate.disabled = true;
  setStatus("正在启动翻译", "识别当前页面中的段落内容", "loading");

  try {
    const settings = await saveSettings();
    await ensureContentScript(currentTab.id);
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      type: "START_TRANSLATION",
      options: {
        targetLanguage: settings.targetLanguage,
        model: settings.model,
        displayMode: settings.displayMode
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "无法启动翻译");
    }
    if (response.status?.displayMode) {
      currentDisplayMode = Utils.normalizeDisplayMode(response.status.displayMode);
      renderDisplayMode();
    }
    renderTranslationStatus(response.status);
    startStatusPolling();
  } catch (error) {
    setStatus("无法翻译此页面", toFriendlyPageError(error), "error");
  } finally {
    elements.translate.disabled = false;
  }
});

elements.restore.addEventListener("click", async () => {
  try {
    await ensureContentScript(currentTab.id);
    const response = await chrome.tabs.sendMessage(currentTab.id, { type: "RESTORE_ORIGINAL" });
    if (!response?.ok) {
      throw new Error("恢复失败");
    }
    // Preserve the user's displayMode preference in chrome.storage and the radiogroup.
    if (response.status?.displayMode) {
      currentDisplayMode = Utils.normalizeDisplayMode(response.status.displayMode);
      renderDisplayMode();
    }
    renderTranslationStatus(response.status);
    stopStatusPolling();
  } catch {
    setStatus("当前页面尚未翻译", "点击“翻译当前网页”开始，或划词翻译", "idle");
  }
});

elements.exportHtml.addEventListener("click", async () => {
  await runExportAction(
    "EXPORT_HTML",
    "正在生成 HTML",
    (response) => `已下载 ${response.filename || "翻译页面"}`
  );
});

elements.printPdf.addEventListener("click", async () => {
  await runExportAction(
    "PRINT_PAGE",
    "正在打开打印窗口",
    () => "请在打印窗口中选择“另存为 PDF”"
  );
});

async function initialize() {
  const [settings, tabs] = await Promise.all([
    chrome.storage.local.get(DEFAULT_SETTINGS),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  currentTab = tabs[0];
  elements.apiKey.value = settings.apiKey;
  elements.targetLanguage.value = settings.targetLanguage;
  elements.model.value = settings.model;
  currentDisplayMode = Utils.normalizeDisplayMode(settings.displayMode);
  renderDisplayMode();
  // Controls now mirror storage — safe to persist on hide/unload.
  initialized = true;

  if (!currentTab?.id) {
    throw new Error("找不到当前标签页");
  }

  try {
    await ensureContentScript(currentTab.id);
    const response = await chrome.tabs.sendMessage(currentTab.id, { type: "GET_STATUS" });
    if (response?.ok) {
      // Prefer chrome.storage (already loaded above). Fresh injects answer GET_STATUS
      // before their storage callback, so adopting content's default would clobber
      // the user's saved displayMode. Only sync from content when translation is active.
      if (response.status.active && response.status.displayMode) {
        currentDisplayMode = Utils.normalizeDisplayMode(response.status.displayMode);
        renderDisplayMode();
      }
      renderTranslationStatus(response.status);
      if (response.status.active) {
        startStatusPolling();
      }
    }
  } catch {
    // Restricted pages cannot be injected.
  }

  await refreshPendingSelection();
}

async function saveSettings() {
  const settings = {
    apiKey: elements.apiKey.value.trim(),
    targetLanguage: elements.targetLanguage.value,
    model: elements.model.value,
    displayMode: Utils.normalizeDisplayMode(currentDisplayMode)
  };
  await chrome.storage.local.set(settings);
  return settings;
}

function renderDisplayMode() {
  elements.modeButtons.forEach((button) => {
    const active = button.dataset.mode === currentDisplayMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function validateApiKey() {
  if (elements.apiKey.value.trim()) {
    return true;
  }
  elements.apiKey.focus();
  setStatus("缺少 API Key", "请先填写 DeepSeek API Key", "error");
  return false;
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" });
    if (response?.ok) {
      return;
    }
  } catch {
    // Inject below.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared.js", "content.js"]
  });
}

function startStatusPolling() {
  stopStatusPolling();
  statusTimer = setInterval(async () => {
    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { type: "GET_STATUS" });
      if (response?.ok) {
        if (response.status?.displayMode) {
          const nextMode = Utils.normalizeDisplayMode(response.status.displayMode);
          if (nextMode !== currentDisplayMode) {
            currentDisplayMode = nextMode;
            renderDisplayMode();
          }
        }
        renderTranslationStatus(response.status);
      }
    } catch {
      stopStatusPolling();
    }
  }, 700);
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function renderTranslationStatus(status) {
  updateExportAvailability(status);

  if (!status?.active) {
    setStatus("准备就绪", "可整页翻译，或在页面上划词查看译文", "idle");
    return;
  }

  if (status.phase === "translating") {
    const progress = status.total > 0
      ? `已完成 ${status.translated} / ${status.total} 段`
      : "正在识别网页内容";
    setStatus("正在翻译", progress, "loading");
    return;
  }

  if (status.phase === "error") {
    setStatus("翻译失败", status.error || "请检查 API 设置后重试", "error");
    return;
  }

  const failureText = status.failed > 0 ? `，${status.failed} 段失败` : "";
  const modeLabel = {
    bilingual: "双语对照",
    "translation-only": "仅译文",
    original: "原文"
  }[status.displayMode] || "双语对照";
  setStatus("翻译已开启", `已翻译 ${status.translated} 段${failureText} · ${modeLabel} · 自动跟译新内容`, "success");
}

async function runExportAction(type, pendingTitle, successDetail) {
  const button = type === "EXPORT_HTML" ? elements.exportHtml : elements.printPdf;
  button.disabled = true;
  setStatus(pendingTitle, "正在读取当前页面的译文", "loading");

  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { type });
    if (!response?.ok) {
      throw new Error(response?.error || "导出失败");
    }
    setStatus(type === "EXPORT_HTML" ? "HTML 已保存" : "打印窗口已打开", successDetail(response), "success");
  } catch (error) {
    setStatus("无法导出", toFriendlyPageError(error), "error");
  } finally {
    button.disabled = false;
  }
}

function updateExportAvailability(status) {
  const canExport = Boolean(
    status?.active &&
    status.translated > 0 &&
    status.phase !== "translating"
  );
  elements.exportHtml.disabled = !canExport;
  elements.printPdf.disabled = !canExport;
}

function setStatus(title, detail, tone) {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusCard.dataset.tone = tone;
}


async function refreshPendingSelection() {
  pendingSelection = null;
  hideSelectionConfirmPanel();
  if (!currentTab?.id) {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PENDING_SELECTION",
      tabId: currentTab.id
    });
    if (response?.ok && response.pending?.text && response.pending?.rangeId) {
      pendingSelection = {
        text: response.pending.text,
        rangeId: response.pending.rangeId
      };
      showSelectionConfirmPanel(pendingSelection.text);
    }
  } catch {
    // Worker may be waking; fail closed with no confirm UI.
  }
}

function showSelectionConfirmPanel(text) {
  elements.selectionConfirmText.textContent = text;
  elements.selectionConfirmPanel.hidden = false;
}

function hideSelectionConfirmPanel() {
  elements.selectionConfirmPanel.hidden = true;
  elements.selectionConfirmText.textContent = "";
}

async function confirmPendingSelection() {
  if (!pendingSelection || !currentTab?.id) {
    hideSelectionConfirmPanel();
    return;
  }
  if (!validateApiKey()) {
    return;
  }

  elements.selectionConfirmBtn.disabled = true;
  setStatus("正在翻译划词", "扩展内确认后发送选中文本", "loading");

  try {
    await saveSettings();
    const confirm = await chrome.runtime.sendMessage({
      type: "CONFIRM_PENDING_SELECTION",
      tabId: currentTab.id
    });
    if (!confirm?.ok || !confirm.pending?.text || !confirm.pending?.rangeId) {
      throw new Error(confirm?.error === "NO_PENDING_SELECTION"
        ? "划词确认已过期，请重新选中文本"
        : (confirm?.error || "没有待确认的划词"));
    }

    const { text, rangeId } = confirm.pending;
    await ensureContentScript(currentTab.id);
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      type: "CONFIRM_SELECTION_TRANSLATE",
      text,
      rangeId
    });
    if (!response?.ok) {
      throw new Error(response?.error || "划词翻译失败");
    }

    pendingSelection = null;
    hideSelectionConfirmPanel();
    setStatus("划词翻译已发送", "译文将显示在页面选区旁的预览面板", "success");
  } catch (error) {
    pendingSelection = null;
    hideSelectionConfirmPanel();
    setStatus("划词翻译失败", toFriendlyPageError(error), "error");
  } finally {
    elements.selectionConfirmBtn.disabled = false;
  }
}

async function dismissPendingSelection() {
  pendingSelection = null;
  hideSelectionConfirmPanel();
  if (!currentTab?.id) {
    return;
  }
  try {
    await chrome.runtime.sendMessage({
      type: "CLEAR_PENDING_SELECTION",
      tabId: currentTab.id
    });
  } catch {
    // Ignore.
  }
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: "DISMISS_SELECTION" });
  } catch {
    // Page may not allow messaging.
  }
}

function toFriendlyPageError(error) {
  const message = error?.message || String(error);
  if (/Cannot access|chrome:\/\/|edge:\/\/|extensions gallery/i.test(message)) {
    return "Chrome 内置页面不允许扩展注入，请打开普通网页后重试";
  }
  return message;
}
