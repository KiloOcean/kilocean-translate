# 质量门禁指南 | Quality Gates Guide

本文档说明本仓库（Kilocean Translate Chrome 扩展）的 CI 与 AI 审查。详见 MERGE_GATES.md。

---

## 📋 概览 | Overview

| 检查 | 类型 | 合并要求 | 说明 |
|------|------|---------|------|
| **ci / Build & Test** | CI | ✅ 必需 | `node scripts/ci-check.mjs` |
| **ci / Secret Scan** | CI | ✅ 硬门槛 | gitleaks 密钥扫描（`ci.yml` 调用 devflow-gates）；缺失或失败均阻断 |
| **copilot-pull-request-reviewer** | AI check | ❌ 非 required（Auto Merge 只要求任一提交上有过 Copilot review；禁止只靠 Build） | 只覆盖 Copilot，**不覆盖 Codex**。head 上的该 check 不参与合并判断（缺失、运行中、失败都不阻断）。Copilot **review** 可以是 `COMMENTED`，不要求 `APPROVED` |
| **codex / Codex Review Gate** | AI check | ✅ 硬门槛 | **job 名**必须是 `codex / Codex Review Gate`（不要只认 workflow 展示名） |
| **qa / QA Gate** | QA check | ✅ 硬门槛 | PR 须带 `qa-passed` label（见 `QA.md`；每次 push 自动撤销） |
| **会话已解决** | 讨论 | ✅ 硬门槛 | 未解决的 Copilot / Codex / 人类行内线程挡住合并 |
| **Custom LLM Review** | AI | ⏭️ 可选 | DeepSeek/OpenAI/xAI（需 API 密钥）；不阻塞合并 |

合并策略详见 [`docs/MERGE_GATES.md`](MERGE_GATES.md)。

---

## 🤖 AI 代码审查 | AI Code Review

### 主要方案：GitHub Copilot（推荐）

**无需 API 密钥** — 直接使用你的 GitHub Copilot 订阅。

#### 启用自动审查

1. 进入仓库 **Settings → Copilot → Code review**
2. 在 Branch rules 下，勾选 **Automatically request Copilot review**
3. 选择审查深度：
   - **Lite**: 标准审查
   - **Balanced**: 深度分析（复杂逻辑、安全敏感代码）

#### 工作流行为

- 每个 PR 自动请求 `copilot-pull-request-reviewer` 审查
- 若要禁用，设置变量 `DISABLE_COPILOT_REVIEW=true`

#### 相关文档

- [GitHub Copilot Code Review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [配置自动审查](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)

---

### 可选方案：自定义 LLM 审查

如果希望在 Copilot 之外增加额外的 LLM 审查，可配置 API 密钥。

**这是可选的，不影响合并。**

#### 支持的提供商

| 提供商 | Secret 名称 | 默认模型 |
|--------|-------------|----------|
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-chat |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| xAI (Grok) | `XAI_API_KEY` | grok-2-latest |

#### 配置步骤

1. **Settings → Secrets and variables → Actions → New repository secret**
2. 添加对应的 API 密钥
3. （可选）设置变量 `AI_REVIEW_PROVIDER` = `openai` | `deepseek` | `xai`
4. （可选）设置变量 `AI_REVIEW_MODEL` 自定义模型

#### 未配置时的行为

- 工作流正常完成（SUCCESS）
- Job Summary 显示跳过说明
- 不发布审查评论
- **不阻塞 CI 或合并**

---

## 🔒 必需检查：Build & Test

CI 作业名是 **ci / Build & Test**。个人私有仓库请用**经典 branch protection**（Ruleset 可能显示 Active 但不 enforce），并要求 `ci / Build & Test` + `ci / Secret Scan` + `codex / Codex Review Gate` + `qa / QA Gate` + 会话已解决（**不要**要求 `copilot-pull-request-reviewer`：后续 push 不会重审，Copilot 由 Auto Merge 内部判断）。见 [`MERGE_GATES.md`](MERGE_GATES.md)。

| 步骤 | 命令 | 说明 |
|------|------|------|
| Extension CI | `node scripts/ci-check.mjs` | manifest, permissions, syntax, static bans |

---

## 🛡️ 推荐分支保护配置

### 基础配置（推荐）

**Settings → Branches → Add rule**

```
Branch name pattern: main

✅ Require a pull request before merging
✅ Require status checks to pass before merging
   ✅ Require branches to be up to date
   Required checks:
     - ci / Build & Test
     - ci / Secret Scan
     - codex / Codex Review Gate
     - qa / QA Gate
✅ Require conversation resolution before merging
```

个人私有仓库：**Ruleset 不 enforce**，用上面的经典 Branch protection。同一组 check 也写进 Ruleset，升 Team / Organization 后才会真正生效。完整清单见 [`MERGE_GATES.md`](MERGE_GATES.md)。

### 说明

- `ci / Build & Test`、`ci / Secret Scan`、`codex / Codex Review Gate`、`qa / QA Gate` 都应设为必需 check（`copilot-pull-request-reviewer` **不**设为必需）
- Copilot check **不覆盖** Codex；Codex 靠 `codex-gate.yml` + conversation resolution
- Custom LLM Review 与 `ai-review.yml` 的 “Copilot Review”（只负责请求审查）不要设为必需
- auto-merge：**不要求** Copilot 原生 `APPROVED`。PR 上（任一提交）必须有过 Copilot review 且最新一条不是 `CHANGES_REQUESTED`（`APPROVED`/`COMMENTED` 均可），线程必须全部 resolve，且必须有成功的 **ci / Build & Test**、**ci / Secret Scan**、**codex / Codex Review Gate**、**qa / QA Gate** check run（缺失即不合）。

---

## 🚀 本地开发检查

提交 PR 前建议运行：

```bash
node scripts/ci-check.mjs
```

---

## 🔧 故障排查

### Copilot 审查不工作

1. 确认已启用 Copilot 订阅（Pro/Pro+/Business/Enterprise）
2. 进入 **Settings → Copilot → Code review** 检查配置
3. 确认 `copilot-pull-request-reviewer` 已启用为协作者

### Custom LLM 审查不工作

1. 检查 Secret 是否正确配置
2. 验证 API 密钥是否有效
3. 查看 Job Summary 中的错误信息

### CI 失败

1. 查看 Actions 页面的具体错误
2. 本地复现：运行上述检查命令
3. 常见问题：manifest / permissions / syntax / static bans

---

## 📚 相关链接

- [GitHub Actions](https://docs.github.com/en/actions)
- [GitHub Copilot Code Review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)


### Copilot quota dead

Manual merge still requires all hard gates: `ci / Build & Test`, `ci / Secret Scan`, `codex / Codex Review Gate`, `qa / QA Gate` (`qa-passed`) green + blocking conversation resolution. Only the Copilot review may be waived. Never merge on Build alone.
