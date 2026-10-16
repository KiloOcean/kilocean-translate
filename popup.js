"use strict";

const Utils = globalThis.DeepSeekTranslatorUtils;

const PROVIDER_META = {
  deepseek: {
    label: "DeepSeek",
    keyLabel: "DeepSeek API Key",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyField: "deepseekApiKey",
    // Keep values in sync with Utils.DEEPSEEK_MODEL_IDS in shared.js
    // (deepseek-v4-flash was renamed to deepseek-flash).
    models: [
      { value: "deepseek-flash", label: "DeepSeek Flash（默认，快速）" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }
    ],
    defaultModel: "deepseek-flash"
  },
  kimi: {
    label: "Kimi",
    keyLabel: "Kimi API Key",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    keyField: "kimiApiKey",
    models: [
      { value: "kimi-k2.6", label: "Kimi K2.6 · 推荐" },
      { value: "kimi-k3", label: "Kimi K3" },
      { value: "moonshot-v1-128k", label: "Moonshot V1 128k · 长文" }
    ],
    defaultModel: "kimi-k2.6"
  }
};

const DEFAULT_SETTINGS = {
  provider: "deepseek",
  deepseekApiKey: "",
  kimiApiKey: "",
  apiKey: "",
  model: "deepseek-flash",
  targetLanguage: "zh-CN",
  displayMode: Utils.DISPLAY_MODES.bilingual
};

// ---- Settings export / import (pure helpers, DOM-free) ----
const SETTINGS_EXPORT_FORMAT = "kilocean-translate-settings";
const SETTINGS_EXPORT_VERSION = 1;
const SETTINGS_IMPORT_FIELDS = new Set([
  "provider",
  "targetLanguage",
  "model",
  "displayMode",
  "deepseekApiKey",
  "kimiApiKey"
]);
const SETTINGS_IMPORT_PROVIDERS = new Set(["deepseek", "kimi"]);
const SETTINGS_IMPORT_LANGUAGES = new Set(["zh-CN", "zh-TW", "ja", "ko", "en"]);
const SETTINGS_IMPORT_DISPLAY_MODES = new Set([
  Utils.DISPLAY_MODES.bilingual,
  Utils.DISPLAY_MODES.translationOnly,
  Utils.DISPLAY_MODES.original
]);

// Loose shape check only: catches paste accidents (truncated copy, stray
// whitespace/newlines, wrong field) without risking false rejections of a
// real DeepSeek (sk- + 32 hex) or Kimi/Moonshot (sk- + base62) key. Returns
// null when the shape looks valid, a user-facing reason otherwise.
function apiKeyFormatReason(value) {
  const raw = String(value ?? "");
  const key = raw.trim();
  if (!key) {
    return "Key 不能为空";
  }
  if (key !== raw) {
    return "Key 首尾有多余空白";
  }
  if (/\s/.test(key)) {
    return "Key 中间不能包含空白或换行";
  }
  if (!key.startsWith("sk-")) {
    return "Key 应以 sk- 开头";
  }
  if (key.length < 16 || key.length > 200) {
    return "Key 长度不正确";
  }
  if (!/^sk-[A-Za-z0-9_-]+$/.test(key)) {
    return "Key 含有非法字符";
  }
  return null;
}

function settingsImportModels() {
  return [
    ...new Set([...PROVIDER_META.deepseek.models, ...PROVIDER_META.kimi.models].map((item) => item.value))
  ];
}

// Validate an exported-settings document. Throws with a user-facing Chinese
// reason on any schema violation (unknown field, wrong type, bad enum, model
// not allowed, malformed key); returns ONLY the fields present in the file —
// absent key fields stay absent so importing can never wipe a stored key.
function parseImportedSettings(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("文件内容不是设置对象");
  }
  if (parsed.format !== SETTINGS_EXPORT_FORMAT) {
    throw new Error(`format 字段不匹配（应为本扩展导出的 ${SETTINGS_EXPORT_FORMAT} 文件）`);
  }
  if (parsed.version !== SETTINGS_EXPORT_VERSION) {
    throw new Error(`不支持的设置文件版本：${JSON.stringify(parsed.version)}`);
  }
  const raw = parsed.settings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("缺少 settings 字段");
  }
  const unknown = Object.keys(raw).filter((field) => !SETTINGS_IMPORT_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new Error(`无法识别的字段：${unknown.join("、")}`);
  }
  for (const [field, value] of Object.entries(raw)) {
    if (field === "deepseekApiKey" || field === "kimiApiKey") {
      if (typeof value !== "string") {
        throw new Error(`字段 ${field} 必须是字符串`);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`字段 ${field} 必须是字符串`);
    }
    if (!value.trim()) {
      throw new Error(`字段 ${field} 不能为空`);
    }
  }
  if (raw.provider && !SETTINGS_IMPORT_PROVIDERS.has(raw.provider)) {
    throw new Error(`不支持的服务商：${raw.provider}`);
  }
  if (raw.targetLanguage && !SETTINGS_IMPORT_LANGUAGES.has(raw.targetLanguage)) {
    throw new Error(`不支持的目标语言：${raw.targetLanguage}`);
  }
  if (raw.displayMode && !SETTINGS_IMPORT_DISPLAY_MODES.has(raw.displayMode)) {
    throw new Error(`不支持的显示模式：${raw.displayMode}`);
  }
  const imported = {};
  for (const field of ["provider", "targetLanguage", "displayMode"]) {
    if (raw[field]) {
      imported[field] = raw[field].trim();
    }
  }
  if (raw.model) {
    const model = Utils.migrateModelName(raw.model.trim());
    if (!settingsImportModels().includes(model)) {
      throw new Error(`不支持的模型：${raw.model}`);
    }
    imported.model = model;
  }
  for (const field of ["deepseekApiKey", "kimiApiKey"]) {
    const key = String(raw[field] || "").trim();
    if (!key) {
      // Absent / blank key field: nothing to import — never a wipe signal.
      continue;
    }
    const reason = apiKeyFormatReason(key);
    if (reason) {
      throw new Error(`${field === "deepseekApiKey" ? "DeepSeek" : "Kimi"} API Key 格式不正确：${reason}`);
    }
    imported[field] = key;
  }
  return imported;
}

const elements = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("api-key"),
  apiKeyLabel: document.getElementById("api-key-label"),
  getKeyLink: document.getElementById("get-key-link"),
  keyStatusDeepseek: document.getElementById("key-status-deepseek"),
  keyStatusDeepseekValue: document.getElementById("key-status-deepseek-value"),
  keyStatusKimi: document.getElementById("key-status-kimi"),
  keyStatusKimiValue: document.getElementById("key-status-kimi-value"),
  keyGuide: document.getElementById("key-guide"),
  targetLanguage: document.getElementById("target-language"),
  model: document.getElementById("model"),
  toggleKey: document.getElementById("toggle-key"),
  testConnection: document.getElementById("test-connection"),
  translate: document.getElementById("translate"),
  restore: document.getElementById("restore"),
  exportHtml: document.getElementById("export-html"),
  printPdf: document.getElementById("print-pdf"),
  exportSettings: document.getElementById("export-settings"),
  importSettings: document.getElementById("import-settings"),
  importFile: document.getElementById("import-file"),
  exportIncludeKeys: document.getElementById("export-include-keys"),
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
// Active provider + per-provider keys so switching never mixes or clobbers
// the two credentials; elements.apiKey always edits currentProvider's entry.
let currentProvider = "deepseek";
let providerKeys = { deepseek: "", kimi: "" };
// Monotonic token for the paste-triggered key verification: a newer paste
// (or manual test) invalidates the previous run's status write.
let keyTestOp = 0;
// op token of the key test currently in flight (0 = none).
let keyTestPendingOp = 0;
/** @type {{ text: string, rangeId: string } | null} */
let pendingSelection = null;

const initializePromise = initialize().catch((error) => setStatus("无法初始化", error.message, "error"));

// Keep radiogroup in sync when content coerces original→bilingual mid-start.
// Keep this view's key snapshot in sync with writes from other extension
// views (popup vs. settings tab), so a later save here never restores a
// stale key over a newer one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  for (const [provider, meta] of Object.entries(PROVIDER_META)) {
    const change = changes[meta.keyField];
    if (!change) {
      continue;
    }
    const next = String(change.newValue || "").trim();
    if (providerKeys[provider] === next) {
      continue;
    }
    const editingThis = provider === currentProvider && document.activeElement === elements.apiKey;
    if (editingThis) {
      continue;
    }
    providerKeys[provider] = next;
    if (provider === currentProvider) {
      elements.apiKey.value = next;
    }
    renderKeyStatus();
  }
});

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

elements.apiKey.addEventListener("input", () => {
  // Any edit invalidates an in-flight connection test for the old value.
  keyTestOp += 1;
  schedulePersistSettings();
  renderKeyStatus();
});
elements.apiKey.addEventListener("change", persistSettingsNow);
elements.apiKey.addEventListener("blur", persistSettingsNow);
// Paste → auto-save + auto connection test. The pasted value lands after the
// default paste action, so run on the next tick.
elements.apiKey.addEventListener("paste", () => {
  setTimeout(() => {
    void handleApiKeyPasted();
  }, 0);
});
elements.provider.addEventListener("change", () => {
  const nextProvider = PROVIDER_META[elements.provider.value] ? elements.provider.value : "deepseek";
  if (nextProvider === currentProvider) {
    return;
  }
  // Bank the key shown in the input under the provider it belongs to, then
  // swap the input to the newly selected provider's stored key.
  providerKeys[currentProvider] = elements.apiKey.value.trim();
  // Drop any in-flight connection test for the previous provider's key.
  keyTestOp += 1;
  currentProvider = nextProvider;
  applyProviderUi(nextProvider, { resetModel: true });
  elements.apiKey.value = providerKeys[nextProvider];
  renderKeyStatus();
  persistSettingsNow();
});
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

  // Same tokenized path as paste validation: a newer test (manual or
  // paste) or any other status supersedes an older completion.
  elements.testConnection.disabled = true;
  elements.testConnection.textContent = "正在测试…";
  try {
    await runKeyConnectionTest();
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
        provider: settings.provider,
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

elements.exportSettings.addEventListener("click", () => {
  void exportSettingsFile();
});

// Chromium (Linux, ~128–130, crbug 364825891) can destroy an action popup
// when a file chooser opens, so the import never runs. Import therefore runs
// from popup.html opened as a normal extension tab (?view=settings), which
// survives the chooser. chrome.tabs.create needs no extra permission.
const IS_SETTINGS_TAB = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("view") === "settings";
  } catch {
    return false;
  }
})();

elements.importSettings.addEventListener("click", () => {
  if (IS_SETTINGS_TAB) {
    elements.importFile.click();
    return;
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=settings") }).then(() => {
    window.close();
  });
});

if (IS_SETTINGS_TAB) {
  document.body?.classList?.add("settings-tab");
  setTimeout(() => {
    setStatus("导入设置", "点击「导入设置」选择之前导出的 JSON 文件", "idle");
  }, 0);
}

elements.importFile.addEventListener("change", () => {
  const file = elements.importFile.files && elements.importFile.files[0];
  elements.importFile.value = "";
  if (!file) {
    return;
  }
  void importSettingsFile(file);
});

async function initialize() {
  const [settings, tabs] = await Promise.all([
    chrome.storage.local.get(DEFAULT_SETTINGS),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  currentTab = tabs[0];
  const migrated = migrateSettings(settings);
  const provider = PROVIDER_META[migrated.provider] ? migrated.provider : "deepseek";
  currentProvider = provider;
  providerKeys = { deepseek: migrated.deepseekApiKey, kimi: migrated.kimiApiKey };
  elements.provider.value = provider;
  applyProviderUi(provider, { resetModel: false });
  elements.apiKey.value = providerKeys[provider];
  elements.targetLanguage.value = migrated.targetLanguage;
  if ([...elements.model.options].some((o) => o.value === migrated.model)) {
    elements.model.value = migrated.model;
  }
  currentDisplayMode = Utils.normalizeDisplayMode(migrated.displayMode);
  renderDisplayMode();
  renderKeyStatus();
  // Controls now mirror storage — safe to persist on hide/unload.
  initialized = true;
  if (migrated._didMigrate) {
    await saveSettings();
  }

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

function migrateSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  const provider = PROVIDER_META[settings.provider] ? settings.provider : "deepseek";
  let deepseekApiKey = String(settings.deepseekApiKey || "").trim();
  let kimiApiKey = String(settings.kimiApiKey || "").trim();
  const legacy = String(settings.apiKey || "").trim();
  let didMigrate = false;
  // Only treat `apiKey` as a <=1.3.x DeepSeek key when no per-provider keys
  // exist yet; a Kimi-only user's mirrored apiKey is not legacy storage.
  if (!deepseekApiKey && !kimiApiKey && legacy) {
    deepseekApiKey = legacy;
    didMigrate = true;
  }
  // deepseek-v4-flash → deepseek-flash rename: map on read; the follow-up
  // save (background's loadSettings also persists it) retires the old value.
  const model = Utils.migrateModelName(settings.model);
  if (model !== settings.model) {
    settings.model = model;
    didMigrate = true;
  }
  return {
    ...settings,
    provider,
    deepseekApiKey,
    kimiApiKey,
    // content.js's selection gate still reads the legacy single-key field;
    // mirror the active provider's key into it on every write.
    apiKey: provider === "kimi" ? kimiApiKey : deepseekApiKey,
    _didMigrate: didMigrate
  };
}

function applyProviderUi(providerId, { resetModel }) {
  const meta = PROVIDER_META[providerId] || PROVIDER_META.deepseek;
  elements.apiKeyLabel.textContent = meta.keyLabel;
  elements.getKeyLink.href = meta.keyUrl;
  const previousModel = elements.model.value;
  elements.model.innerHTML = "";
  for (const item of meta.models) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    elements.model.appendChild(option);
  }
  if (!resetModel && meta.models.some((m) => m.value === previousModel)) {
    elements.model.value = previousModel;
  } else {
    elements.model.value = meta.defaultModel;
  }
}

async function saveSettings() {
  const provider = PROVIDER_META[elements.provider.value] ? elements.provider.value : "deepseek";
  providerKeys[provider] = elements.apiKey.value.trim();
  const settings = {
    provider,
    deepseekApiKey: providerKeys.deepseek,
    kimiApiKey: providerKeys.kimi,
    // Legacy mirror for content.js's selection key gate.
    apiKey: providerKeys[provider],
    targetLanguage: elements.targetLanguage.value,
    model: elements.model.value,
    displayMode: Utils.normalizeDisplayMode(currentDisplayMode)
  };
  await chrome.storage.local.set(settings);
  renderKeyStatus();
  return settings;
}

// ---- Persistent per-provider key status (top of the settings panel) ----

function keyTail(key) {
  const value = String(key || "").trim();
  // Only ever surface the last 4 chars, and only for key-shaped values:
  // short fragments show nothing instead of leaking most of the key.
  return value.length >= 8 ? value.slice(-4) : "";
}

function renderKeyStatus() {
  const rows = [
    { id: "deepseek", row: elements.keyStatusDeepseek, value: elements.keyStatusDeepseekValue },
    { id: "kimi", row: elements.keyStatusKimi, value: elements.keyStatusKimiValue }
  ];
  for (const { id, row, value } of rows) {
    if (!row || !value) {
      continue;
    }
    const key = String(providerKeys[id] || "").trim();
    row.dataset.active = id === currentProvider ? "true" : "false";
    if (key) {
      const tail = keyTail(key);
      value.textContent = tail ? `已配置 · 尾号 ${tail}` : "已配置";
      row.dataset.tone = "ok";
    } else {
      value.textContent = "未配置";
      row.dataset.tone = "missing";
    }
  }
  const activeKey = String(providerKeys[currentProvider] || "").trim();
  if (activeKey && !apiKeyFormatReason(activeKey)) {
    elements.keyGuide.hidden = true;
    elements.keyGuide.classList.remove("highlight");
    elements.apiKey.classList.remove("attention");
  }
}

// Expand + highlight the key entry step (both providers' console links) when
// an action is blocked on a missing key — not just a red status line.
function revealKeyEntry() {
  elements.keyGuide.hidden = false;
  elements.keyGuide.classList.add("highlight");
  elements.apiKey.classList.add("attention");
}

// ---- Paste → auto-save + auto connection test ----

async function handleApiKeyPasted() {
  const label = PROVIDER_META[currentProvider]?.label || "API";
  persistSettingsNow();
  renderKeyStatus();
  const key = elements.apiKey.value.trim();
  if (!key) {
    setStatus("Key 已清空", `下次翻译前请重新填写 ${label} API Key`, "idle");
    return;
  }
  // Format gate before any network call: a paste accident fails in ms with a
  // clear reason instead of a confusing 401.
  const formatReason = apiKeyFormatReason(elements.apiKey.value);
  if (formatReason) {
    keyTestOp += 1;
    revealKeyEntry();
    setStatus("Key 格式错误", `${formatReason}（已保存本机，未发起网络验证）`, "error");
    return;
  }
  await runKeyConnectionTest();
}

async function runKeyConnectionTest() {
  const label = PROVIDER_META[currentProvider]?.label || "API";
  const op = ++keyTestOp;
  keyTestPendingOp = op;
  renderStatus(`正在验证 ${label} Key`, "发送一条最小测试请求", "loading");
  try {
    await runKeyConnectionTestInner(op, label);
  } finally {
    if (keyTestPendingOp === op) {
      keyTestPendingOp = 0;
    }
  }
}

async function runKeyConnectionTestInner(op, label) {
  try {
    const settings = await saveSettings();
    const response = await chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      provider: settings.provider,
      targetLanguage: settings.targetLanguage,
      model: settings.model
    });
    if (op !== keyTestOp) {
      return;
    }
    if (response?.ok) {
      renderStatus("Key 有效", `${label} 连接成功，可以开始翻译`, "success");
      return;
    }
    const [title, detail] = friendlyKeyTestFailure(response, label);
    renderStatus(title, detail, "error");
  } catch (error) {
    if (op !== keyTestOp) {
      return;
    }
    renderStatus("网络错误", toFriendlyPageError(error), "error");
  }
}

function friendlyKeyTestFailure(response, label) {
  const code = String(response?.code || "");
  if (code === "API_401") {
    return ["Key 无效", `${label} 返回 401：Key 不正确或已失效，请重新复制粘贴`];
  }
  if (code === "API_402") {
    return ["余额不足", `${label} 返回 402：账户余额不足，请充值后重试`];
  }
  if (code === "API_429") {
    return ["额度受限", `${label} 返回 429：请求过于频繁或额度不足，请稍后重试`];
  }
  if (code === "MISSING_API_KEY") {
    return ["Key 缺失", "Key 保存失败，请重新粘贴后再试"];
  }
  if (code === "NETWORK_ERROR") {
    return ["网络错误", response?.error || "无法连接服务商，请检查网络后重试"];
  }
  return ["验证失败", response?.error || "连接测试失败，请稍后重试"];
}

// ---- Settings export / import ----

// Blob + <a download>: works in the popup without the downloads permission.
function buildExportPayload(settings, includeKeys) {
  const payload = {
    format: SETTINGS_EXPORT_FORMAT,
    version: SETTINGS_EXPORT_VERSION,
    createdAt: new Date().toISOString(),
    settings: {
      provider: settings.provider,
      targetLanguage: settings.targetLanguage,
      model: settings.model,
      displayMode: settings.displayMode
    }
  };
  if (includeKeys) {
    // providerKeys is keyed by provider id ("deepseek"/"kimi"); map each to
    // its storage/export field name.
    for (const [provider, meta] of Object.entries(PROVIDER_META)) {
      const key = String(providerKeys[provider] || "").trim();
      if (key) {
        payload.settings[meta.keyField] = key;
      }
    }
  }
  return payload;
}

// Keys are excluded unless the user opts in with the warning checkbox; empty
// key fields are omitted so a re-import never sees a blank key value.
async function exportSettingsFile() {
  let settings;
  try {
    settings = await saveSettings();
  } catch {
    settings = {
      provider: currentProvider,
      targetLanguage: elements.targetLanguage.value,
      model: elements.model.value,
      displayMode: Utils.normalizeDisplayMode(currentDisplayMode)
    };
  }
  const includeKeys = Boolean(elements.exportIncludeKeys?.checked);
  const payload = buildExportPayload(settings, includeKeys);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kilocean-translate-settings-${chrome.runtime.getManifest().version}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  setStatus(
    "设置已导出",
    includeKeys ? "注意：文件内含 API Key 明文，请妥善保管，勿分享" : "导出文件不含 API Key",
    "success"
  );
}

async function importSettingsFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    setStatus("导入失败", "无法读取所选文件", "error");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    setStatus("导入失败", "文件不是有效的 JSON", "error");
    return;
  }
  let imported;
  try {
    imported = parseImportedSettings(parsed);
  } catch (error) {
    setStatus("导入失败", error.message, "error");
    return;
  }
  try {
    const applied = await applyImportedSettings(imported);
    setStatus("设置已导入", applied.detail, "success");
  } catch (error) {
    setStatus("导入失败", error?.message || "写入设置失败", "error");
  }
}

// Merge validated fields into storage + UI. Non-key fields overwrite; key
// fields only when the file carried a valid one — a file without keys never
// touches the keys already saved on this machine.
async function applyImportedSettings(imported) {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const updates = {};
  for (const field of ["provider", "targetLanguage", "model", "displayMode"]) {
    if (imported[field]) {
      updates[field] = imported[field];
    }
  }
  if (imported.deepseekApiKey) {
    updates.deepseekApiKey = imported.deepseekApiKey;
  }
  if (imported.kimiApiKey) {
    updates.kimiApiKey = imported.kimiApiKey;
  }
  const provider = PROVIDER_META[updates.provider || stored.provider]
    ? (updates.provider || stored.provider)
    : "deepseek";
  const deepseekApiKey = updates.deepseekApiKey ?? String(stored.deepseekApiKey || "").trim();
  const kimiApiKey = updates.kimiApiKey ?? String(stored.kimiApiKey || "").trim();
  // Keep provider and model compatible: a partial import (provider-only or
  // model-only) must not leave a model belonging to the other provider.
  const effectiveModel = updates.model || stored.model;
  const providerModels = PROVIDER_META[provider].models.map((entry) => entry.value ?? entry);
  if (!providerModels.includes(effectiveModel)) {
    updates.model = PROVIDER_META[provider].defaultModel;
  }
  // Legacy mirror for content.js's selection key gate.
  updates.apiKey = provider === "kimi" ? kimiApiKey : deepseekApiKey;
  await chrome.storage.local.set(updates);

  // Drop any in-flight connection test for the pre-import provider/key.
  keyTestOp += 1;
  currentProvider = provider;
  providerKeys = { deepseek: deepseekApiKey, kimi: kimiApiKey };
  elements.provider.value = provider;
  applyProviderUi(provider, { resetModel: false });
  if (updates.model && [...elements.model.options].some((option) => option.value === updates.model)) {
    elements.model.value = updates.model;
  }
  if (
    updates.targetLanguage &&
    [...elements.targetLanguage.options].some((option) => option.value === updates.targetLanguage)
  ) {
    elements.targetLanguage.value = updates.targetLanguage;
  }
  elements.apiKey.value = providerKeys[provider];
  if (updates.displayMode) {
    currentDisplayMode = Utils.normalizeDisplayMode(updates.displayMode);
    renderDisplayMode();
  }
  renderKeyStatus();
  const detail = imported.deepseekApiKey || imported.kimiApiKey
    ? "已导入文件中的 API Key"
    : "文件不含 Key，已保留本机保存的 Key";
  return { detail };
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
  // Expand + highlight the key entry step with both providers' console links
  // instead of only a red status line.
  revealKeyEntry();
  elements.apiKey.focus();
  setStatus(
    "缺少 API Key",
    `请先填写 ${PROVIDER_META[elements.provider.value]?.label || ""} API Key（展开的链接可免费创建）`,
    "error"
  );
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
    passiveStatus("准备就绪", "可整页翻译，或在页面上划词查看译文", "idle");
    return;
  }

  if (status.phase === "translating") {
    const progress = status.total > 0
      ? `已完成 ${status.translated} / ${status.total} 段`
      : "正在识别网页内容";
    passiveStatus("正在翻译", progress, "loading");
    return;
  }

  if (status.phase === "error") {
    passiveStatus("翻译失败", status.error || "请检查 API 设置后重试", "error");
    return;
  }

  const failureText = status.failed > 0 ? `，${status.failed} 段失败` : "";
  const modeLabel = {
    bilingual: "双语对照",
    "translation-only": "仅译文",
    original: "原文"
  }[status.displayMode] || "双语对照";
  passiveStatus("翻译已开启", `已翻译 ${status.translated} 段${failureText} · ${modeLabel} · 自动跟译新内容`, "success");
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

// Any status from another action supersedes a pending key connection test,
// so a late validation result can't overwrite it.
function setStatus(title, detail, tone) {
  keyTestOp += 1;
  renderStatus(title, detail, tone);
}

// Passive (polling) updates never cancel an explicitly requested key test
// and are skipped while one is in flight.
function passiveStatus(title, detail, tone) {
  // Only a still-current (not superseded) test suppresses passive updates.
  if (keyTestPendingOp && keyTestPendingOp === keyTestOp) {
    return;
  }
  renderStatus(title, detail, tone);
}

function renderStatus(title, detail, tone) {
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
    // Bind the confirm to the previewed snapshot: the worker rejects if the
    // stored pending was replaced by a newer selection the popup never showed.
    const confirm = await chrome.runtime.sendMessage({
      type: "CONFIRM_PENDING_SELECTION",
      tabId: currentTab.id,
      text: pendingSelection.text,
      rangeId: pendingSelection.rangeId
    });
    if (!confirm?.ok || !confirm.pending?.text || !confirm.pending?.rangeId) {
      throw new Error(confirm?.error === "NO_PENDING_SELECTION"
        ? "划词确认已过期，请重新选中文本"
        : confirm?.error === "SELECTION_MISMATCH"
          ? "划词已变化，请重新选中后确认"
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
