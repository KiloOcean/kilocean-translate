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
