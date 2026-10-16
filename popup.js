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

// ---- Settings/key state model (pure core, DOM-free) ----

// Storage fields the settings controls map to. The legacy apiKey mirror is
// derived (the active provider's key) and never reconciled into a control.
const SETTINGS_FIELDS = [
  "provider",
  "deepseekApiKey",
  "kimiApiKey",
  "model",
  "targetLanguage",
  "displayMode"
];

// Pure core of reconcile(): merge a storage view (a fresh full read or an
// onChanged delta) into the model's snapshot and report the fields to apply
// to the controls — every tracked field present in the view EXCEPT those
// with a pending user edit (dirty fields keep the user's value).
function reconcileModel(model, storageSnapshot) {
  const applied = {};
  for (const field of SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(storageSnapshot, field)) {
      continue;
    }
    model.snapshot[field] = storageSnapshot[field];
    if (!(field in model.edits)) {
      applied[field] = model.snapshot[field];
    }
  }
  return applied;
}

// Pure core of save(): collect the pending user edits (dirty fields) from
// the current control values. Only values that differ from the last-known
// snapshot are written; `savedValues` records, per dirty field, the exact
// value this save establishes in storage (the written value, or the stored
// value an edit already matched) so completion can tell a settled edit from
// one the user retyped while the write was in flight. The legacy apiKey
// mirror follows the active provider's key whenever a provider/key field is
// written — including a write to "" (clearing the last key must clear the
// mirror too, or the next load would resurrect the key as a legacy apiKey).
function collectDirtyPatch(model, controlValues) {
  const patch = {};
  const fields = [];
  const savedValues = {};
  for (const field of Object.keys(model.edits)) {
    if (controlValues[field] === undefined) {
      continue;
    }
    fields.push(field);
    savedValues[field] = controlValues[field];
    if (controlValues[field] !== model.snapshot[field]) {
      patch[field] = controlValues[field];
    }
  }
  const provider = PROVIDER_META[controlValues.provider] ? controlValues.provider : "deepseek";
  // `in`, not truthiness: a cleared key writes "" and must still update the
  // legacy mirror.
  if ("provider" in patch || "deepseekApiKey" in patch || "kimiApiKey" in patch) {
    patch.apiKey = controlValues[PROVIDER_META[provider].keyField] ?? model.snapshot[PROVIDER_META[provider].keyField];
  }
  return { patch, fields, savedValues };
}

// Pure core of save completion: a collected dirty edit resolves ONLY when
// it still equals the value its save established in storage — the user may
// have retyped the field while the write was in flight, and that newer edit
// must stay dirty for a follow-up save (the storage.onChanged echo of our
// own write already skips dirty fields, so it cannot clobber it either).
// Returns true when any collected edit survived and another save is due.
function settleSavedEdits(model, savedValues) {
  let followUpNeeded = false;
  for (const [field, value] of Object.entries(savedValues)) {
    if (!(field in model.edits)) {
      continue;
    }
    if (model.edits[field] === value) {
      delete model.edits[field];
    } else {
      followUpNeeded = true;
    }
  }
  return followUpNeeded;
}

// Pure: the fields a one-time storage upgrade (legacy apiKey →
// deepseekApiKey, retired model name) must persist — exactly where the
// migrated view differs from the raw stored read.
function collectMigrationPatch(stored, migrated) {
  const patch = {};
  for (const field of [...SETTINGS_FIELDS, "apiKey"]) {
    if (migrated[field] !== stored[field]) {
      patch[field] = migrated[field];
    }
  }
  return patch;
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
// Monotonic token for the paste-triggered key verification: a newer paste
// (or manual test) invalidates the previous run's status write.
let keyTestOp = 0;
// op token of the key test currently in flight (0 = none).
let keyTestPendingOp = 0;
/** @type {{ text: string, rangeId: string } | null} */
let pendingSelection = null;

// ---- Settings/key state: single source of truth ----
// settingsModel.snapshot is the last-known chrome.storage.local view; every
// storage→view path (init read, storage.onChanged, own writes) merges into
// it through reconcile(). settingsModel.edits holds the per-field dirty
// flags: a field is dirty iff it has an entry, and the entry is the user's
// unsaved value (banked on input/change events, cleared once a save writes
// the field). Dirty controls keep the user's value when storage changes
// underneath; saves write ONLY dirty fields, so a stale idle view can never
// restore old values over newer ones.
const settingsModel = {
  snapshot: { ...DEFAULT_SETTINGS },
  edits: {}
};

// Active provider as shown by the select — the select IS the provider
// control, so no separate currentProvider copy can drift out of sync.
function activeProvider() {
  return PROVIDER_META[elements.provider.value] ? elements.provider.value : "deepseek";
}

// What a provider's key field would hold if saved right now: the user's
// pending edit when one exists, otherwise the last-known stored key. This
// is the only key lookup — no providerKeys mirror to keep in step.
function providerKeyValue(provider) {
  const field = PROVIDER_META[provider].keyField;
  return field in settingsModel.edits
    ? String(settingsModel.edits[field] || "").trim()
    : String(settingsModel.snapshot[field] || "").trim();
}

// One value per tracked field, read from the controls. The single key input
// edits the ACTIVE provider's key; the inactive provider's key resolves to
// its banked edit (kept across a provider switch) or the stored value.
function readControlValues() {
  const provider = activeProvider();
  const values = {
    provider,
    deepseekApiKey: providerKeyValue("deepseek"),
    kimiApiKey: providerKeyValue("kimi"),
    targetLanguage: elements.targetLanguage.value,
    model: elements.model.value,
    displayMode: Utils.normalizeDisplayMode(currentDisplayMode)
  };
  values[PROVIDER_META[provider].keyField] = elements.apiKey.value.trim();
  return values;
}

// Bank the key input's current value as the active provider's pending edit.
function markKeyEdit() {
  settingsModel.edits[PROVIDER_META[activeProvider()].keyField] = elements.apiKey.value.trim();
}

// The single storage→view sync path: merge a storage view (a fresh full
// read, an onChanged delta, or this view's own write) into the model, then
// apply every NON-dirty field to its control — dirty controls keep the
// user's value, while their fields still update in the snapshot so the next
// save diffs against the newest stored state.
function reconcile(storageSnapshot) {
  const applied = reconcileModel(settingsModel, storageSnapshot);
  applyFieldsToControls(applied);
  if ("provider" in applied) {
    // The provider behind any in-flight key test changed: drop its result.
    keyTestOp += 1;
  } else if (PROVIDER_META[activeProvider()].keyField in applied) {
    // The key under test changed elsewhere: drop any in-flight result.
    if (keyTestPendingOp && keyTestPendingOp === keyTestOp) {
      renderStatus("Key 已在其他窗口更新", "如需验证，请重新点击「测试 API 连接」", "idle");
    }
    keyTestOp += 1;
  }
}

// Apply reconciled storage values to the controls. Provider goes first: it
// re-targets the key input and rebuilds the model options the model value
// is validated against. Dirty fields never reach this function.
function applyFieldsToControls(applied) {
  if ("provider" in applied && PROVIDER_META[applied.provider] && elements.provider.value !== applied.provider) {
    elements.provider.value = applied.provider;
    applyProviderUi(applied.provider, { resetModel: false });
  }
  if ("model" in applied && [...elements.model.options].some((option) => option.value === applied.model)) {
    elements.model.value = applied.model;
  }
  if ("targetLanguage" in applied) {
    const langOptions = [...(elements.targetLanguage.options || [])];
    if (!langOptions.length || langOptions.some((option) => option.value === applied.targetLanguage)) {
      elements.targetLanguage.value = applied.targetLanguage;
    }
  }
  if ("displayMode" in applied) {
    // Always render, even when the mode is unchanged: on a first load the
    // stored/default mode equals the in-memory default, and the buttons still
    // need their initial active state (no button is marked active in markup).
    currentDisplayMode = Utils.normalizeDisplayMode(applied.displayMode);
    renderDisplayMode();
  }
  // The key input mirrors the active provider's key — the post-swap one if
  // a provider was just applied — unless the user is editing it.
  const keyField = PROVIDER_META[activeProvider()].keyField;
  if (!(keyField in settingsModel.edits)) {
    const nextKey = String(settingsModel.snapshot[keyField] || "").trim();
    if (elements.apiKey.value !== nextKey) {
      elements.apiKey.value = nextKey;
    }
  }
  renderKeyStatus();
}

// Deltas onChanged delivered while a full storage read was in flight.
// Chrome commits a write before delivering its event, but a read that
// started earlier may still resolve with the pre-write snapshot, so init
// overlays these deltas on top of its read result (see initialize).
let changesDuringRead = null;

// Registered BEFORE any init read: changes arriving while initialization is
// still awaiting merge into the model immediately, and init's closing fresh
// read re-reconciles the same values — a stale first snapshot can never
// overwrite an update received during initialization.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  const delta = {};
  for (const [field, change] of Object.entries(changes)) {
    delta[field] = change?.newValue;
  }
  if (changesDuringRead) {
    Object.assign(changesDuringRead, delta);
  }
  reconcile(delta);
});

const initializePromise = initialize().catch((error) => setStatus("无法初始化", error.message, "error"));

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
  markKeyEdit();
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
  // Any unsaved edit of the previous provider's key is already banked in
  // settingsModel.edits by its input events — switching neither loses nor
  // mixes the two credentials. Drop any in-flight test for the old key.
  keyTestOp += 1;
  applyProviderUi(nextProvider, { resetModel: true });
  // The switch (and the model reset above) are user edits this view owns.
  // The model edit is banked UNCONDITIONALLY from the rebuilt select, never
  // diffed against the snapshot: a previous switch's write may still be in
  // flight, so the snapshot can be stale — diffing against it could leave a
  // departed provider's model banked and land an inconsistent pair in
  // storage (provider deepseek + kimi model).
  settingsModel.edits.provider = nextProvider;
  settingsModel.edits.model = elements.model.value;
  // Swap the key input to the new provider's pending-or-stored key.
  elements.apiKey.value = providerKeyValue(nextProvider);
  renderKeyStatus();
  persistSettingsNow();
});
elements.targetLanguage.addEventListener("change", () => {
  settingsModel.edits.targetLanguage = elements.targetLanguage.value;
  persistSettingsNow();
});
elements.model.addEventListener("change", () => {
  settingsModel.edits.model = elements.model.value;
  persistSettingsNow();
});
// Closing/hiding a view only flushes a still-pending debounced edit. Edits
// are otherwise saved immediately, so an idle (possibly stale) view never
// writes its snapshot back over newer settings from another view.
function flushPendingPersist() {
  if (persistTimer) {
    persistSettingsNow();
  }
}
window.addEventListener("pagehide", flushPendingPersist);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingPersist();
  }
});

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const mode = Utils.normalizeDisplayMode(button.dataset.mode);
    const op = ++displayModeOp;
    // User edit: dirty until the write lands, so a concurrent reconcile
    // cannot fight the click.
    settingsModel.edits.displayMode = mode;
    currentDisplayMode = mode;
    renderDisplayMode();
    // Through the serialized save path (never a direct storage write): a
    // newer click while this write is pending stays dirty and settles via
    // the follow-up save instead of being un-banked unconditionally.
    await saveSettings();
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
  // Async reads that do not touch settings state come first, so the storage
  // read below is the LAST read: any onChanged delivered while these were in
  // flight already merged into the model, and this fresh read observes those
  // same writes — a stale first snapshot can never roll a newer value back.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  changesDuringRead = {};
  // Read raw (get(null), no defaults): migrateSettings must tell a <=1.3.x
  // store (per-provider key fields absent) from a 1.4 store that merely holds
  // empty keys — a defaults-filled read would erase that distinction.
  const read = await chrome.storage.local.get(null);
  // Overlay deltas delivered while the read was in flight: the read may have
  // resolved with a snapshot older than those already-applied writes.
  const stored = { ...read, ...changesDuringRead };
  changesDuringRead = null;

  const migrated = migrateSettings(stored);
  reconcile(migrated);
  // Persist one-time storage upgrades (legacy apiKey → deepseekApiKey,
  // retired model names) so the old values do not survive on disk; the
  // model already holds the migrated view, and the onChanged this write
  // triggers re-reconciles the same values. Diff against the defaults-merged
  // view so an untouched store never materializes default values.
  const migrationPatch = collectMigrationPatch({ ...DEFAULT_SETTINGS, ...stored }, migrated);
  if (Object.keys(migrationPatch).length) {
    await enqueueSettingsWrite(migrationPatch);
  }
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

function migrateSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  const provider = PROVIDER_META[settings.provider] ? settings.provider : "deepseek";
  let deepseekApiKey = String(settings.deepseekApiKey || "").trim();
  let kimiApiKey = String(settings.kimiApiKey || "").trim();
  const legacy = String(settings.apiKey || "").trim();
  let didMigrate = false;
  // Only treat `apiKey` as a <=1.3.x DeepSeek key when no per-provider key
  // fields exist yet — ABSENT, not empty: an empty deepseekApiKey/kimiApiKey
  // is a key the user cleared, and migrating its stale apiKey mirror would
  // resurrect the deleted key (a Kimi-only user's mirrored apiKey is likewise
  // not legacy storage).
  if (!("deepseekApiKey" in raw) && !("kimiApiKey" in raw) && legacy) {
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

// ---- Serialized settings saves ----
// At most one chrome.storage.local.set from this view runs at a time: two
// concurrent writes could land out of order and let an older save's value
// overwrite a newer edit. saveSettings() calls that arrive while a write is
// in flight coalesce into ONE follow-up save started once that write
// settles — every queued caller awaits that same follow-up.
let settingsSaveInFlight = null;
let settingsSaveFollowUp = null;

// ---- Serialized storage write queue ----
// The ONLY call site of chrome.storage.local.set in popup.js. Every write
// this view makes — dirty-edit saves, provider switches, imports, key
// deletes/clears, the one-time startup migration, display-mode clicks — is
// a patch on this queue. The next write starts only after the previous one
// settles, so two writes can never commit out of order and let an older
// patch overwrite a newer edit; edits made while a write is pending stay
// dirty (settingsModel.edits) and merge into the next queued patch.
let settingsWriteBusy = false;
const settingsWriteQueue = [];

function enqueueSettingsWrite(patch) {
  return new Promise((resolve, reject) => {
    settingsWriteQueue.push({ patch, resolve, reject });
    drainSettingsWrites();
  });
}

function drainSettingsWrites() {
  if (settingsWriteBusy) {
    return;
  }
  const next = settingsWriteQueue.shift();
  if (!next) {
    return;
  }
  settingsWriteBusy = true;
  Promise.resolve(chrome.storage.local.set(next.patch)).then(
    (value) => {
      settingsWriteBusy = false;
      next.resolve(value);
      drainSettingsWrites();
    },
    (error) => {
      settingsWriteBusy = false;
      next.reject(error);
      drainSettingsWrites();
    }
  );
}

function saveSettings() {
  if (!settingsSaveInFlight) {
    return runSettingsSave();
  }
  if (!settingsSaveFollowUp) {
    settingsSaveFollowUp = settingsSaveInFlight.then(() => {
      settingsSaveFollowUp = null;
      return saveSettings();
    });
  }
  return settingsSaveFollowUp;
}

async function runSettingsSave() {
  let settle;
  settingsSaveInFlight = new Promise((resolve) => {
    settle = resolve;
  });
  try {
    return await performSettingsSave();
  } finally {
    settle();
    settingsSaveInFlight = null;
  }
}

// Save = flush the pending user edits ONLY. Fields the user never touched
// (including newer values other views wrote underneath) are never written
// from here, so a stale idle view cannot restore old values over new ones.
async function performSettingsSave() {
  const controlValues = readControlValues();
  const { patch, savedValues } = collectDirtyPatch(settingsModel, controlValues);
  if (Object.keys(patch).length) {
    await enqueueSettingsWrite(patch);
    for (const [field, value] of Object.entries(patch)) {
      settingsModel.snapshot[field] = value;
    }
  }
  // The collected edits resolve only when they still equal what this save
  // established in storage: an edit retyped while the write was in flight
  // stays dirty (the control keeps it) and gets one follow-up save.
  if (settleSavedEdits(settingsModel, savedValues)) {
    // Through the serializer, so this coalesces with any save already
    // queued behind the in-flight one; a rejected write is owned by that
    // follow-up's callers, and the edit stays dirty either way.
    void saveSettings();
  }
  renderKeyStatus();
  return {
    ...controlValues,
    // Legacy mirror for content.js's selection key gate.
    apiKey: controlValues[PROVIDER_META[controlValues.provider].keyField]
  };
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
  const provider = activeProvider();
  for (const { id, row, value } of rows) {
    if (!row || !value) {
      continue;
    }
    const key = providerKeyValue(id);
    row.dataset.active = id === provider ? "true" : "false";
    if (key) {
      const tail = keyTail(key);
      value.textContent = tail ? `已配置 · 尾号 ${tail}` : "已配置";
      row.dataset.tone = "ok";
    } else {
      value.textContent = "未配置";
      row.dataset.tone = "missing";
    }
  }
  const activeKey = providerKeyValue(provider);
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
  const label = PROVIDER_META[activeProvider()]?.label || "API";
  // A paste is a user edit: bank it before the auto-save below.
  markKeyEdit();
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
  const label = PROVIDER_META[activeProvider()]?.label || "API";
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
    // providerKeyValue is keyed by provider id ("deepseek"/"kimi"); map each
    // to its storage/export field name.
    for (const [provider, meta] of Object.entries(PROVIDER_META)) {
      const key = providerKeyValue(provider);
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
      provider: activeProvider(),
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

// Merge validated fields into the settings model + controls, then enqueue
// ONE save through the shared write queue. Non-key fields overwrite; key
// fields only when the file carried a valid one — a file without keys never
// touches the keys already saved on this machine. Import is expressed as
// dirty edits (never its own storage write path): it coalesces with any
// write already in flight, and an edit the user makes to an imported field
// while the import's write is pending stays dirty and wins the follow-up.
async function applyImportedSettings(imported) {
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
  // Resolve against the CURRENT view (controls + pending edits), never a
  // fresh storage read: a read would race the serialized write queue.
  const provider = PROVIDER_META[updates.provider ?? activeProvider()]
    ? (updates.provider ?? activeProvider())
    : "deepseek";
  // Keep provider and model compatible: a partial import (provider-only or
  // model-only) must not leave a model belonging to the other provider.
  const effectiveModel = updates.model ?? elements.model.value;
  const providerModels = PROVIDER_META[provider].models.map((entry) => entry.value ?? entry);
  if (!providerModels.includes(effectiveModel)) {
    updates.model = PROVIDER_META[provider].defaultModel;
  }

  // The file's values are the new truth for every field it carried: bank
  // them as edits (over any pending edit of the same field) and apply them
  // to the controls through the single field applier.
  const applied = {};
  for (const [field, value] of Object.entries(updates)) {
    settingsModel.edits[field] = value;
    applied[field] = value;
  }
  applyFieldsToControls(applied);
  // applyFieldsToControls never touches a dirty key input — and the imported
  // keys ARE the current edits now — so point the input at them explicitly.
  elements.apiKey.value = providerKeyValue(provider);
  renderKeyStatus();
  // Drop any in-flight connection test for the pre-import provider/key.
  keyTestOp += 1;
  await saveSettings();
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
