# Agent guide — Kilocean Translate

Short operational brief for Copilot cloud agent / IDE agents. Full product rules: `.github/copilot-instructions.md`.

## Quick start

```bash
node scripts/ci-check.mjs
```

No package.json. Load unpacked extension from repo root in chrome://extensions.

## Do

- Keep PRs small; one issue → one focused PR.
- Preserve permissions: activeTab, scripting, storage, contextMenus (1.5.0, no install warning); host only the translation APIs (https://api.deepseek.com/*, https://api.moonshot.cn/*). No content_scripts — inject on demand from user gestures (popup / commands / context menu).
- Watch selection race tokens and displayMode vs chrome.storage sync.
- Route every popup.js storage write through the serialized write queue (`enqueueSettingsWrite` / `saveSettings`) — CI enforces exactly one `chrome.storage.local.set` call site.
- Await the STABLE save (`await saveSettings()` resolves only after every follow-up write committed and no dirty edit remains; it rejects on write failure) in every popup action that needs persisted settings (translate, selection confirm, key test, import, export, display-mode send). CI statically rejects un-awaited, un-caught `saveSettings()`/`enqueueSettingsWrite()` calls — the only sanctioned fire-and-forget shape is `persistSettingsInBackground()` (`.catch`-handled: debounce ticks, change/blur persists, init's closing flush, the hide-time flush).
- Make every popup user action that reads or writes settings await the single init-ready promise via the `whenReady(...)` listener wrapper — acting before `initialize()` finishes uses the DEFAULT_SETTINGS snapshot (Codex P1: pre-init Export shipped defaults with no keys). Handlers that bank edits pre-init keep the bank synchronous and gate only their save. CI statically enforces wrapped listeners plus a documented allowlist.
- For any new gated popup action, add a held-initial-storage-read test: park the first `chrome.storage.local.get`, fire the action, assert nothing happened, release, assert it used the stored values (see `checkPopupActionInitGate` in scripts/ci-check.mjs).
- Add concurrency tests (controlled fake storage whose `set()` resolves manually) for any new popup.js write path.
- **Click-path invariant (PR #19 P1-C):** blur / input / change handlers must never synchronously disable (or hide) a button that may be about to be clicked — a click's mousedown blurs the focused input first, and a button disabled before the click lands swallows it. Those handlers update state only (e.g. `verified = false`, an in-flight run variable); decide "is the key verified?" inside the click/submit handler (await the in-flight check of the current value there). An event on an unchanged, already-verified value must be a no-op. Regression shape: real paste/typing, then ONE real `page.click` (natural focus/blur) must succeed.
- Fill the PR template; call out content-script / permission risk.
- Prefer **ready-for-review** (not forever-draft) when CI should auto-merge.

## Don't

- Commit API keys or expand host permissions without an explicit ask.
- Drive-by rewrite of content.js / background.js.
- Call `chrome.storage.local.set` (or `.remove`) directly in popup.js — bypassing the queue reintroduces the mid-write edit races.
- Register a popup settings/button handler that touches settings without `whenReady(...)` (and without a documented allowlist entry + reason in scripts/ci-check.mjs) — pre-init clicks act on defaults, and the static gate fails CI.
- Ship a new popup.js write path without a gated-storage concurrency test.
- Skip `node scripts/ci-check.mjs`.
- Urge merge on Build green alone.

## Merge policy (hard gates)

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **ci / Build & Test check run** exists on the head SHA (fail closed if missing), **`ci / Secret Scan` succeeded**, **`codex / Codex Review Gate` succeeded**, **`qa / QA Gate` succeeded** (label `qa-passed`), and Copilot is satisfied: Copilot has reviewed the PR **at least once, on any commit** (`copilot_scope: any`; Copilot is requested only on opened / ready_for_review and there is no per-push re-review), and the latest Copilot review is not `CHANGES_REQUESTED`. Head-SHA freshness comes from the Codex Gate, CI and QA. Repo variable `DISABLE_COPILOT_REVIEW=true` turns off both the request and this requirement. **Blocking threads:** unresolved non-Codex threads, plus unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**. A PR that Copilot never reviewed does not auto-merge. Codex Gate runs from trusted base-branch workflow code via `pull_request_target` (API-only github-script; read-only permissions; never checkout PR head). Success is the job conclusion only (no Checks API forge / no Auto Merge dispatch); Auto Merge listens via `workflow_run`. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. Label `skip-codex-gate` is a manual/admin escape hatch only: Gate **fails** (never success) and must not dispatch Auto Merge. See `docs/MERGE_GATES.md`.

**Never merge on Build alone.** Hard gates: ci / Build & Test + ci / Secret Scan + qa / QA Gate (`qa-passed`) + codex / Codex Review Gate (summary covers head + 0 unresolved Codex **P0/P1 or unlabeled** threads; pure P2 OK) + blocking conversation resolution (non-Codex all; Codex P0/P1/unlabeled). Auto-merge needs one Copilot review on any commit (no head-SHA Copilot check); still never Build-only.

- **评审严重度**：P0/P1 须改代码后再 Resolve；P2 可保持 open，或回复 `P2: defer — <reason>` / `P2: won't fix — <reason>` 后 Resolve（无需改代码）。Codex Gate / Auto Merge 仅阻断 Codex P0/P1（及未标注）。未标注时：正确性/安全/数据丢失→P0/P1，nit/style→P2。详见 `docs/MERGE_GATES.md`「评审严重度」。

## Cloud agent environment


Cloud setup: Node 20 only; prefer node scripts/ci-check.mjs.

## 交接规矩（2026-10-15 起）

把事情交给下一个 bot 时，必须单聊点名并叫醒对方，光在群里说「可以合了」不算交接。门禁转绿时，专业研发单聊通知产品 bot 和专业测试；专业测试打上 `qa-passed` 后，单聊通知产品 bot；产品 bot 合入或发布后，单聊通知专业研发。

## Coding 工具顺序（2026-10-20 起）

**适用范围（写死）**：下列 Codex / `coding` / `/home/box/.../codex-quota.sh` 顺序**仅**适用于已预装这些工具的**本机或 `/home/box` 工作站**。Copilot cloud、仅 Node·npm 的云端 agent、以及任何未预装 Codex/`coding` 的环境：**必须按该环境已有工具执行**；**严禁**把本机/box 工具序、`codex`/`coding` 或 `/home/box` 路径当作云端硬性要求。

1. **（本机/box）默认用 Codex CLI**（ChatGPT 账号登录），模型 `gpt-6.1-sol`（`~/.codex/config.toml`）。
2. **周额度用完后继续用 credits** 跑 Codex；**credits 也用完**再切：`coding glm`（一般代码）/ `coding kimi`（前端/交互/UI）。
3. 查额度（仅本机/box）：`/home/box/.coding-plans/codex-quota.sh`（退出码 0=继续 Codex，1=切 glm/kimi，2=未知；`--json`、`--probe`），或 Codex TUI 内 `/status`。云端无此脚本时跳过。
4. 凭证 `~/.codex/auth.json` 及任何 API key **绝不打印、外传或提交**；`.codex/`、`auth.json` 已在 `.gitignore`。

## 测试与门禁（禁止弱化凑绿）

- **禁止**为过 CI / Gate 而弱化、删改断言，或用 `skip` / `xit` / `.only`、改 fixture、放宽阈值等方式凑绿；也禁止让测试迁就错误实现。
- 红灯时优先修产品代码，或按真实意图**加强**测试；若断言本身写错，须在 PR 写明「原断言为何错、新断言覆盖什么」再改测试。
- AI 同时写代码与测试时，须用独立评审（Codex Gate / 人工）或既有回归交叉验证，勿代码与测试互相迁就。


## PR 证据与自动修上限（2026-10-20）

- **不要求人类 approve**；Gate 仍只挡 **P0/P1（及未标注）**（纯 P2 不挡）。
- **PR 必须贴证据**：正文写清「跑了什么测试 + 关键输出」（命令与摘要即可）；口头 done / 只勾 checkbox 不算。
- **同类 P1 自动修超 3 轮仍未清（写死）**：三轮上限**只**停止自动修循环（不得继续盲推）。**未 Resolve 的 P1 永远挡合入**——重试次数不改变严重度、不降级门禁。交给人/产品开跟进 issue/PR 继续修。**严禁**因重试次数把 P1 标成 observe、won't-fix、或 Resolve 后放行合入。
