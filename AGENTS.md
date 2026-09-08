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
- Fill the PR template; call out content-script / permission risk.
- Prefer **ready-for-review** (not forever-draft) when CI should auto-merge.

## Don't

- Commit API keys or expand host permissions without an explicit ask.
- Drive-by rewrite of content.js / background.js.
- Skip `node scripts/ci-check.mjs`.
- Urge merge on Build green alone.

## Merge policy (hard gates)

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **Build & Test check run** exists on the head SHA (fail closed if missing), **`copilot-pull-request-reviewer` and `Codex Review Gate` check runs exist and succeeded** (missing skips), the latest Copilot review for that SHA exists and is not `CHANGES_REQUESTED` (`APPROVED` or `COMMENTED` OK), and **all review threads are resolved** (#33: COMMENTED + open threads must not merge). Missing Copilot review does not auto-merge. Codex Gate dispatches Auto Merge on success and fails the check if dispatch fails. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. See `docs/MERGE_GATES.md`.

**Never merge on Build alone.** Hard gates: Build and Test + Codex Review Gate (summary covers head + 0 unresolved Codex threads) + conversation resolution. When Copilot quota is dead, Copilot may be waived for manual merge only; Codex + conversation resolution + Build remain mandatory. Auto-merge still requires Copilot by default.

## Cloud agent environment


Cloud setup: Node 20 only; prefer node scripts/ci-check.mjs.
