"use strict";

const Utils = globalThis.DeepSeekTranslatorUtils;

const PROVIDER_META = {
  deepseek: {
    label: "DeepSeek",
    keyLabel: "DeepSeek API Key",
    // Per-provider URLs live in ONE place: Utils.PROVIDER_LINKS (shared.js).
    keyUrl: Utils.PROVIDER_LINKS.deepseek.console,
    pricingUrl: Utils.PROVIDER_LINKS.deepseek.pricing,
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
    keyUrl: Utils.PROVIDER_LINKS.kimi.console,
    pricingUrl: Utils.PROVIDER_LINKS.kimi.pricing,
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

// popup.html opened as a normal extension tab (?view=settings). Settings and
// the settings import run there because Chromium (Linux, ~128–130,
// crbug 364825891) can destroy the transient action popup when a file chooser
// opens; chrome.tabs.create needs no extra permission. In that mode the popup
// always renders the settings view (see currentView).
const IS_SETTINGS_TAB = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("view") === "settings";
  } catch {
    return false;
  }
})();

// ---- Settings export / import (pure helpers, DOM-free) ----
const SETTINGS_EXPORT_FORMAT = "kilocean-translate-settings";
const SETTINGS_EXPORT_VERSION = 1;
// A real backup is a few KB; anything megabyte-scale is not one of ours. The
// guard runs on file.size before the file is read, so an oversized (or
// hostile) pick is rejected with no read, no parse, and no storage write.
const SETTINGS_IMPORT_MAX_BYTES = 1024 * 1024;
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

// Storage fields the settings state tracks. The key-status rows map to the
// per-provider verification fields (<provider>KeyStatus / <provider>KeyStatusFor,
// Codex PR #19 P2): they reconcile into the snapshot like every other field
// but map to no editable control and never enter model.edits, so no save
// ever writes them (the queue's verdict write owns them). The legacy apiKey
// mirror is derived (the active provider's key) and never reconciled into a
// control.
const SETTINGS_FIELDS = [
  "provider",
  "deepseekApiKey",
  "kimiApiKey",
  "model",
  "targetLanguage",
  "displayMode",
  "deepseekKeyStatus",
  "deepseekKeyStatusFor",
  "kimiKeyStatus",
  "kimiKeyStatusFor"
];

// Pure core of reconcile(): merge a storage view (a fresh full read or an
// onChanged delta) into the model's snapshot and report the fields to apply
// to the controls — every tracked field present in the view EXCEPT those
// with a pending user edit (dirty fields keep the user's value). Each merge
// that changes a field bumps that field's revision (model.revisions): write
// completion compares revisions against the ones recorded when its write
// began, so a NEWER value storage delivered while the write was in flight is
// never rolled back to the (now older) written value.
function reconcileModel(model, storageSnapshot) {
  const applied = {};
  for (const field of SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(storageSnapshot, field)) {
      continue;
    }
    if (model.snapshot[field] !== storageSnapshot[field]) {
      model.snapshot[field] = storageSnapshot[field];
      model.revisions = model.revisions || {};
      model.revisions[field] = (model.revisions[field] || 0) + 1;
    }
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
// A written key value always carries its provider's verification status
// reset to "unverified" in the SAME patch (Codex PR #19 P2): the new key has
// not been judged yet, and the fingerprint keeps an older verdict from
// attaching to it.
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
  for (const [providerId, meta] of Object.entries(PROVIDER_META)) {
    if (meta.keyField in patch) {
      Object.assign(patch, Utils.keyStatusPatch(providerId, "unverified", patch[meta.keyField]));
    }
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
  selectionConfirmDismiss: document.getElementById("selection-confirm-dismiss"),
  // 1.5.0 views / chrome. Every entry is null-guarded at its use sites: the
  // ci-check popup vm only knows the ids registered in createPopupVm.
  app: document.getElementById("app"),
  openSettings: document.getElementById("open-settings"),
  backMain: document.getElementById("back-main"),
  moreSettings: document.getElementById("more-settings"),
  providerStatus: document.getElementById("provider-status"),
  providerStatusLabel: document.getElementById("provider-status-label"),
  providerStatusMeta: document.getElementById("provider-status-meta"),
  translateShortcut: document.getElementById("translate-shortcut"),
  selectionShortcut: document.getElementById("selection-shortcut"),
  shortcutList: document.getElementById("shortcut-list"),
  openShortcuts: document.getElementById("open-shortcuts"),
  statusWrap: document.getElementById("status-wrap"),
  statusProgress: document.getElementById("status-progress"),
  retryFailed: document.getElementById("retry-failed"),
  setupConsoleLink: document.getElementById("setup-console-link"),
  setupPricingLink: document.getElementById("setup-pricing-link"),
  setupKeySlot: document.getElementById("setup-key-slot"),
  settingsKeySlot: document.getElementById("settings-key-slot"),
  keyEntry: document.getElementById("key-entry"),
  setupFeedback: document.getElementById("setup-feedback"),
  appVersion: document.getElementById("app-version"),
  providerOptions: [...document.querySelectorAll(".provider-option")]
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

// ---- 1.5.0 view state ----
// setupMode is decided once, after init: with no key for the ACTIVE provider
// the popup opens as the embedded two-step setup card (no translate button to
// click into an error). It clears when a connection test for the pasted key
// succeeds, or when a format-valid key for the active provider arrives from
// another surface (welcome page / settings tab / another popup) while this
// one stays open. userOpenedSettings keeps the settings view up until
// #back-main returns to whatever view was underneath.
const viewState = { setupMode: false, userOpenedSettings: false };
// Per-provider "verified this session" flag: a successful connection test in
// THIS popup renders the connected state immediately (the persisted verdict
// lands in the per-provider <provider>KeyStatus fields via the write queue).
const keyVerified = { deepseek: false, kimi: false };
// A page translation error that looks like a key problem (401 / Key 无效)
// flips the provider status line into its actionable error state.
let providerKeyInvalid = false;
// What clicking the provider status line does for its CURRENT rendering:
// "settings" opens the settings view at the key input, "test" (the
// unverified/failed states, Codex PR #19 P2) re-runs the connection test.
let providerStatusAction = "settings";
// The key whose connection test FAILED while setup owned the popup. Leaving
// setup requires a key that is format-valid AND not this one — an external
// arrival of a DIFFERENT key may still graduate the popup.
let setupRejectedKey = "";
// The active tab is a page the extension can never inject into (chrome://…).
let pageRestricted = false;

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
  // Per-field revision of snapshot values merged in from storage; see
  // reconcileModel. Write completion consults it to preserve newer storage
  // snapshots delivered while a pending write is still settling.
  revisions: {},
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

// Effective verification status of a provider's CURRENT key value (Codex PR
// #19 P2): "missing" with no key; "verified" when a connection test succeeded
// for it this session or the persisted status says so; "failed" only when the
// persisted "failed" was computed on this exact key; "unverified" otherwise —
// a pending edit, a missing status field (every 1.4.3 upgrade) and any
// fingerprint mismatch all read back as "unverified", because a status is
// only valid for the key it was computed on.
function keyVerificationStatus(provider) {
  const meta = PROVIDER_META[provider];
  const key = providerKeyValue(provider);
  if (!key) {
    return "missing";
  }
  if (keyVerified[provider]) {
    return "verified";
  }
  if (meta.keyField in settingsModel.edits) {
    return "unverified";
  }
  const status = settingsModel.snapshot[`${provider}KeyStatus`];
  if (
    (status === "verified" || status === "failed") &&
    settingsModel.snapshot[`${provider}KeyStatusFor`] === Utils.keyFingerprint(key)
  ) {
    return status;
  }
  return "unverified";
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
// A fresh edit also retires the per-session verdicts tied to the old value
// (verified flag, the setup card's rejected key, the provider error tone).
function markKeyEdit() {
  const provider = activeProvider();
  settingsModel.edits[PROVIDER_META[provider].keyField] = elements.apiKey.value.trim();
  keyVerified[provider] = false;
  providerKeyInvalid = false;
  setupRejectedKey = "";
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
    if (keyTestPendingOp && keyTestPendingOp === keyTestOp) {
      renderStatus("服务商已在其他窗口切换", "如需验证，请重新点击「测试 API 连接」", "idle");
    }
    keyTestOp += 1;
  } else if (PROVIDER_META[activeProvider()].keyField in applied) {
    // The key under test changed elsewhere: drop any in-flight result.
    if (keyTestPendingOp && keyTestPendingOp === keyTestOp) {
      renderStatus("Key 已在其他窗口更新", "如需验证，请重新点击「测试 API 连接」", "idle");
    }
    keyTestOp += 1;
  }
  // A stored key change clears the per-session verified flag and the page's
  // Key-invalid verdict — the new key has not been judged yet.
  const activeKeyField = PROVIDER_META[activeProvider()].keyField;
  if (activeKeyField in applied) {
    keyVerified[activeProvider()] = false;
    providerKeyInvalid = false;
  }
  // Any provider's key field arriving from storage invalidates that
  // provider's cached verifier verdicts (Codex PR #19 P1): the welcome page
  // or another popup surface may have re-written the credential, so a later
  // paste/change of the same value re-verifies instead of trusting the cache.
  for (const providerId of Object.keys(PROVIDER_META)) {
    if (PROVIDER_META[providerId].keyField in applied) {
      keyVerifier.forget(providerId);
    }
  }
  // A key arriving from another surface (welcome page, settings tab) can
  // graduate the popup out of the embedded setup card.
  evaluateSetupExit();
}

// Apply reconciled storage values to the controls. Provider goes first: it
// re-targets the key input and rebuilds the model options the model value
// is validated against. Dirty fields never reach this function.
function applyFieldsToControls(applied) {
  if ("provider" in applied && PROVIDER_META[applied.provider] && elements.provider.value !== applied.provider) {
    elements.provider.value = applied.provider;
    applyProviderUi(applied.provider, { resetModel: false });
    // A dirty model edit banked for the departed provider can never settle
    // once the rebuilt select no longer offers it (settle compares the edit
    // against the control value) — it would loop follow-up saves forever and
    // land the old provider's model under the new one. Re-point it at the
    // select's resolved model so the next save converges on a consistent
    // provider/model pair.
    if ("model" in settingsModel.edits) {
      const providerModels = PROVIDER_META[applied.provider].models.map((entry) => entry.value);
      if (!providerModels.includes(settingsModel.edits.model)) {
        settingsModel.edits.model = elements.model.value;
      }
    }
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

// ---- Init gate: user actions never touch settings before they are loaded ----
// The single init-ready promise, settled exactly once: resolved when
// initialize() has merged storage into the settings model, REJECTED when
// initialization failed. Every settings-touching user action awaits it via
// whenReady() — awaiting actions must see the failure (and show its error)
// instead of hanging forever or proceeding against the pre-init
// DEFAULT_SETTINGS snapshot (Codex P1: Export clicked before init finished
// shipped a backup of defaults with no keys). The handler below only renders
// the failure status; it must not swallow the rejection.
const initializePromise = initialize();
let initSettled = false;
let initError = null;
initializePromise.then(
  () => {
    initSettled = true;
  },
  (error) => {
    initSettled = true;
    initError = error ?? new Error("初始化失败");
    setStatus("无法初始化", initError.message || String(initError), "error");
  }
);

// Wrap a user action so it runs only once initialization settled. While init
// is pending, the model and the controls still hold DEFAULT_SETTINGS, so an
// unguarded click could export/import/test/translate/save with defaults and
// no keys. If init failed, the action re-surfaces init's error and stops.
// Once init settled successfully the wrapper dispatches synchronously, so
// listener behavior (and its storage writes) stays on the event's own tick.
function whenReady(action) {
  return (...args) => {
    if (initSettled) {
      if (initError) {
        setStatus("无法初始化", initError.message || String(initError), "error");
        return undefined;
      }
      return action(...args);
    }
    return (async () => {
      try {
        await initializePromise;
      } catch (error) {
        setStatus("无法初始化", error?.message || String(error), "error");
        return undefined;
      }
      return action(...args);
    })();
  };
}

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


elements.selectionConfirmBtn.addEventListener("click", whenReady(() => confirmPendingSelection()));

// Not whenReady-gated (documented allowlist in scripts/ci-check.mjs):
// dismissing only clears worker/page selection state and never reads or
// writes settings — and the panel itself only appears after init.
elements.selectionConfirmDismiss.addEventListener("click", () => {
  void dismissPendingSelection();
});

// Not whenReady-gated (allowlisted): pure input visibility toggle, no
// settings access.
elements.toggleKey.addEventListener("click", () => {
  const revealing = elements.apiKey.type === "password";
  elements.apiKey.type = revealing ? "text" : "password";
  elements.toggleKey.textContent = revealing ? "隐藏" : "显示";
  elements.toggleKey.setAttribute("aria-label", revealing ? "隐藏 API Key" : "显示 API Key");
});

// Not whenReady-gated (allowlisted in scripts/ci-check.mjs): pure view
// navigation — none of these read or write settings.
if (elements.openSettings) {
  elements.openSettings.addEventListener("click", () => {
    openSettingsView();
  });
}
if (elements.moreSettings) {
  elements.moreSettings.addEventListener("click", () => {
    openSettingsView();
  });
}
if (elements.backMain) {
  elements.backMain.addEventListener("click", () => {
    viewState.userOpenedSettings = false;
    renderView();
  });
}
if (elements.providerStatus) {
  // The one-line provider status doubles as an action line: in its error
  // state (Key 无效) clicking it opens the settings view with the key input
  // focused, and in its unverified state it re-runs the connection test in
  // place (Codex PR #19 P2). The test reads settings and writes the verdict
  // status, so the whole handler runs behind the init gate — never against
  // the pre-init DEFAULT_SETTINGS snapshot.
  elements.providerStatus.addEventListener("click", whenReady(async () => {
    if (providerStatusAction !== "test") {
      openSettingsView({ focusKey: true });
      return;
    }
    const key = elements.apiKey.value.trim();
    if (!key || key !== providerKeyValue(activeProvider())) {
      openSettingsView({ focusKey: true });
      return;
    }
    elements.providerStatus.disabled = true;
    try {
      await runKeyConnectionTest("click");
    } finally {
      elements.providerStatus.disabled = false;
    }
  }));
}
if (elements.openShortcuts) {
  elements.openShortcuts.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}
if (elements.setupFeedback) {
  // The setup card's 上次验证失败 message doubles as the re-test link
  // (Codex PR #19 P2): clicking it re-runs the connection test for the key
  // input's current value. Gated on init — the test reads settings and writes
  // the verdict status through the queue.
  elements.setupFeedback.addEventListener("click", whenReady(async () => {
    if (currentView() !== "setup" || elements.setupFeedback.dataset.retest !== "true") {
      return;
    }
    const key = elements.apiKey.value.trim();
    if (!key || apiKeyFormatReason(key)) {
      return;
    }
    await runKeyConnectionTest("click");
  }));
}

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
    persistSettingsInBackground();
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
  persistSettingsInBackground();
}

// The sanctioned fire-and-forget save shape (the ONLY one — ci-check's
// static pass rejects un-awaited, un-caught saveSettings() calls): debounce
// ticks, change/blur persists and init's closing flush have no caller left
// to await the stable save, but a failed write must still surface a status
// instead of dying as an unhandled rejection.
function persistSettingsInBackground() {
  saveSettings().catch((error) => {
    setStatus("保存设置失败", error?.message || String(error), "error");
  });
}

// Not whenReady-gated (allowlisted): banking the edit pre-init is exactly
// what must happen — a dirty field survives init's reconcile, and
// initialize() flushes banked edits at its end. Only the SAVE and the
// verification request are gated (change/blur/paste below).
elements.apiKey.addEventListener("input", () => {
  // Any edit invalidates an in-flight connection test for the old value.
  keyTestOp += 1;
  markKeyEdit();
  schedulePersistSettings();
  renderKeyStatus();
  // PR #19 follow-up: typing a format-valid value asks for its (debounced)
  // verification — the request itself waits for init inside; the synchronous
  // banking above is unchanged and is what pre-init edits rely on.
  void whenReady(() => {
    if (!apiKeyFormatReason(elements.apiKey.value)) {
      runKeyConnectionTest("input");
    }
  })();
});
// Codex PR #19 P1: change/blur auto-tests go through the shared verifier as
// debounced "change"/"blur" triggers — one request per (provider, key).
elements.apiKey.addEventListener("change", whenReady(() => handleApiKeyCommit("change")));
elements.apiKey.addEventListener("blur", whenReady(() => handleApiKeyCommit("blur")));
// Paste → auto-save + auto connection test. The pasted value lands after the
// default paste action, so run on the next tick.
elements.apiKey.addEventListener("paste", () => {
  setTimeout(() => {
    // Bank the pasted value BEFORE awaiting the init gate: reconcile() never
    // overwrites a dirty field, so the paste survives initialize() applying
    // the stored key to the input while the gate is still pending. The save
    // and the connection test then run through the gate below.
    markKeyEdit();
    void whenReady(handleApiKeyPasted)();
  }, 0);
});
elements.provider.addEventListener("change", () => {
  selectProvider(elements.provider.value);
  // The edits banked by selectProvider are pre-init-safe (dirty fields
  // survive init's reconcile); only the SAVE waits for the init gate, so it
  // diffs against the loaded snapshot — never the pre-init defaults.
  void whenReady(persistSettingsNow)();
});

// The setup card's provider radios select the SAME single provider control
// (#provider lives in the settings view) through the same selectProvider
// logic and the same init-gated save.
for (const option of elements.providerOptions) {
  // Not whenReady-gated (allowlisted): banks the provider/model edits
  // synchronously (pre-init banking is the designed behavior); the save goes
  // through whenReady inside.
  option.addEventListener("click", () => {
    const nextProvider = option.dataset.provider;
    if (!PROVIDER_META[nextProvider] || nextProvider === elements.provider.value) {
      renderSetupProviderChoice();
      return;
    }
    selectProvider(nextProvider);
    void whenReady(persistSettingsNow)();
  });
}
elements.targetLanguage.addEventListener("change", () => {
  settingsModel.edits.targetLanguage = elements.targetLanguage.value;
  void whenReady(persistSettingsNow)();
});
elements.model.addEventListener("change", () => {
  settingsModel.edits.model = elements.model.value;
  renderProviderStatus();
  void whenReady(persistSettingsNow)();
});
// Closing/hiding a view flushes a still-pending debounced edit — and, once
// init has completed, any other unsaved dirty edit (e.g. one banked before
// initialization finished, which never got a debounce). Still dirty-only:
// edits are otherwise saved immediately, so an idle (possibly stale) view
// never writes its snapshot back over newer settings from another view.
// Intentionally not awaited (documented fire-and-forget): pagehide cannot
// await anything — the page is going away — so the write just goes through
// the serialized queue; its rejection is still .catch-handled with a status
// render (persistSettingsInBackground), which matters for the
// visibilitychange path, where the page stays alive.
function flushPendingPersist() {
  if (persistTimer || (initialized && Object.keys(settingsModel.edits).length)) {
    persistSettingsNow();
  }
}
// Not whenReady-gated (allowlisted): the flush must attempt at hide time,
// synchronously — and it cannot fire early anyway: flushPendingPersist
// no-ops before init (`initialized`), and initialize() flushes any edit
// banked during its reads at its end.
window.addEventListener("pagehide", flushPendingPersist);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingPersist();
  }
});

elements.modeButtons.forEach((button) => {
  // Gated as a whole: the clicked mode is read from the button's static
  // dataset (never from live control state), so parking the handler on the
  // init gate cannot lose the click to init's own reconcile.
  button.addEventListener("click", whenReady(async () => {
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
    try {
      await saveSettings();
    } catch (error) {
      // The mode stays banked as a dirty edit; the page is not messaged
      // with a mode that never reached storage.
      setStatus("保存设置失败", toFriendlyPageError(error), "error");
      return;
    }
    if (op !== displayModeOp) {
      return;
    }
    // The save may have been overtaken by a newer stored mode delivered
    // while its write was in flight (another view changed the preference):
    // the radiogroup and the page below follow the snapshot's effective
    // mode, never the value this click wrote.
    const effectiveMode = Utils.normalizeDisplayMode(settingsModel.snapshot.displayMode);
    if (effectiveMode !== currentDisplayMode) {
      currentDisplayMode = effectiveMode;
      renderDisplayMode();
    }

    if (!currentTab?.id) {
      return;
    }

    try {
      await ensureContentScript(currentTab.id);
      if (op !== displayModeOp) {
        return;
      }
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        type: "SET_DISPLAY_MODE",
        displayMode: currentDisplayMode
      });
      if (op !== displayModeOp) {
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
  }));
});

elements.testConnection.addEventListener("click", whenReady(async () => {
  if (!validateApiKey()) {
    return;
  }

  // Same tokenized path as paste validation: a newer test (manual or
  // paste) or any other status supersedes an older completion. The manual
  // click may re-run even when a settled verdict is cached (trigger "click").
  elements.testConnection.disabled = true;
  elements.testConnection.textContent = "正在测试…";
  try {
    await runKeyConnectionTest("click");
  } finally {
    elements.testConnection.disabled = false;
    elements.testConnection.textContent = "测试 API 连接";
  }
}));

elements.translate.addEventListener("click", whenReady(async () => {
  if (!validateApiKey()) {
    return;
  }

  elements.translate.disabled = true;
  setStatus("正在启动翻译", "识别当前页面中的段落内容", "loading");

  try {
    let settings;
    try {
      // Resolves only when the save is STABLE (all follow-up writes
      // committed, no dirty edit left) — the page must never start
      // translating against settings still being written.
      settings = await saveSettings();
    } catch (error) {
      setStatus("保存设置失败", toFriendlyPageError(error), "error");
      return;
    }
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
}));

// Not whenReady-gated (allowlisted): restore only messages the page
// (RESTORE_ORIGINAL) and renders its status — no settings read or write.
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
    setStatus("当前页面尚未翻译", "点击「翻译此页」开始，或选中文字按 Alt+T", "idle");
  }
});

// Not whenReady-gated (allowlisted): the retry only messages the page
// (RETRY_FAILED — the content script retries JUST the failed blocks: no
// restore, no re-billing of finished segments); the popup reads no settings.
if (elements.retryFailed) {
  elements.retryFailed.addEventListener("click", async () => {
    if (!currentTab?.id) {
      return;
    }
    elements.retryFailed.disabled = true;
    try {
      await ensureContentScript(currentTab.id);
      const response = await chrome.tabs.sendMessage(currentTab.id, { type: "RETRY_FAILED" });
      if (!response?.ok) {
        throw new Error(response?.error || "重试失败");
      }
      if (response.status?.displayMode) {
        currentDisplayMode = Utils.normalizeDisplayMode(response.status.displayMode);
        renderDisplayMode();
      }
      renderTranslationStatus(response.status);
      startStatusPolling();
    } catch (error) {
      setStatus("重试失败", toFriendlyPageError(error), "error");
    } finally {
      elements.retryFailed.disabled = false;
    }
  });
}

// Not whenReady-gated (allowlisted): the HTML export / print run inside the
// content script from its own state; the popup reads no settings here.
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

elements.exportSettings.addEventListener("click", whenReady(() => exportSettingsFile()));

// Chromium (Linux, ~128–130, crbug 364825891) can destroy an action popup
// when a file chooser opens, so the import never runs. Import therefore runs
// from popup.html opened as a normal extension tab (?view=settings, detected
// as IS_SETTINGS_TAB at the top of this file), which survives the chooser.

// Not whenReady-gated (allowlisted): this only opens the file chooser (or
// the settings tab); the import itself is the gated import-file change
// handler below, which merges into the loaded model only.
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

elements.importFile.addEventListener("change", whenReady(() => {
  const file = elements.importFile.files && elements.importFile.files[0];
  elements.importFile.value = "";
  if (!file) {
    return undefined;
  }
  return importSettingsFile(file);
}));

async function initialize() {
  // Async reads that do not touch settings state come first, so the storage
  // read below is the LAST read: any onChanged delivered while these were in
  // flight already merged into the model, and this fresh read observes those
  // same writes — a stale first snapshot can never roll a newer value back.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  // Restricted detection needs only the tab URL — settle it BEFORE the
  // storage read and the setup-mode decision below (Codex PR #19 P2-2): a
  // restricted page must open straight on the main view's cannot-translate
  // notice, with no flash of the setup card that could stick.
  pageRestricted = await detectRestrictedPage();

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
  // Edits banked while the reads above were still pending never got their
  // debounce (schedulePersistSettings is a no-op before init): flush them now
  // through the serialized queue, or closing this view would drop them.
  // Intentionally fire-and-forget (documented): init itself must complete so
  // gated user actions can run — the flush is serialized and .catch-handled
  // by persistSettingsInBackground, and gated actions coalesce behind it.
  if (Object.keys(settingsModel.edits).length) {
    persistSettingsInBackground();
  }

  // 1.5.0 embedded setup: without a key for the ACTIVE provider the popup
  // opens as the two-step setup card — no translate button to click into an
  // error, and no idle status line. So does a key whose LAST persisted
  // verification failed (Codex PR #19 P2): translate must stay unreachable
  // until the key is replaced or re-verified. With a (mere) unverified key it
  // opens as the main view, whose provider line offers a one-click re-test.
  viewState.setupMode =
    !providerKeyValue(activeProvider()) ||
    keyVerificationStatus(activeProvider()) === "failed";
  setupRejectedKey = "";
  renderView();
  renderStaticInfo();
  if (viewState.setupMode && keyVerificationStatus(activeProvider()) === "failed") {
    renderStoredKeyFailure();
  }

  if (!currentTab?.id) {
    throw new Error("找不到当前标签页");
  }

  // Restricted pages (chrome://, Web Store, about:, file: without access)
  // can never take the injection: say so up front instead of failing on the
  // first click, and disable the actions that would only error. Detection
  // already settled above (before the setup decision); this only renders.
  if (pageRestricted) {
    renderRestrictedNotice();
  }

  try {
    await ensureContentScript(currentTab.id);
  } catch {
    // Injection refused: without the tabs permission the popup could not read
    // the URL, so a chrome:// / store / file: page may have passed the URL
    // probe above — but executeScript (and the PING before it) refusing is
    // definitive. Mark the page restricted from behavior: the cannot-translate
    // notice renders in the MAIN view and 翻译此页 disables, and restricted
    // keeps winning over setup in currentView(), so a no-key popup shows the
    // notice instead of a setup card whose verification could never be used.
    pageRestricted = true;
    renderView();
    renderRestrictedNotice();
  }
  if (!pageRestricted) {
    try {
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
      // PING answered, so the page is not restricted; GET_STATUS trouble is inert.
    }
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
    // content.js's selection gate reads the active provider's per-provider
    // key; the legacy mirror is only its <=1.3.x fallback, so keep it in
    // step with the active provider's key on every write.
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

// ---- 1.5.0 views: main / setup / settings ----

// #app[data-view] drives which section CSS shows. The ONE view decider
// (Codex PR #19 P2-2): settings (user-opened / settings tab) wins as today,
// then a RESTRICTED page beats the setup card — a chrome:// page can never
// take the injection, so with no key it must still open on the MAIN view with
// the cannot-translate notice and a disabled 翻译此页, never on a setup card
// whose verification could never be used here. Otherwise setup wins over main
// while the active provider has no usable key.
function currentView() {
  if (IS_SETTINGS_TAB || viewState.userOpenedSettings) {
    return "settings";
  }
  if (pageRestricted) {
    return "main";
  }
  return viewState.setupMode ? "setup" : "main";
}

function renderView() {
  const view = currentView();
  if (elements.app) {
    elements.app.dataset.view = view;
  }
  // #key-entry is authored inside #settings-key-slot; the setup view borrows
  // the whole block (label + input + guide) into its own slot.
  const slot = view === "setup" ? elements.setupKeySlot : elements.settingsKeySlot;
  if (elements.keyEntry && slot && elements.keyEntry.parentNode !== slot) {
    slot.appendChild(elements.keyEntry);
  }
  renderSetupProviderChoice();
}

function openSettingsView({ focusKey = false } = {}) {
  viewState.userOpenedSettings = true;
  renderView();
  if (focusKey && elements.apiKey) {
    elements.apiKey.focus();
  }
}

// Leave the embedded setup card once the active provider's key is present,
// format-valid and not the one a connection test just rejected. A test that
// is still in flight defers the decision: the paste-and-verify flow must
// resolve on the test's verdict, never on the storage echo of its own save.
function evaluateSetupExit() {
  if (!viewState.setupMode) {
    return;
  }
  if (keyTestPendingOp && keyTestPendingOp === keyTestOp) {
    return;
  }
  const key = providerKeyValue(activeProvider());
  if (!key || apiKeyFormatReason(key) || key === setupRejectedKey) {
    return;
  }
  // A stored "failed" verdict for this exact key keeps the setup card up
  // (Codex PR #19 P2): the key was proven bad and the translate button must
  // stay unreachable until the key is replaced or re-verified.
  if (keyVerificationStatus(activeProvider()) === "failed") {
    renderStoredKeyFailure();
    return;
  }
  viewState.setupMode = false;
  renderView();
}

// Route a setup-flow status line into #setup-feedback (the status card lives
// in the main view and is not used while setup owns the popup); returns true
// when consumed so callers fall back to the status card everywhere else.
function renderSetupFeedback(text) {
  if (currentView() !== "setup" || !elements.setupFeedback) {
    return false;
  }
  elements.setupFeedback.textContent = text;
  // Any newer message replaces the stored-failure re-test affordance (its
  // click handler keys off data-retest).
  delete elements.setupFeedback.dataset.retest;
  return true;
}

// The setup card's message for a key whose LAST persisted verification failed
// (Codex PR #19 P2): the popup reopened straight into setup for it, with the
// message itself as the one-click re-test link.
function renderStoredKeyFailure() {
  if (currentView() !== "setup" || !elements.setupFeedback) {
    return;
  }
  elements.setupFeedback.textContent = "上次验证失败：请重新粘贴或重新测试";
  elements.setupFeedback.dataset.retest = "true";
}

// The setup card's radios mirror the single provider control. Console and
// pricing links follow the provider switch (Codex PR #19 P2-4) — both URLs
// come from the ONE PROVIDER_LINKS table in shared.js, never duplicated
// literals. #setup-pricing-link is null-safe: the UI agent may not have
// landed the popup.html edit yet.
function renderSetupProviderChoice() {
  const provider = activeProvider();
  for (const option of elements.providerOptions) {
    option.setAttribute("aria-checked", option.dataset.provider === provider ? "true" : "false");
  }
  const meta = PROVIDER_META[provider];
  if (elements.setupConsoleLink) {
    elements.setupConsoleLink.href = meta.keyUrl;
    elements.setupConsoleLink.textContent = `打开 ${meta.label} 控制台 ↗`;
  }
  if (elements.setupPricingLink) {
    elements.setupPricingLink.href = meta.pricingUrl;
  }
}

// Provider selection from EITHER surface — the settings-view #provider
// select (change) or the setup card's radio buttons. Both bank their edits
// synchronously and route the SAVE through whenReady at the call site.
function selectProvider(rawProvider) {
  const nextProvider = PROVIDER_META[rawProvider] ? rawProvider : "deepseek";
  // Any unsaved edit of the previous provider's key is already banked in
  // settingsModel.edits by its input events — switching neither loses nor
  // mixes the two credentials. Drop any in-flight test for the old key, and
  // abandon the departed provider's verifier state: a still-pending
  // debounced run for its value must not fire (and bill a stale
  // TEST_CONNECTION) after the switch (Codex PR #19 P1).
  keyTestOp += 1;
  if (nextProvider !== activeProvider()) {
    keyVerifier.forget(activeProvider());
  }
  if (elements.provider.value !== nextProvider) {
    elements.provider.value = nextProvider;
  }
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
  providerKeyInvalid = false;
  setupRejectedKey = "";
  renderKeyStatus();
  renderSetupProviderChoice();
}

// ---- Provider status line (main view) ----

const MODEL_SHORT_NAMES = {
  "deepseek-flash": "Flash",
  "deepseek-v4-pro": "V4 Pro",
  "kimi-k2.6": "K2.6",
  "kimi-k3": "K3",
  "moonshot-v1-128k": "128k"
};

function renderProviderStatus() {
  if (!elements.providerStatus || !elements.providerStatusLabel) {
    return;
  }
  const provider = activeProvider();
  const meta = PROVIDER_META[provider];
  const key = providerKeyValue(provider);
  if (providerKeyInvalid) {
    providerStatusAction = "settings";
    elements.providerStatus.dataset.tone = "error";
    elements.providerStatusLabel.textContent = `${meta.label} Key 无效 · 点此更新`;
  } else if (key) {
    const status = keyVerificationStatus(provider);
    if (status === "verified") {
      providerStatusAction = "settings";
      elements.providerStatus.dataset.tone = "ok";
      elements.providerStatusLabel.textContent = `✓ ${meta.label} 已连接`;
    } else {
      // Unverified (no test yet — including every 1.4.3 upgrade with no
      // status field) or a stored failed verdict: the key was never (or not
      // currently) proven, so the line offers the re-test instead of a
      // configured-ok claim (Codex PR #19 P2).
      providerStatusAction = "test";
      elements.providerStatus.dataset.tone = "warn";
      elements.providerStatusLabel.textContent =
        status === "failed"
          ? `${meta.label} Key 验证失败 · 点此重新测试`
          : `${meta.label} Key 未验证 · 点此重新测试`;
    }
  } else {
    providerStatusAction = "settings";
    elements.providerStatus.dataset.tone = "missing";
    elements.providerStatusLabel.textContent = `${meta.label} 未配置 · 点此填写`;
  }
  if (elements.providerStatusMeta) {
    const model = MODEL_SHORT_NAMES[elements.model.value] || elements.model.value || "";
    const tail = keyTail(key);
    elements.providerStatusMeta.textContent = tail ? `${model} · ••${tail}` : model;
  }
}

// A page translation error that smells like a key problem (401 / Key 无效)
// turns the provider line into its actionable error state.
function noteProviderKeyError(errorText) {
  if (/API\s*Key|401|Key 无效/i.test(String(errorText || ""))) {
    providerKeyInvalid = true;
    renderProviderStatus();
  }
}

// ---- Static chrome info: version + live shortcut labels ----

function renderStaticInfo() {
  if (elements.appVersion) {
    elements.appVersion.textContent = chrome.runtime.getManifest().version;
  }
  void loadShortcutLabels();
}

const SHORTCUT_COMMANDS = [
  { name: "translate-page", element: "translateShortcut", fallback: "Alt+A", label: "翻译此页" },
  { name: "translate-selection", element: "selectionShortcut", fallback: "Alt+T", label: "翻译选中文字" }
];

// Shortcut labels are read at runtime when chrome.commands exists (the user
// may rebind or unbind); missing bindings render as 未设置, and environments
// without the API keep the suggested-key defaults from the markup.
async function loadShortcutLabels() {
  const api = globalThis.chrome?.commands;
  if (typeof api?.getAll !== "function") {
    return;
  }
  let commands;
  try {
    commands = await api.getAll();
  } catch {
    return;
  }
  const shortcutOf = (name, fallback) => {
    for (const command of commands || []) {
      if (command?.name === name) {
        return command.shortcut || "未设置";
      }
    }
    return fallback;
  };
  for (const { name, element, fallback } of SHORTCUT_COMMANDS) {
    const target = elements[element];
    if (target) {
      target.textContent = shortcutOf(name, fallback);
    }
  }
  if (elements.shortcutList) {
    const rows = SHORTCUT_COMMANDS.map(
      ({ name, fallback, label }) =>
        `<li><span>${label}</span><kbd>${escapeHtml(shortcutOf(name, fallback))}</kbd></li>`
    );
    elements.shortcutList.innerHTML = rows.join("");
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

// ---- Restricted pages ----

// chrome://, edge://, about:, the Chrome Web Store and (without the user's
// file-access grant) file:// pages can never receive the content script.
function detectRestrictedPage() {
  const url = String(currentTab?.url || currentTab?.pendingUrl || "");
  if (!url) {
    return Promise.resolve(false);
  }
  if (/^(chrome|edge|about|devtools|view-source|chrome-error|javascript|data):/i.test(url)) {
    return Promise.resolve(true);
  }
  if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    return Promise.resolve(true);
  }
  if (/^file:/i.test(url)) {
    return new Promise((resolve) => {
      let settled = false;
      // The promise reports whether the page IS restricted: without the
      // user's file-access grant (or without the API at all) it is.
      const settle = (allowed) => {
        if (!settled) {
          settled = true;
          resolve(allowed !== true);
        }
      };
      try {
        const api = globalThis.chrome?.extension;
        if (typeof api?.isAllowedFileSchemeAccess !== "function") {
          settle(false);
          return;
        }
        const maybePromise = api.isAllowedFileSchemeAccess(settle);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(settle, () => settle(false));
        }
      } catch {
        settle(false);
      }
    });
  }
  return Promise.resolve(false);
}

function renderRestrictedNotice() {
  if (elements.translate) {
    elements.translate.disabled = true;
  }
  if (elements.restore) {
    elements.restore.disabled = true;
  }
  setStatus("这个页面不能翻译", "Chrome 内置页面和应用商店不允许扩展注入，请打开普通网页", "error");
}

// ---- Serialized settings saves ----
// At most one chrome.storage.local.set from this view runs at a time: two
// concurrent writes could land out of order and let an older save's value
// overwrite a newer edit. saveSettings() calls that arrive while a save is in
// flight coalesce into ONE follow-up save started once that save settles —
// every queued caller awaits that same follow-up. A save that FAILS rejects
// for the initiating caller and for every coalesced caller alike (the dirty
// edits stay dirty, so the next action retries them).
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
    settingsSaveFollowUp = settingsSaveInFlight.then(
      () => {
        settingsSaveFollowUp = null;
        return saveSettings();
      },
      (error) => {
        // Reset the slot on failure too, or a later save would hand every
        // new caller this stale rejection forever; rethrow so every caller
        // coalesced behind the failed write sees the same failure.
        settingsSaveFollowUp = null;
        throw error;
      }
    );
  }
  return settingsSaveFollowUp;
}

async function runSettingsSave() {
  let settle;
  settingsSaveInFlight = new Promise((resolve) => {
    settle = resolve;
  });
  try {
    return await performSettingsSaveUntilStable();
  } finally {
    settle();
    settingsSaveInFlight = null;
  }
}

// Safety valve: one saveSettings() call may not chase mid-write edits
// forever. Convergence is structural — an edit settles once it equals what a
// save established, and every dirty field is collected every round — so
// rounds only continue while edits keep arriving mid-write. The cap turns a
// pathological non-converging case into a rejection instead of a hang (the
// edits stay dirty either way, so the next action retries them).
const SETTINGS_SAVE_MAX_ROUNDS = 10;

// Codex P1: a save used to resolve when ITS OWN write finished, while the
// follow-up write a mid-flight retype forced was fire-and-forget — translate,
// key test, selection confirm and import could then run with newer edits
// still unsaved. One saveSettings() call now spans save → settle → follow-up
// save → … until the view is STABLE: this call's writes all committed, in
// order, through the serialized queue (nothing else can enqueue behind them —
// every other writer coalesces into this very call), and no dirty edit
// remains pending. Any write failure rejects here and reaches the initiating
// caller AND every coalesced caller. Callers that need persisted settings
// (translate, selection confirm, key test, import, export, display-mode send)
// await exactly this promise.
async function performSettingsSaveUntilStable() {
  let last;
  for (let round = 0; ; round += 1) {
    if (round >= SETTINGS_SAVE_MAX_ROUNDS) {
      throw new Error(`保存设置未能收敛（已连续 ${SETTINGS_SAVE_MAX_ROUNDS} 轮），请稍后重试`);
    }
    last = await performSettingsSave();
    if (!last.followUpNeeded && Object.keys(settingsModel.edits).length === 0) {
      return last.settings;
    }
  }
}

// Save = flush the pending user edits ONLY. Fields the user never touched
// (including newer values other views wrote underneath) are never written
// from here, so a stale idle view cannot restore old values over new ones.
async function performSettingsSave() {
  const controlValues = readControlValues();
  const { patch, savedValues } = collectDirtyPatch(settingsModel, controlValues);
  // Fields whose snapshot revision advanced while our write was in flight:
  // storage delivered a NEWER value for them after this write committed, and
  // completion must keep it instead of stamping this (now older) write's
  // value back over the snapshot.
  const overtakenFields = [];
  if (Object.keys(patch).length) {
    // Revisions as they stand at write START, before any onChanged of the
    // committing value can reach us.
    const revisionsAtStart = {};
    for (const field of Object.keys(patch)) {
      revisionsAtStart[field] = settingsModel.revisions[field] || 0;
    }
    await enqueueSettingsWrite(patch);
    for (const [field, value] of Object.entries(patch)) {
      if ((settingsModel.revisions[field] || 0) === revisionsAtStart[field]) {
        settingsModel.snapshot[field] = value;
      } else {
        overtakenFields.push(field);
      }
    }
  }
  // The collected edits resolve only when they still equal what this save
  // established in storage: an edit retyped while the write was in flight
  // stays dirty (the control keeps it) and gets one follow-up round — driven
  // by the caller's loop in performSettingsSaveUntilStable, never a
  // fire-and-forget save.
  const followUpNeeded = settleSavedEdits(settingsModel, savedValues);
  // An overtaken field now holds another view's newer value in the snapshot;
  // its control could not take that value when it arrived (the field was
  // dirty with this save's edit). Now that the edit settled, follow the
  // stored value — a retyped edit stays dirty and keeps the control.
  for (const field of overtakenFields) {
    if (!(field in settingsModel.edits)) {
      applyFieldsToControls({ [field]: settingsModel.snapshot[field] });
    }
  }
  renderKeyStatus();
  // Post-save actions (translate start, key test, export) read the view as
  // it stands AFTER the write, so a field another view updated mid-flight
  // reports the newer effective value, never the stale one this save carried.
  const effectiveValues = readControlValues();
  return {
    followUpNeeded,
    settings: {
      ...effectiveValues,
      // Legacy mirror for content.js's selection key gate.
      apiKey: effectiveValues[PROVIDER_META[effectiveValues.provider].keyField]
    }
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
    if (!key) {
      value.textContent = "未配置";
      row.dataset.tone = "missing";
      continue;
    }
    const tail = keyTail(key);
    const status = keyVerificationStatus(id);
    if (status === "verified") {
      value.textContent = tail ? `已连接 · 尾号 ${tail}` : "已连接";
      row.dataset.tone = "ok";
    } else if (status === "failed") {
      value.textContent = tail ? `验证失败 · 尾号 ${tail}` : "验证失败";
      row.dataset.tone = "error";
    } else {
      // No successful test on record for this exact key — including every
      // 1.4.3 upgrade store with no status field (Codex PR #19 P2).
      value.textContent = tail ? `未验证 · 尾号 ${tail}` : "未验证";
      row.dataset.tone = "warn";
    }
  }
  const activeKey = providerKeyValue(provider);
  if (activeKey && !apiKeyFormatReason(activeKey)) {
    elements.keyGuide.hidden = true;
    elements.keyGuide.classList.remove("highlight");
    elements.apiKey.classList.remove("attention");
  }
  renderProviderStatus();
}

// Expand + highlight the key entry step (both providers' console links) when
// an action is blocked on a missing key — not just a red status line.
function revealKeyEntry() {
  elements.keyGuide.hidden = false;
  elements.keyGuide.classList.add("highlight");
  elements.apiKey.classList.add("attention");
}

// ---- Paste → auto-save + auto connection test ----

// The shared key-verification queue (Codex PR #19 P1): paste, change, blur
// and the manual 测试 button all funnel through ONE gate per (provider, key),
// so one paste — which fires paste+input+change+blur — bills exactly ONE
// TEST_CONNECTION instead of up to four. run() keeps today's order: the
// awaited STABLE save first, then TEST_CONNECTION, so the tested key is the
// one storage hands the worker.
const keyVerifier = Utils.createKeyVerifier({
  run: async (provider, key) => {
    let settings;
    try {
      settings = await saveSettings();
    } catch (error) {
      return {
        ok: false,
        code: "SAVE_FAILED",
        error: toFriendlyPageError(error),
        transient: true
      };
    }
    // The stable save may settle a different key than the one this
    // verification was asked about (a racing retype/switch). PR #19 follow-up:
    // the save and the test must describe the SAME value, so the run stops
    // here — testing whatever storage now holds would bill a request whose
    // verdict describes no live identity, and the newer value runs (and is
    // tested) on its own trigger. This transient non-verdict is never cached,
    // and the caller's staleness checks discard it.
    const mismatched = provider !== settings.provider ||
      String(settings[PROVIDER_META[provider].keyField] || "").trim() !== key;
    if (mismatched) {
      return { ok: false, code: "KEY_SUPERSEDED", error: "Key 已修改，正在验证新值", transient: true };
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TEST_CONNECTION",
        provider: settings.provider,
        targetLanguage: settings.targetLanguage,
        model: settings.model
      });
      if (response?.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        code: String(response?.code || ""),
        error: String(response?.error || "")
      };
    } catch (error) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        error: toFriendlyPageError(error),
        transient: true
      };
    }
  }
});

// Change/blur commits the key edit (immediate persist through the queue) and
// asks for its verification — in the embedded setup card AND the settings
// key field (PR #19 follow-up: a typed key deserves the verification a
// pasted one gets; the verifier dedupes blur/change against the burst that
// came before). Format errors stay local; inside setup they still explain
// themselves on the card. An UNTOUCHED field never bills a surprise test:
// blur of a value identical to the last-known stored key requests nothing —
// any real edit already queued its own (debounced) verification.
async function handleApiKeyCommit(trigger) {
  persistSettingsNow();
  const raw = elements.apiKey.value;
  const key = raw.trim();
  if (!key) {
    return;
  }
  const formatReason = apiKeyFormatReason(raw);
  if (formatReason) {
    if (viewState.setupMode) {
      renderSetupFeedback(`✗ ${formatReason}`);
    }
    return;
  }
  const storedKey = String(
    settingsModel.snapshot[PROVIDER_META[activeProvider()].keyField] || ""
  ).trim();
  if (key === storedKey) {
    return;
  }
  await runKeyConnectionTest(trigger);
}

// Paste → the auto connection test runs through the shared verifier, which
// joins the paste+input+change+blur burst into ONE TEST_CONNECTION for the
// pasted value (PR #19 P1) and always saves before testing.
async function handleApiKeyPasted() {
  const label = PROVIDER_META[activeProvider()]?.label || "API";
  // A paste is a user edit: bank it before the auto-save below.
  markKeyEdit();
  persistSettingsNow();
  renderKeyStatus();
  const key = elements.apiKey.value.trim();
  if (!key) {
    if (!renderSetupFeedback("已清空，请重新粘贴 Key")) {
      setStatus("Key 已清空", `下次翻译前请重新填写 ${label} API Key`, "idle");
    }
    return;
  }
  // Format gate before any network call: a paste accident fails in ms with a
  // clear reason instead of a confusing 401.
  const formatReason = apiKeyFormatReason(elements.apiKey.value);
  if (formatReason) {
    keyTestOp += 1;
    if (!renderSetupFeedback(`✗ ${formatReason}`)) {
      revealKeyEntry();
      setStatus("Key 格式错误", `${formatReason}（已保存本机，未发起网络验证）`, "error");
    }
    return;
  }
  await runKeyConnectionTest("paste");
}

// Persist a (non-stale) connection-test verdict as the provider's verification
// status through the ONE serialized write queue (Codex PR #19 P2): "verified"
// on success, "failed" for definitive failures. Transient failures
// (network/timeout/429/5xx) say nothing about the key and leave the
// "unverified" the key's own save wrote. A failed write must not hide the
// verdict itself — the status just stays "unverified".
async function persistKeyVerdict(provider, key, result) {
  const status = result?.ok
    ? "verified"
    : Utils.isTransientKeyVerdict(result) ? null : "failed";
  if (!status) {
    return;
  }
  const patch = Utils.keyStatusPatch(provider, status, key);
  try {
    await enqueueSettingsWrite(patch);
    // Merge our own committed write into the snapshot right away (exactly
    // what the storage.onChanged echo will deliver later): the verdict render
    // that follows must read the status it just persisted — a failed verdict
    // has no session flag (keyVerified covers only success), so without this
    // the row would read 未验证 until the echo arrived.
    reconcile(patch);
  } catch {
    // The verdict still renders; the status stays "unverified".
  }
}

// All key-verification triggers (paste / change / blur / manual click) end up
// here: tokenized status writes (keyTestOp/keyTestPendingOp semantics are
// unchanged — a newer test, save or status still supersedes an older
// completion), with the provider request itself deduped by the shared
// verifier. `keyArg` defaults to the key input's current value.
async function runKeyConnectionTest(trigger = "click", keyArg = null) {
  const provider = activeProvider();
  const key = keyArg !== null ? keyArg : elements.apiKey.value.trim();
  const label = PROVIDER_META[provider]?.label || "API";
  const op = ++keyTestOp;
  keyTestPendingOp = op;
  if (!renderSetupFeedback(`正在验证 ${label} Key…`)) {
    renderStatus(`正在验证 ${label} Key`, "发送一条最小测试请求", "loading");
  }
  try {
    const result = await keyVerifier.request(provider, key, { trigger });
    // A superseded request (a newer value replaced it) or a stale op (a newer
    // test/status arrived) renders nothing — the newest flow owns the UI.
    if (result?.superseded || op !== keyTestOp) {
      return;
    }
    // Codex PR #19 P2 (stale verification): the verdict describes only the
    // provider+key it was requested for. Apply it — the per-provider status
    // write included — only while this popup still sits on that provider and
    // the key input still holds that exact value; a result for a value the
    // user already replaced flips nothing.
    if (provider !== activeProvider() || elements.apiKey.value.trim() !== key) {
      return;
    }
    await persistKeyVerdict(provider, key, result);
    // The status write itself took time (it may have queued behind other
    // writes) — re-check before applying the verdict to the UI, or a success
    // for A would flip keyVerified/graduate/render after the user had already
    // moved the input on to B. The persisted verdict stays harmless: its
    // fingerprint names A, so under B it reads back as 未验证.
    if (provider !== activeProvider() || elements.apiKey.value.trim() !== key) {
      return;
    }
    renderKeyTestResult(result, provider, key, label);
  } finally {
    if (keyTestPendingOp === op) {
      keyTestPendingOp = 0;
    }
    // A key that arrived from another surface while this test was in flight
    // deferred the setup decision on its verdict — re-evaluate now.
    evaluateSetupExit();
  }
}

function renderKeyTestResult(result, provider, key, label) {
  if (result?.ok) {
    keyVerified[provider] = true;
    providerKeyInvalid = false;
    setupRejectedKey = "";
    const wasSetup = viewState.setupMode;
    // Say it inside the setup card while the setup view still owns the
    // popup, then graduate — the main view the user lands on answers with
    // its provider status line ("✓ DeepSeek 已连接").
    if (!renderSetupFeedback("✓ 已连接")) {
      renderStatus("Key 有效", `${label} 连接成功，可以开始翻译`, "success");
    }
    if (wasSetup) {
      viewState.setupMode = false;
      renderView();
    }
    renderProviderStatus();
    renderKeyStatus();
    return;
  }
  setupRejectedKey = key;
  const [title, detail] = friendlyKeyTestFailure(result, label);
  if (!renderSetupFeedback(`✗ ${title}：${detail}`)) {
    renderStatus(title, detail, "error");
  }
  renderKeyStatus();
}

function friendlyKeyTestFailure(response, label) {
  const code = String(response?.code || "");
  if (code === "SAVE_FAILED") {
    return ["保存设置失败", response?.error || "写入本机存储失败，请重试"];
  }
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
    // Awaits the STABLE save (follow-up writes included) so the backup
    // matches storage; if the save failed, fall back to the current
    // controls — the export then still reflects what this view shows, and
    // no write failure can block the backup itself.
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
  // Size gate first: file.size is checked before file.text() can run.
  if (file?.size > SETTINGS_IMPORT_MAX_BYTES) {
    setStatus("导入失败", "文件过大（超过 1 MB），请选择本扩展导出的设置文件", "error");
    return;
  }
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
  // Awaited to STABILITY: the caller renders 设置已导入 only after every
  // follow-up write committed — including one carrying an edit the user made
  // to an imported field while this save was in flight.
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

// The retry button shows only when the page still has failed (retryable)
// blocks and nothing is in flight; its label names the count.
function renderRetryFailed(status) {
  if (!elements.retryFailed) {
    return;
  }
  const retryable = Number(
    status?.failedRetryable ?? (Number(status?.failed) > 0 ? status.failed : 0)
  );
  const visible = retryable > 0 && status?.phase !== "translating";
  elements.retryFailed.hidden = !visible;
  if (visible) {
    elements.retryFailed.textContent = `重试失败的 ${retryable} 段`;
  }
}

// The progress bar only fills while translating (its track is hidden by CSS
// unless the card is in the loading tone).
function renderProgress(status) {
  if (!elements.statusProgress) {
    return;
  }
  const total = Number(status?.total || 0);
  const translated = Number(status?.translated || 0);
  const percent = total > 0
    ? Math.max(0, Math.min(100, Math.round((translated / total) * 100)))
    : 0;
  elements.statusProgress.style.width = `${percent}%`;
}

function hideStatusCard() {
  if (elements.statusWrap) {
    elements.statusWrap.hidden = true;
  }
}

function renderTranslationStatus(status) {
  updateExportAvailability(status);
  renderRetryFailed(status);
  renderProgress(status);
  // 还原原文 needs an active (translated) page.
  if (elements.restore) {
    elements.restore.disabled = !status?.active;
  }

  // A restricted tab keeps its cannot-translate notice; no status the page
  // could send may replace it (there should be none — no injection).
  if (pageRestricted) {
    renderRestrictedNotice();
    return;
  }

  if (!status?.active) {
    // No idle card: with nothing to report the whole status area collapses,
    // and any explicit setStatus() brings it back. A still-pending key
    // connection test keeps its own card visible.
    if (!(keyTestPendingOp && keyTestPendingOp === keyTestOp)) {
      hideStatusCard();
    }
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
    noteProviderKeyError(status.error);
    passiveStatus("翻译失败", status.error || "请检查 API 设置后重试", "error");
    return;
  }

  const failed = Number(status.failedRetryable ?? status.failed ?? 0);
  if (failed > 0) {
    passiveStatus(
      "部分未完成",
      `已翻译 ${status.translated} 段，${failed} 段失败（可重试，只重发失败段）`,
      "warning"
    );
    return;
  }

  const modeLabel = {
    bilingual: "双语对照",
    "translation-only": "仅译文",
    original: "原文"
  }[status.displayMode] || "双语对照";
  passiveStatus("翻译已开启", `已翻译 ${status.translated} 段 · ${modeLabel} · 自动跟译新内容`, "success");
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
  // An explicit status always (re)shows the card — the idle collapse in
  // renderTranslationStatus only ever hides it.
  if (elements.statusWrap) {
    elements.statusWrap.hidden = false;
  }
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
    try {
      // Stable save (all follow-up writes committed) before confirming: the
      // page's key gate reads storage the moment the batch is sent.
      await saveSettings();
    } catch (error) {
      // Keep the pending selection and the panel — the confirm stays
      // retryable once the save works. Only a confirmed/expired selection
      // (the outer catch) clears them.
      setStatus("保存设置失败", toFriendlyPageError(error), "error");
      return;
    }
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
