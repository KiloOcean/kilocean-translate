# Agent guide — Kilocean Translate

Short operational brief for Copilot cloud agent / IDE agents. Full product rules: `.github/copilot-instructions.md`.

## Quick start

```bash
node scripts/ci-check.mjs
```

No package.json. Load unpacked extension from repo root in chrome://extensions.

## Do

- Keep PRs small; one issue → one focused PR.
- Preserve permissions: activeTab, scripting, storage; host only https://api.deepseek.com/*.
- Watch selection race tokens and displayMode vs chrome.storage sync.
- Route every popup.js storage write through the serialized write queue (`enqueueSettingsWrite` / `saveSettings`) — CI enforces exactly one `chrome.storage.local.set` call site.
- Await the STABLE save (`await saveSettings()` resolves only after every follow-up write committed and no dirty edit remains; it rejects on write failure) in every popup action that needs persisted settings (translate, selection confirm, key test, import, export, display-mode send). CI statically rejects un-awaited, un-caught `saveSettings()`/`enqueueSettingsWrite()` calls — the only sanctioned fire-and-forget shape is `persistSettingsInBackground()` (`.catch`-handled: debounce ticks, change/blur persists, init's closing flush, the hide-time flush).
- Make every popup user action that reads or writes settings await the single init-ready promise via the `whenReady(...)` listener wrapper — acting before `initialize()` finishes uses the DEFAULT_SETTINGS snapshot (Codex P1: pre-init Export shipped defaults with no keys). Handlers that bank edits pre-init keep the bank synchronous and gate only their save. CI statically enforces wrapped listeners plus a documented allowlist.
- For any new gated popup action, add a held-initial-storage-read test: park the first `chrome.storage.local.get`, fire the action, assert nothing happened, release, assert it used the stored values (see `checkPopupActionInitGate` in scripts/ci-check.mjs).
- Add concurrency tests (controlled fake storage whose `set()` resolves manually) for any new popup.js write path.
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

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **ci / Build & Test check run** exists on the head SHA (fail closed if missing), **`ci / Secret Scan` succeeded**, **`codex / Codex Review Gate` succeeded**, **`qa / QA Gate` succeeded** (label `qa-passed`), and Copilot is satisfied: either official `copilot-pull-request-reviewer` check succeeded, **or** soft-path when that check is missing but head already has Copilot `APPROVED`/`COMMENTED` (quota death; still fail-closed with no head review). Latest Copilot review for that SHA must not be `CHANGES_REQUESTED`. **Blocking threads:** unresolved non-Codex threads, plus unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**. Missing Copilot review does not auto-merge. Codex Gate runs from trusted base-branch workflow code via `pull_request_target` (API-only github-script; read-only permissions; never checkout PR head). Success is the job conclusion only (no Checks API forge / no Auto Merge dispatch); Auto Merge listens via `workflow_run`. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. Label `skip-codex-gate` is a manual/admin escape hatch only: Gate **fails** (never success) and must not dispatch Auto Merge. See `docs/MERGE_GATES.md`.

**Never merge on Build alone.** Hard gates: ci / Build & Test + ci / Secret Scan + qa / QA Gate (`qa-passed`) + codex / Codex Review Gate (summary covers head + 0 unresolved Codex **P0/P1 or unlabeled** threads; pure P2 OK) + blocking conversation resolution (non-Codex all; Codex P0/P1/unlabeled). Copilot soft-path applies to auto-merge when the official check is missing but head has Copilot review; still never Build-only.

- **评审严重度**：P0/P1 须改代码后再 Resolve；P2 可保持 open，或回复 `P2: defer — <reason>` / `P2: won't fix — <reason>` 后 Resolve（无需改代码）。Codex Gate / Auto Merge 仅阻断 Codex P0/P1（及未标注）。未标注时：正确性/安全/数据丢失→P0/P1，nit/style→P2。详见 `docs/MERGE_GATES.md`「评审严重度」。

## Cloud agent environment


Cloud setup: Node 20 only; prefer node scripts/ci-check.mjs.

## 交接规矩（2026-10-15 起）

把事情交给下一个 bot 时，必须单聊点名并叫醒对方，光在群里说「可以合了」不算交接。门禁转绿时，专业研发单聊通知产品 bot 和专业测试；专业测试打上 `qa-passed` 后，单聊通知产品 bot；产品 bot 合入或发布后，单聊通知专业研发。
