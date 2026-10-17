/* 千浩翻译 1.5.0 — welcome / onboarding page logic.
 * Talks to background only through chrome.runtime.sendMessage;
 * writes only the key-related storage fields (never logs keys).
 * Requires shared.js (loaded first by welcome.html): the shared key
 * verifier dedupes TEST_CONNECTION so one paste bills exactly one request. */
(function () {
  "use strict";

  const Utils = globalThis.DeepSeekTranslatorUtils;

  const $ = (selector) => document.querySelector(selector);

  // welcome.html loads shared.js before welcome.js; if it is missing the page
  // must fail loudly in the DOM (never silently, and without console) — every
  // verification path below depends on it.
  if (!Utils || typeof Utils.createKeyVerifier !== "function" || !Utils.PROVIDER_LINKS) {
    const reasons = [
      [$("#s2-msg"), "扩展文件加载不完整（shared.js 未加载），请回到 chrome://extensions 重新加载扩展后重开本页"],
      [$("#s3-msg"), "扩展文件加载不完整，无法试翻。请重新加载扩展后重开本页"]
    ];
    for (const [el, text] of reasons) {
      if (el) {
        el.textContent = text;
        el.className = "msg er";
      }
    }
    return;
  }

  const PROVIDERS = {
    deepseek: {
      name: "DeepSeek",
      consoleUrl: Utils.PROVIDER_LINKS.deepseek.console,
      pricingUrl: Utils.PROVIDER_LINKS.deepseek.pricing,
      model: "deepseek-flash",
      keyField: "deepseekApiKey"
    },
    kimi: {
      name: "Kimi",
      consoleUrl: Utils.PROVIDER_LINKS.kimi.console,
      pricingUrl: Utils.PROVIDER_LINKS.kimi.pricing,
      model: "kimi-k2.6",
      keyField: "kimiApiKey"
    }
  };

  const SAMPLE_TEXT =
    "Every winter, the rocky shoreline turns into a laboratory of survival. " +
    "Small tide pools lose heat quickly, yet anemones and crabs remain active beneath thin ice. " +
    "A pool only thirty centimetres deeper can hold enough heat through the longest nights.";

  const els = {
    steps: [...document.querySelectorAll("#steps li")],
    views: [$("#step-1"), $("#step-2"), $("#step-3")],
    providerButtons: [...document.querySelectorAll(".pv button")],
    s1Next: $("#s1-next"),
    s1Skip: $("#s1-skip"),
    s2Title: $("#s2-title"),
    s2Console: $("#s2-console"),
    s2Pricing: $("#welcome-pricing-link"),
    s2Field: $("#s2-field"),
    s2Key: $("#s2-key"),
    s2Msg: $("#s2-msg"),
    s2Back: $("#s2-back"),
    s2Next: $("#s2-next"),
    s2Skip: $("#s2-skip"),
    s3Try: $("#s3-try"),
    s3Done: $("#s3-done"),
    s3Skip: $("#s3-skip"),
    s3Msg: $("#s3-msg"),
    sampleResult: $("#sample-result"),
    shortcutPage: $("#shortcut-page"),
    shortcutSelection: $("#shortcut-selection"),
    tipPageKey: $("#tip-page-key"),
    tipSelectionKey: $("#tip-selection-key")
  };

  const hasChrome = typeof chrome !== "undefined" && chrome !== null;
  const canStore = hasChrome && chrome.storage && chrome.storage.local;
  const canMessage = hasChrome && chrome.runtime && chrome.runtime.sendMessage;

  let provider = "deepseek";
  let verified = false;
  // The key this step-2 "verified" state came from: the pasted key itself, or
  // null when an already-stored key was accepted (P2-1: only a NEWLY pasted
  // key is rewritten on persist; an accepted stored key only flips the
  // provider/model/mirror).
  let verifiedKey = null;
  // PR #19 P1-A (专业测试): a stored key is only accepted as-is when its
  // persisted status is "verified" AND <provider>KeyStatusFor matches that
  // key's fingerprint. Any other stored key (unverified, failed, missing
  // status, mismatched fingerprint) puts step 2 into "verify first" mode:
  // 继续 becomes 验证并继续 and runs a real TEST_CONNECTION before anything
  // is marked verified. storedKeyNeedsVerification holds the provider whose
  // stored key is in that mode (or "").
  let storedKeyNeedsVerification = "";
  let storedKeyVerifying = false;
  const S2_NEXT_LABEL = "继续：试翻一段";
  const S2_NEXT_VERIFY_LABEL = "验证并继续";
  // Codex PR #19 P2 (stale verification): the verification that currently owns
  // step 2's UI, as {token, provider, key}. Every verification captures its
  // token; a verdict is applied ONLY when its token is still current, the
  // provider is still selected and the input still holds the exact key — a
  // late success for a value the user already replaced must never persist,
  // enable 继续 or mark verified. The same identity re-claiming (one paste
  // fires paste+input+change+blur) keeps its token, so the deduped burst still
  // renders its one verdict.
  const keyVerification = { token: 0, provider: "", key: "" };

  function claimKeyVerification(keyProvider, key) {
    if (keyVerification.provider !== keyProvider || keyVerification.key !== key) {
      keyVerification.token += 1;
      keyVerification.provider = keyProvider;
      keyVerification.key = key;
    }
    return keyVerification.token;
  }

  function invalidateKeyVerification() {
    keyVerification.token += 1;
    keyVerification.provider = "";
    keyVerification.key = "";
  }

  function isCurrentKeyVerification(token, keyProvider, key) {
    return (
      keyVerification.token === token &&
      keyVerification.provider === keyProvider &&
      keyVerification.key === key &&
      provider === keyProvider &&
      els.s2Key.value.trim() === key
    );
  }

  /* ---------- step tracker ---------- */
  function showStep(step) {
    els.views.forEach((view, index) => {
      view.hidden = index !== step - 1;
    });
    els.steps.forEach((item) => {
      const n = Number(item.dataset.step);
      item.classList.toggle("done", n < step);
      item.classList.toggle("on", n === step);
      item.querySelector(".n").textContent = n < step ? "✓" : String(n);
    });
    const heading = els.views[step - 1].querySelector("h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  /* ---------- shortcuts (runtime bindings, fallback Alt+A / Alt+T) ---------- */
  function shortcutLabel(shortcut) {
    return shortcut || "未设置";
  }

  async function loadShortcuts() {
    const labels = { "translate-page": "Alt+A", "translate-selection": "Alt+T" };
    try {
      if (hasChrome && chrome.commands && chrome.commands.getAll) {
        const commands = await chrome.commands.getAll();
        for (const command of commands) {
          if (command.name in labels) {
            labels[command.name] = shortcutLabel(command.shortcut);
          }
        }
      }
    } catch {
      // Keep fallbacks.
    }
    els.shortcutPage.textContent = labels["translate-page"];
    els.shortcutSelection.textContent = labels["translate-selection"];
    els.tipPageKey.textContent = labels["translate-page"];
    els.tipSelectionKey.textContent = labels["translate-selection"];
  }

  /* ---------- step 1: provider ---------- */
  function selectProvider(next) {
    if (provider !== next) {
      // Abandon the departed provider's verification state entirely: a
      // still-pending debounced run for its value must not fire (and bill a
      // stale TEST_CONNECTION) after the switch.
      keyVerifier.forget(provider);
      invalidateKeyVerification();
    }
    provider = next in PROVIDERS ? next : "deepseek";
    els.providerButtons.forEach((button) => {
      button.setAttribute("aria-checked", button.dataset.provider === provider ? "true" : "false");
    });
    const meta = PROVIDERS[provider];
    els.s2Title.textContent = `连接 ${meta.name}`;
    els.s2Console.textContent = `打开 ${meta.name} 控制台 ↗`;
    els.s2Console.href = meta.consoleUrl;
    if (els.s2Pricing) {
      els.s2Pricing.href = meta.pricingUrl;
    }
    els.s2Key.value = "";
    els.s2Field.classList.remove("err");
    setKeyMessage("", "");
    setVerified(false, null);
    storedKeyVerifying = false;
    checkExistingKey();
  }

  els.providerButtons.forEach((button) => {
    button.addEventListener("click", () => selectProvider(button.dataset.provider));
  });

  els.s1Next.addEventListener("click", () => showStep(2));
  els.s1Skip.addEventListener("click", () => showStep(2));
  els.s2Back.addEventListener("click", () => showStep(1));

  /* ---------- step 2: paste key, auto-save + verify ---------- */
  function setKeyMessage(text, tone) {
    els.s2Msg.textContent = text;
    els.s2Msg.className = tone ? `msg ${tone}` : "msg";
  }

  function setVerified(ok, key) {
    verified = ok;
    verifiedKey = ok ? key : null;
    // Any verdict (or reset) leaves the stored-key "verify first" mode; only
    // checkExistingKey re-enters it via setStoredKeyNeedsVerification.
    storedKeyNeedsVerification = "";
    els.s2Next.textContent = S2_NEXT_LABEL;
    els.s2Next.disabled = !ok;
  }

  // Invariant (AGENTS.md, PR #19 P1-C): blur / input / change handlers never
  // synchronously disable 继续 — the blur may be the first half of a click on
  // it, and a button disabled between mousedown and click swallows the click.
  // Those handlers only update the verification STATE (verified = false); the
  // 继续 click handler waits for any in-flight check of the value in the box
  // and decides there. Only a paste (never a click precursor) may disable the
  // button right away (PR #19 P2: 继续 is disabled while a pasted replacement
  // key is verified).
  function resetVerifiedState(trigger) {
    if (trigger === "paste") {
      setVerified(false, null);
      return;
    }
    verified = false;
    verifiedKey = null;
    storedKeyNeedsVerification = "";
    els.s2Next.textContent = S2_NEXT_LABEL;
  }

  // The stored key exists but is not proven (P1-A): 继续 stays clickable as
  // 验证并继续, which verifies the stored key for real before step 3.
  // verified stays false, so nothing on this path can persist "verified".
  function setStoredKeyNeedsVerification(keyProvider) {
    verified = false;
    verifiedKey = null;
    storedKeyNeedsVerification = keyProvider;
    els.s2Next.textContent = S2_NEXT_VERIFY_LABEL;
    els.s2Next.disabled = false;
  }

  function validateKeyFormat(key) {
    if (!key.startsWith("sk-")) {
      return "Key 应以 sk- 开头";
    }
    if (/\s/.test(key)) {
      return "Key 不能包含空格或换行，请重新复制";
    }
    if (key.length < 20) {
      return "Key 长度不对，请确认完整复制";
    }
    return null;
  }

  async function readTargetLanguage() {
    if (!canStore) {
      return "zh-CN";
    }
    try {
      const stored = await chrome.storage.local.get("targetLanguage");
      return stored && stored.targetLanguage ? stored.targetLanguage : "zh-CN";
    } catch {
      return "zh-CN";
    }
  }

  async function readStoredKey(keyProvider) {
    if (!canStore) {
      return "";
    }
    const meta = PROVIDERS[keyProvider];
    try {
      const stored = await chrome.storage.local.get(meta.keyField);
      const value = stored && stored[meta.keyField];
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
  }

  /* P2-1: ONE function persists a verified provider choice in ONE
   * chrome.storage.local.set — provider, that provider's default model, the
   * key (+ legacy apiKey mirror) when it was newly pasted, a verified flag,
   * and the per-provider verification status + fingerprint (P2: the popup
   * reads the status, the keyVerified flag stays for compatibility).
   * Atomically, so background loadSettings (the sample translation) and the
   * popup both see the chosen provider with a matching model + key. */
  async function persistVerifiedProvider(chosenProvider, newlyPastedKey = null) {
    if (!canStore) {
      return;
    }
    const meta = PROVIDERS[chosenProvider];
    const storedKey = newlyPastedKey || (await readStoredKey(chosenProvider));
    const patch = {
      provider: chosenProvider,
      model: meta.model,
      keyVerified: true,
      apiKey: storedKey,
      ...Utils.keyStatusPatch(chosenProvider, "verified", storedKey)
    };
    if (newlyPastedKey) {
      patch[meta.keyField] = newlyPastedKey;
    }
    await chrome.storage.local.set(patch);
  }

  /* The shared verifier's run(): save the key first (TEST_CONNECTION bills
   * the key from storage — with its status reset to "unverified" in the SAME
   * set, so a verdict can never attach to a newer key), then ask the
   * background to verify it. Returns the verdict object; never throws. */
  async function runKeyVerification(keyProvider, key) {
    const meta = PROVIDERS[keyProvider];
    if (canStore) {
      try {
        await chrome.storage.local.set({
          provider: keyProvider,
          model: meta.model,
          [meta.keyField]: key,
          apiKey: key,
          ...Utils.keyStatusPatch(keyProvider, "unverified", key)
        });
      } catch {
        return { ok: false, code: "WELCOME_SAVE_FAILED", error: "保存失败，请重试", transient: true };
      }
    }
    if (!canMessage) {
      return { ok: true, environmentSkipped: true };
    }
    try {
      const targetLanguage = await readTargetLanguage();
      const response = await chrome.runtime.sendMessage({
        type: "TEST_CONNECTION",
        provider: keyProvider,
        model: meta.model,
        targetLanguage
      });
      if (response && response.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        code: String((response && response.code) || ""),
        error: String((response && response.error) || "连接失败，请稍后重试")
      };
    } catch (error) {
      return {
        ok: false,
        code: "NETWORK_ERROR",
        error: (error && error.message) || "网络错误，请稍后重试",
        transient: true
      };
    }
  }

  // Codex PR #19 P1: every key check goes through the shared verifier, so the
  // paste+input+change+blur burst one paste produces bills exactly ONE
  // TEST_CONNECTION, and rapid typing collapses into one debounced run.
  const keyVerifier = Utils.createKeyVerifier({
    run: runKeyVerification,
    debounceMs: 600
  });

  function setKeyMessageFromResult(result, key) {
    if (result && result.ok) {
      if (result.environmentSkipped) {
        setKeyMessage("已保存（当前环境无法验证，请在扩展弹窗里测试连接）", "");
      } else {
        setKeyMessage(`✓ 已连接 · 尾号 ${key.slice(-4)} · 已保存`, "ok");
      }
      setVerified(true, key);
    } else {
      const reason = (result && result.error) || "连接失败，请稍后重试";
      setKeyMessage(`✕ ${reason}`, "er");
      setVerified(false, null);
    }
  }

  async function handleKeyInput(trigger) {
    const keyProvider = provider;
    const key = els.s2Key.value.trim();
    // PR #19 P1-C (专业测试): an event on an UNCHANGED value — above all the
    // blur that clicking 继续 itself triggers, or a late change/input of the
    // same paste — must never reset the verified state. Resetting it here (even
    // just until the cached verdict re-applies) disabled 继续 mid-click and the
    // first click was lost. Same provider + the exact key already verified in
    // this step → nothing to do.
    if (verified && verifiedKey !== null && key && key === verifiedKey && keyProvider === provider &&
        keyVerification.provider === keyProvider && keyVerification.key === key) {
      return;
    }
    if (!key) {
      invalidateKeyVerification();
      els.s2Field.classList.remove("err");
      setKeyMessage("粘贴后立即自动保存并验证", "");
      resetVerifiedState(trigger);
      return;
    }
    const formatError = validateKeyFormat(key);
    if (formatError) {
      // Format errors stay local: no storage write, no network request — and
      // they retire any verification still in flight for the old value.
      invalidateKeyVerification();
      els.s2Field.classList.add("err");
      setKeyMessage(`✕ ${formatError}`, "er");
      resetVerifiedState(trigger);
      return;
    }
    els.s2Field.classList.remove("err");
    els.s2Msg.className = "msg";
    els.s2Msg.innerHTML = '<span class="spin" aria-hidden="true"></span> 正在保存并验证…';
    // PR #19 P2 (welcome.js:374, upgraded with P1-A): while a replacement key
    // is being verified, 继续 must not accept the previously verified/stored
    // key — disable it until this key's own verdict lands.
    storedKeyVerifying = false;
    resetVerifiedState(trigger);
    const token = claimKeyVerification(keyProvider, key);
    const result = await keyVerifier.request(keyProvider, key, { trigger });
    if (result && result.superseded) {
      return;
    }
    // Codex PR #19 P2 (stale verification): apply the verdict only when its
    // verification is still the current one — the provider was not switched
    // and the input still holds this exact key. A success for a value the
    // user already replaced must not persist, enable 继续 or mark verified.
    if (!isCurrentKeyVerification(token, keyProvider, key)) {
      return;
    }
    if (result && result.ok && !result.environmentSkipped) {
      // Verified: persist the chosen provider atomically (P2-1) before the
      // confirmation message lands.
      await persistVerifiedProvider(keyProvider, key);
      if (!isCurrentKeyVerification(token, keyProvider, key)) {
        // The user moved on to another value while the persist was in flight.
        return;
      }
    } else if (result && !result.ok && !Utils.isTransientKeyVerdict(result)) {
      // A definitive failure describes this key: persist "failed" so the
      // popup reopens on its setup card instead of trusting the key (P2).
      // Transient failures (network/timeout/429/5xx) say nothing about the
      // key and leave the "unverified" the key save wrote.
      try {
        await chrome.storage.local.set(Utils.keyStatusPatch(keyProvider, "failed", key));
      } catch {
        // The verdict message below still tells the user it failed.
      }
    }
    setKeyMessageFromResult(result, key);
  }

  // The newest key-input handling run, so the 继续 click can wait for the
  // check of the exact value in the box (typically started by the blur of
  // that very click) instead of the blur disabling the button under it.
  let keyInputRun = null;

  function runKeyInput(trigger) {
    const run = { provider, key: els.s2Key.value.trim(), promise: null };
    keyInputRun = run;
    run.promise = handleKeyInput(trigger).finally(() => {
      if (keyInputRun === run) {
        keyInputRun = null;
      }
    });
    return run.promise;
  }

  els.s2Key.addEventListener("paste", () => setTimeout(() => runKeyInput("paste"), 0));
  els.s2Key.addEventListener("input", () => runKeyInput("input"));
  els.s2Key.addEventListener("change", () => runKeyInput("change"));
  els.s2Key.addEventListener("blur", () => {
    if (els.s2Key.value.trim()) {
      runKeyInput("blur");
    }
  });

  async function checkExistingKey() {
    if (!canStore) {
      return;
    }
    // Capture the provider this read is for: a slow chrome.storage.local.get
    // that returns AFTER the user switched providers must not enable 继续
    // with the previous provider's key (Codex PR #19 P2).
    const chosenProvider = provider;
    const meta = PROVIDERS[chosenProvider];
    const statusField = `${chosenProvider}KeyStatus`;
    const statusForField = `${chosenProvider}KeyStatusFor`;
    try {
      const stored = await chrome.storage.local.get([
        meta.keyField,
        statusField,
        statusForField
      ]);
      if (provider !== chosenProvider) {
        return;
      }
      const existing = stored && stored[meta.keyField];
      // A value in the input means the user is already pasting/typing their
      // own key — never let a slow storage read overwrite their in-flight
      // verification with the stored-key shortcut.
      if (!existing || typeof existing !== "string" || existing.length < 4 || els.s2Key.value.trim()) {
        return;
      }
      const status = stored[statusField];
      const fingerprint = stored[statusForField];
      const matches = fingerprint === Utils.keyFingerprint(existing);
      // PR #19 P1-A: the shortcut accepts a stored key ONLY when its status is
      // "verified" for exactly this key's fingerprint.
      if (status === "verified" && matches) {
        setKeyMessage(`已配置 · 尾号 ${existing.slice(-4)}（可直接继续，或粘贴新 Key 替换）`, "ok");
        setVerified(true, null);
        return;
      }
      // A definitive failed verdict for THIS key: 继续 stays disabled until
      // the user pastes a key that verifies.
      if (status === "failed" && matches) {
        setKeyMessage(
          `上次验证失败 · 尾号 ${existing.slice(-4)} · 请重新粘贴或重新测试`,
          "er"
        );
        setVerified(false, null);
        return;
      }
      // Unverified, missing status, or a status computed on another key: the
      // key was never proven — require a real verification before 继续.
      setKeyMessage(
        `已保存 · 尾号 ${existing.slice(-4)} · 尚未验证（点「验证并继续」先验证，或粘贴新 Key 替换）`,
        ""
      );
      setStoredKeyNeedsVerification(chosenProvider);
    } catch {
      // Ignore — the user can still paste a key.
    }
  }

  // 验证并继续 (P1-A): run a REAL verification of the stored key; only its
  // success persists "verified" and opens step 3. Every await re-checks that
  // the user did not switch provider / start typing / re-enter this flow.
  async function verifyStoredKeyAndContinue() {
    const keyProvider = provider;
    const key = await readStoredKey(keyProvider);
    if (provider !== keyProvider || els.s2Key.value.trim() || storedKeyNeedsVerification !== keyProvider) {
      return;
    }
    if (!key || validateKeyFormat(key)) {
      setKeyMessage("✕ 已保存的 Key 无效，请重新粘贴", "er");
      setVerified(false, null);
      return;
    }
    storedKeyVerifying = true;
    els.s2Next.disabled = true;
    els.s2Msg.className = "msg";
    els.s2Msg.innerHTML = '<span class="spin" aria-hidden="true"></span> 正在验证已保存的 Key…';
    const token = claimKeyVerification(keyProvider, key);
    const result = await keyVerifier.request(keyProvider, key, { trigger: "click" });
    const stillCurrent = () =>
      storedKeyVerifying &&
      keyVerification.token === token &&
      provider === keyProvider &&
      !els.s2Key.value.trim();
    if ((result && result.superseded) || !stillCurrent()) {
      return;
    }
    storedKeyVerifying = false;
    if (result && result.ok && !result.environmentSkipped) {
      try {
        await persistVerifiedProvider(keyProvider, key);
      } catch {
        setKeyMessage("保存失败，请重试", "er");
        setStoredKeyNeedsVerification(keyProvider);
        return;
      }
      if (provider !== keyProvider || els.s2Key.value.trim()) {
        return;
      }
      setKeyMessage(`✓ 已连接 · 尾号 ${key.slice(-4)} · 已保存`, "ok");
      setVerified(true, key);
      showStep(3);
      return;
    }
    if (result && result.ok && result.environmentSkipped) {
      // No real verification happened: never mark verified.
      setKeyMessage("当前环境无法验证，请在扩展弹窗里测试连接", "er");
      setVerified(false, null);
      return;
    }
    if (result && !Utils.isTransientKeyVerdict(result)) {
      try {
        await chrome.storage.local.set(Utils.keyStatusPatch(keyProvider, "failed", key));
      } catch {
        // The verdict message below still tells the user it failed.
      }
      setKeyMessage(`✕ ${(result && result.error) || "连接失败"}（请重新粘贴 Key）`, "er");
      setVerified(false, null);
      return;
    }
    // Transient (network/timeout/429/5xx): nothing learned about the key —
    // keep 验证并继续 available for a retry.
    setKeyMessage(`✕ ${(result && result.error) || "连接失败，请稍后重试"}（可再次点「验证并继续」）`, "er");
    setStoredKeyNeedsVerification(keyProvider);
  }

  els.s2Next.addEventListener("click", async () => {
    if (storedKeyVerifying) {
      return;
    }
    // A check of the value in the box is still running (e.g. this click's own
    // blur started it): decide only after its verdict — never on the previous
    // key's state, and never by letting the blur disable the button.
    const pending = keyInputRun;
    if (pending && pending.provider === provider && pending.key && pending.key === els.s2Key.value.trim()) {
      await pending.promise;
      if (provider !== pending.provider || els.s2Key.value.trim() !== pending.key) {
        return;
      }
    }
    if (!verified) {
      if (storedKeyNeedsVerification && storedKeyNeedsVerification === provider) {
        await verifyStoredKeyAndContinue();
        return;
      }
      // Not verified (e.g. a typed key that failed or is malformed): the click
      // handler — not blur/input — is where 继续 gets disabled.
      els.s2Next.disabled = true;
      return;
    }
    // An already-stored key was accepted for the selected provider. Re-check
    // storage right before persisting: the shortcut is valid only while the
    // stored status is still "verified" for the stored key's fingerprint
    // (another surface may have replaced the key or recorded a failure).
    if (verifiedKey === null) {
      const chosenProvider = provider;
      const meta = PROVIDERS[chosenProvider];
      let stillVerified = false;
      if (canStore) {
        try {
          const stored = await chrome.storage.local.get([
            meta.keyField,
            `${chosenProvider}KeyStatus`,
            `${chosenProvider}KeyStatusFor`
          ]);
          const existing = String((stored && stored[meta.keyField]) || "").trim();
          stillVerified = Boolean(existing) &&
            stored[`${chosenProvider}KeyStatus`] === "verified" &&
            stored[`${chosenProvider}KeyStatusFor`] === Utils.keyFingerprint(existing);
        } catch {
          stillVerified = false;
        }
      }
      if (provider !== chosenProvider || verifiedKey !== null || !verified) {
        return;
      }
      if (!stillVerified) {
        setKeyMessage("已保存的 Key 状态已变化，需要重新验证", "");
        setStoredKeyNeedsVerification(chosenProvider);
        await verifyStoredKeyAndContinue();
        return;
      }
      try {
        await persistVerifiedProvider(chosenProvider, null);
      } catch {
        setKeyMessage("保存失败，请重试", "er");
        return;
      }
    }
    showStep(3);
  });
  els.s2Skip.addEventListener("click", () => showStep(3));

  /* ---------- step 3: sample translation ---------- */
  els.s3Try.addEventListener("click", async () => {
    els.s3Msg.className = "msg";
    els.s3Msg.innerHTML = '<span class="spin" aria-hidden="true"></span> 翻译中…';
    els.s3Try.disabled = true;
    els.sampleResult.hidden = true;

    if (!canMessage) {
      els.s3Msg.className = "msg er";
      els.s3Msg.textContent = "✕ 当前环境无法连接扩展后台，请在浏览器扩展里打开本页";
      els.s3Try.disabled = false;
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "WELCOME_SAMPLE_TRANSLATE",
        text: SAMPLE_TEXT
      });
      if (response && response.ok && response.translation) {
        els.sampleResult.textContent = response.translation;
        els.sampleResult.hidden = false;
        els.s3Msg.className = "msg ok";
        els.s3Msg.textContent = "✓ 翻译成功";
        els.s3Try.textContent = "再试一次";
      } else {
        const reason = (response && response.error) || "翻译失败";
        els.s3Msg.className = "msg er";
        els.s3Msg.textContent = `✕ ${reason}（可点「试翻这段」重试）`;
        els.s3Try.textContent = "重试";
      }
    } catch (error) {
      els.s3Msg.className = "msg er";
      els.s3Msg.textContent = `✕ ${error && error.message ? error.message : "网络错误"}（可点「试翻这段」重试）`;
      els.s3Try.textContent = "重试";
    } finally {
      els.s3Try.disabled = false;
    }
  });

  function finish() {
    window.close();
  }

  els.s3Done.addEventListener("click", finish);
  els.s3Skip.addEventListener("click", finish);

  /* ---------- init ---------- */
  selectProvider("deepseek");
  loadShortcuts();
  showStep(1);
})();
