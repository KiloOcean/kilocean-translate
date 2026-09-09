# 合并门槛 | Merge gates

本页是合并策略的 source of truth（ported from dota2.ai AI-native gates，适配本 Chrome 扩展仓库）。

This page is the source of truth for merge policy.

---

## 硬门槛 | Hard gates（不可省略）

自动合入或人工合入进 `main` 时，下列门槛**必须**满足。**禁止**仅凭 `Build & Test` 绿灯合入。

| 门槛 | 说明 |
|------|------|
| **Build & Test** | `scripts/ci-check.mjs`（manifest / 权限 / 语法 / 静态安全禁令） |
| **Codex Review Gate** | Summary 覆盖当前 head SHA，且 **0** 个未解决 Codex 行内线程 |
| **Conversation resolution** | 所有 review threads（Copilot / Codex / 人类）已 resolve |

### Copilot 配额耗尽时 | When Copilot quota is dead

- Copilot review **可以**临时豁免（人工合入）。
- **仍然禁止**只靠 Build 绿灯合入。
- **Codex Review Gate + conversation resolution** 仍是硬门槛。
- Auto-merge 工作流默认仍要求 `copilot-pull-request-reviewer`；配额死时请人工合入，不要放宽成 "Build only"。

---

## 先读：Ruleset vs 经典保护

若仓库是个人私有仓，GitHub Ruleset 可能显示 Active 但未真正 enforce。对 `main` 同时配置：

1. **经典 Branch protection**（今天真正挡合并）
2. **Ruleset**（升 Team / Organization 后 enforce）

---

## 人类必须打开的 `main` 保护

**Settings → Branches → Branch protection rule**（pattern: `main`）：

| 设置 | 为什么 |
|------|--------|
| **Require status checks to pass before merging** | 没有绿勾不能合 |
| Required check: **`Build & Test`** | CI job 名（`.github/workflows/ci.yml`） |
| Required check: **`copilot-pull-request-reviewer`** | Copilot 官方审查 check（配额耗尽时可临时人工豁免，见上） |
| Required check: **`Codex Review Gate`** | **job / check-run 名**（`.github/workflows/codex-gate.yml`），不是 workflow 展示名 |
| **Require conversation resolution before merging** | 未解决行内线程挡住 Merge |

**Copilot 的 required check 不覆盖 Codex。** Codex（`chatgpt-codex-connector[bot]`）从不注册 `copilot-pull-request-reviewer`。

不要把 **Custom LLM Review** 或 `ai-review.yml` 里的 **Copilot Review**（只负责 *request* 审查）设为必需。

---

## Codex Review Gate

Codex 只发 issue comment（`<!-- codex-pull-request-review-summary -->`）和行内 threads，**不是**原生 required check。`.github/workflows/codex-gate.yml` 的 **job 名必须是 `Codex Review Gate`**。

| 情况 | 结果 |
|------|------|
| Label `skip-codex-gate` | **失败**，不触发 Auto Merge（仅人工/admin 逃生舱文档；绝不能让 Gate 变 success） |
| Draft | 通过（ready 后重跑） |
| 尚无 Summary，head 未满约 20 分钟 | 失败（等待） |
| 20 分钟内从未发 Summary | 失败（`@codex review`；`skip-codex-gate` 会失败 Gate 并挡住自动合入） |
| Summary Running / Failed / 无 Completed 或 👍 | 失败 |
| Summary 已完成但未提及当前 head SHA | 失败（旧审查不算） |
| 仍有未解决 Codex 行内线程 | 失败 |
| 完成且 0 未解决 Codex 线程 | 通过 |

### 权限 / 安全 | Permissions / security

Gate **只申请 read**（`contents` / `pull-requests` / `issues`）。**没有** `checks: write` 或 `actions: write`。

- **不要**把 Gate 改成 `pull_request_target` 并 checkout PR 代码（经典 RCE）。
- 同仓分支上的 `pull_request` 仍会跑 PR 版 workflow YAML，但无写权限时无法伪造 Checks API 绿勾，也无法 `workflow_dispatch` Auto Merge。
- **`pull_request` 事件**：job conclusion 会把 check 名 `Codex Review Gate` 挂到 head SHA（branch protection / Auto Merge 认这个）。
- **`issue_comment` / `pull_request_review` / `pull_request_review_comment` / `workflow_dispatch`**：仍会跑评估并在 Actions UI 显示 run，但**不会**再往 head SHA 单独 `checks.create`。要刷新 required check：对上一次 **`pull_request` 来源**的 Gate job 点 **Re-run**（或再 push / synchronize）。
- Auto Merge 已监听 `workflow_run`（workflow 名 `Codex Review Gate`）；Gate **不必**自己 dispatch Auto Merge。

点 Resolve 不会自动重跑。清完线程后：Actions 里对 **pull_request 来源**的 `Codex Review Gate` 点 **Re-run**（重新挂 check 到 head SHA）。Gate 已绿时也可对 Auto Merge 做 `workflow_dispatch`。

**前置：** org/repo 需安装 ChatGPT Codex connector（或等价 Codex GitHub App）。

---

## Auto-merge 工作流 | What `auto-merge.yml` will squash

`.github/workflows/auto-merge.yml` 只在**同时**满足时 squash 进 `main`：

1. PR 打开、非 draft、base 为 `main`、无 `no-auto-merge` / `skip-codex-gate`
2. 没有 `no-auto-merge` label
3. head SHA 上有成功的 **`Build & Test` check run**（fail closed；不用 legacy combined status）
4. 相关 check 已完成且未失败（忽略 Custom LLM Review、Auto Merge 自己）。同名 check 只看最新 `created_at`
5. head 上 **`copilot-pull-request-reviewer`** `conclusion: success`（缺失 / skipped / neutral → 不合）
6. head 上 **`Codex Review Gate`** `conclusion: success`（缺失 / skipped / neutral → 不合）
7. 该 head SHA 上已有 Copilot review，且**不是** `CHANGES_REQUESTED`
   - **`APPROVED` 或 `COMMENTED` 均可。不要求原生 `APPROVED`。**
   - 没有 Copilot review → 不合
   - `COMMENTED` + 未解决行内线程 → 不合（靠第 8 条）
8. GraphQL `reviewThreads` 全部 `isResolved`（解析失败且仍有 review comments → fail-closed）

**永不**仅因 Build 绿灯自动合入。

`workflow_run` 只从 **default branch** 上的工作流定义运行。本文件合入 `main` 之后，后续 PR 才吃到新门槛。

线程 Resolve 后 GitHub **不会**再触发 auto-merge：先 **Re-run** 一次 `pull_request` 来源的 `Codex Review Gate`（刷新 head 上的 required check），或在 Gate 已绿时对 **Auto Merge** 跑 `workflow_dispatch`。

---

## `no-auto-merge`

打上 **`no-auto-merge`** 后 auto-merge 直接 skip。也可保持 draft，或把 base 改成非 `main`。

---

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/auto-merge.yml` | 自动 squash 判定 |
| `.github/workflows/ci.yml` | `Build & Test` → `node scripts/ci-check.mjs` |
| `.github/workflows/codex-gate.yml` | `Codex Review Gate` |
| `.github/workflows/ai-review.yml` | 请求 Copilot；Custom LLM 可选 |
| `docs/QUALITY.md` | 本地/CI 质量检查 |
| `docs/ai-native-quality-gate.md` | 自测清单 + 门禁摘要 |
| `AGENTS.md` | Agent 操作简报（含 merge policy） |
