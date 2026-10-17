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
    els.s2Next.disabled = !ok;
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
    if (!key) {
      invalidateKeyVerification();
      els.s2Field.classList.remove("err");
      setKeyMessage("粘贴后立即自动保存并验证", "");
      setVerified(false, null);
      return;
    }
    const formatError = validateKeyFormat(key);
    if (formatError) {
      // Format errors stay local: no storage write, no network request — and
      // they retire any verification still in flight for the old value.
      invalidateKeyVerification();
      els.s2Field.classList.add("err");
      setKeyMessage(`✕ ${formatError}`, "er");
      setVerified(false, null);
      return;
    }
    els.s2Field.classList.remove("err");
    els.s2Msg.className = "msg";
    els.s2Msg.innerHTML = '<span class="spin" aria-hidden="true"></span> 正在保存并验证…';
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

  els.s2Key.addEventListener("paste", () => setTimeout(() => handleKeyInput("paste"), 0));
  els.s2Key.addEventListener("input", () => handleKeyInput("input"));
  els.s2Key.addEventListener("change", () => handleKeyInput("change"));
  els.s2Key.addEventListener("blur", () => {
    if (els.s2Key.value.trim()) {
      handleKeyInput("blur");
    }
  });

  async function checkExistingKey() {
    if (!canStore) {
      return;
    }
    const meta = PROVIDERS[provider];
    try {
      const stored = await chrome.storage.local.get(meta.keyField);
      const existing = stored && stored[meta.keyField];
      // A value in the input means the user is already pasting/typing their
      // own key — never let a slow storage read overwrite their in-flight
      // verification with the stored-key shortcut.
      if (existing && typeof existing === "string" && existing.length >= 4 && !els.s2Key.value.trim()) {
        setKeyMessage(`已配置 · 尾号 ${existing.slice(-4)}（可直接继续，或粘贴新 Key 替换）`, "ok");
        setVerified(true, null);
      }
    } catch {
      // Ignore — the user can still paste a key.
    }
  }

  els.s2Next.addEventListener("click", async () => {
    if (!verified) {
      return;
    }
    // An already-stored key was accepted for the selected provider: persist
    // the provider switch (provider + default model + mirror + verified flag)
    // in ONE write before step 3 samples it (a pasted key already persisted
    // at verification time — nothing to repeat).
    if (verifiedKey === null) {
      try {
        await persistVerifiedProvider(provider, null);
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
