# Kilocean Translate — Copilot repository instructions

## Product

Kilocean Translate is a Chrome/Edge MV3 extension: progressive page translation via user DeepSeek API key (BYOK), bilingual paragraph display, and selection overlay.

## Stack

- Plain JS (no bundler, no package.json): background.js, content.js, popup.js, shared.js
- UI: popup.html / popup.css
- CI: Node 20 + `node scripts/ci-check.mjs`
- AI: DeepSeek HTTPS only; key in chrome.storage — never commit secrets

## Architecture map

- manifest.json — MV3 permissions / host
- background.js — messaging, inject
- content.js — bilingual DOM, MutationObserver, selection overlay + race token
- popup.js — settings, displayMode, translate/clear
- shared.js — helpers
- scripts/ci-check.mjs — quality gate

## Coding standards

- Focused diffs; no drive-by refactors
- Do not expand permissions/hosts without explicit ask
- Never log or exfiltrate API keys
- Selection/async: honor race tokens; closed overlay ignores late responses
- displayMode must stay consistent with chrome.storage and popup radios

## Quality bar

```bash
node scripts/ci-check.mjs
```

Merge policy: docs/MERGE_GATES.md and AGENTS.md — Codex Review Gate + conversation resolution + Build; never Build-only. Copilot quota-dead → manual waive Copilot only.

## Agent behavior

- Scope to the issue. Prefer extending existing content/popup paths.
- Draft PR when uncertain; note what was verified.
- Human owns merge risk on content-script and permissions.

## Review severity tagging (P0 / P1 / P2)

When leaving review comments (Copilot or Codex), **tag each finding** with severity:

- **P0** — correctness bug, security issue, or data-loss risk → must fix in code before Resolve / merge
- **P1** — substantive defect or clear behavioral regression → must fix in code before Resolve / merge
- **P2** — nit, style, optional cleanup → author may Resolve without a code change after replying `P2: defer — <reason>` or `P2: won't fix — <reason>`

Unlabeled comments: treat correctness/security/data-loss as P0/P1; treat nit/style as P2.

The merge Gate still requires **all** review threads resolved; the short-term path for P2 is Resolve + rationale (no code change). See `docs/MERGE_GATES.md`.
