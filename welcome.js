/* 千浩翻译 1.5.0 — welcome / onboarding page logic.
 * Talks to background only through chrome.runtime.sendMessage;
 * writes only the key-related storage fields (never logs keys). */
(function () {
  "use strict";

  const PROVIDERS = {
    deepseek: {
      name: "DeepSeek",
      consoleUrl: "https://platform.deepseek.com/api_keys",
      model: "deepseek-flash",
      keyField: "deepseekApiKey"
    },
    kimi: {
      name: "Kimi",
      consoleUrl: "https://platform.moonshot.cn/console/api-keys",
      model: "kimi-k2.6",
      keyField: "kimiApiKey"
    }
  };

  const SAMPLE_TEXT =
    "Every winter, the rocky shoreline turns into a laboratory of survival. " +
    "Small tide pools lose heat quickly, yet anemones and crabs remain active beneath thin ice. " +
    "A pool only thirty centimetres deeper can hold enough heat through the longest nights.";

  const $ = (selector) => document.querySelector(selector);

  const els = {
    steps: [...document.querySelectorAll("#steps li")],
    views: [$("#step-1"), $("#step-2"), $("#step-3")],
    providerButtons: [...document.querySelectorAll(".pv button")],
    s1Next: $("#s1-next"),
    s1Skip: $("#s1-skip"),
    s2Title: $("#s2-title"),
    s2Console: $("#s2-console"),
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
  let verifyToken = 0;

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
    provider = next in PROVIDERS ? next : "deepseek";
    els.providerButtons.forEach((button) => {
      button.setAttribute("aria-checked", button.dataset.provider === provider ? "true" : "false");
    });
    const meta = PROVIDERS[provider];
    els.s2Title.textContent = `连接 ${meta.name}`;
    els.s2Console.textContent = `打开 ${meta.name} 控制台 ↗`;
    els.s2Console.href = meta.consoleUrl;
    els.s2Key.value = "";
    els.s2Field.classList.remove("err");
    setKeyMessage("", "");
    setVerified(false);
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

  function setVerified(ok) {
    verified = ok;
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

  async function verifyKey(key) {
    const token = ++verifyToken;
    const meta = PROVIDERS[provider];

    els.s2Field.classList.remove("err");
    setKeyMessage("验证中…", "");
    els.s2Msg.innerHTML = '<span class="spin" aria-hidden="true"></span> 正在保存并验证…';

    if (canStore) {
      try {
        await chrome.storage.local.set({
          provider,
          model: meta.model,
          [meta.keyField]: key,
          apiKey: key
        });
      } catch {
        if (token !== verifyToken) return;
        setKeyMessage("保存失败，请重试", "er");
        return;
      }
    }

    if (!canMessage) {
      if (token !== verifyToken) return;
      setKeyMessage("已保存（当前环境无法验证，请在扩展弹窗里测试连接）", "");
      setVerified(true);
      return;
    }

    try {
      const targetLanguage = await readTargetLanguage();
      const response = await chrome.runtime.sendMessage({
        type: "TEST_CONNECTION",
        provider,
        model: meta.model,
        targetLanguage
      });
      if (token !== verifyToken) return;
      if (response && response.ok) {
        setKeyMessage(`✓ 已连接 · 尾号 ${key.slice(-4)} · 已保存`, "ok");
        setVerified(true);
      } else {
        const reason = (response && response.error) || "连接失败，请稍后重试";
        setKeyMessage(`✕ ${reason}`, "er");
        setVerified(false);
      }
    } catch (error) {
      if (token !== verifyToken) return;
      setKeyMessage(`✕ ${error && error.message ? error.message : "网络错误，请稍后重试"}`, "er");
      setVerified(false);
    }
  }

  function handleKeyInput() {
    const key = els.s2Key.value.trim();
    if (!key) {
      els.s2Field.classList.remove("err");
      setKeyMessage("粘贴后立即自动保存并验证", "");
      setVerified(false);
      return;
    }
    const formatError = validateKeyFormat(key);
    if (formatError) {
      verifyToken += 1;
      els.s2Field.classList.add("err");
      setKeyMessage(`✕ ${formatError}`, "er");
      setVerified(false);
      return;
    }
    verifyKey(key);
  }

  els.s2Key.addEventListener("paste", () => setTimeout(handleKeyInput, 0));
  els.s2Key.addEventListener("change", handleKeyInput);
  els.s2Key.addEventListener("blur", () => {
    if (els.s2Key.value.trim()) {
      handleKeyInput();
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
      if (existing && typeof existing === "string" && existing.length >= 4) {
        setKeyMessage(`已配置 · 尾号 ${existing.slice(-4)}（可直接继续，或粘贴新 Key 替换）`, "ok");
        setVerified(true);
      }
    } catch {
      // Ignore — the user can still paste a key.
    }
  }

  els.s2Next.addEventListener("click", () => {
    if (verified) {
      showStep(3);
    }
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
