# 合并门槛 | Merge gates

本页是合并策略的 source of truth（ported from dota2.ai AI-native gates，适配本 Chrome 扩展仓库）。

This page is the source of truth for merge policy.

---


## Check names after devflow-gates migration

本仓库的 CI / Codex / QA / Auto Merge 改为调用 `qianhaoq/devflow-gates` 的 reusable workflow（固定到 commit `fe7cf65`，即 fe7cf651ef515f165041738dc285b03ce3817bb9）。Check 名变为 `<caller job> / <called job>`，branch protection 与 `auto-merge.yml` 的 `required_checks` 必须使用以下名字：

- `ci / Build & Test`
- `ci / Secret Scan`
- `codex / Codex Review Gate`
- `qa / QA Gate`（label `qa-passed`，见 `QA.md`）

旧的裸名 `Build & Test` / `Codex Review Gate` 在合入后不再产生，若仍为 required 会让所有 PR 永久挂起。

Codex 线程分级（共享实现）：显式 P0/P1 阻断；未标注线程一律阻断（`block_unlabeled: true`，默认，fail-closed）；显式 P2（Codex、Copilot 或人工）不阻断；P2 可回复 `P2: defer — <理由>` 后 Resolve。线程 Resolve 不会触发 Actions（已取消每 15 分钟的定时 Refresh 以节省分钟）：Resolve 最后一个阻断线程后，在 PR 评论 `/recheck` 触发 Gate Refresh 重跑，或 `workflow_dispatch`（在 PR 分支上）填 PR 号；新 push / Codex 新评论也会自动重评。

## 硬门槛 | Hard gates（不可省略）

自动合入或人工合入进 `main` 时，下列门槛**必须**满足。**禁止**仅凭 `ci / Build & Test` 绿灯合入。

| 门槛 | 说明 |
|------|------|
| **ci / Build & Test** | `scripts/ci-check.mjs`（manifest / 权限 / 语法 / 静态安全禁令） |
| **ci / Secret Scan** | 密钥扫描必须成功（缺失或失败均阻断） |
| **codex / Codex Review Gate** | Summary 覆盖当前 head SHA，且 **0** 个未解决 Codex **P0/P1（或未标注）** 行内线程（纯 P2 不挡） |
| **qa / QA Gate** | PR 带 `qa-passed` label（见 `QA.md`；每次 push 自动撤销，需重新签核） |
| **Conversation resolution** | 非 Codex 线程须 resolve；Codex 仅 P0/P1（或未标注）须 resolve（纯 P2 可 open） |

### Copilot 配额耗尽时 | When Copilot quota is dead

- Copilot review **可以**临时豁免（人工合入）。
- **仍然禁止**只靠 Build 绿灯合入。
- **ci / Secret Scan + codex / Codex Review Gate + qa / QA Gate + conversation resolution** 仍是硬门槛。
- Auto-merge：`copilot_scope: any` — PR 上任一提交有过 Copilot `APPROVED`/`COMMENTED` review 即满足（head 上的 `copilot-pull-request-reviewer` check 不参与判断）；从未审过 → fail-closed。不要放宽成 "Build only"。

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
| Required check: **`ci / Build & Test`** | CI job 名（`.github/workflows/ci.yml`） |
| ~~Required check: `copilot-pull-request-reviewer`~~ | **不设为 required**：它只出现在 Copilot 审过的那个 head 上，后续 push 不会重审，设为 required 会挡住所有 push 后的合并。Copilot 由 Auto Merge 内部判断（任一提交有过 Copilot review） |
| Required check: **`codex / Codex Review Gate`** | **job / check-run 名**（`.github/workflows/codex-gate.yml`），不是 workflow 展示名 |
| Required check: **`ci / Secret Scan`** | gitleaks（`ci.yml` 调用 devflow-gates） |
| Required check: **`qa / QA Gate`** | QA label `qa-passed`（`qa-gate.yml`，见 `QA.md`） |
| **Require conversation resolution before merging** | 未解决行内线程挡住 Merge（无严重度例外；见下方「原生保护」） |

**Copilot 的 required check 不覆盖 Codex。** Codex（`chatgpt-codex-connector[bot]`）从不注册 `copilot-pull-request-reviewer`。

不要把 **Custom LLM Review** 或 `ai-review.yml` 里的 **Copilot Review**（只负责 *request* 审查）设为必需。

---

## Codex Review Gate

Codex 只发 issue comment（`<!-- codex-pull-request-review-summary -->`）和行内 threads，**不是**原生 required check。`.github/workflows/codex-gate.yml` 的 **job 名必须是 `codex / Codex Review Gate`**。

| 情况 | 结果 |
|------|------|
| Label `skip-codex-gate` | **失败**，不触发 Auto Merge（仅人工/admin 逃生舱文档；绝不能让 Gate 变 success） |
| Draft | 通过（ready 后重跑） |
| 尚无 Summary，head 未满约 20 分钟 | 失败（等待） |
| 20 分钟内从未发 Summary | 失败（`@codex review`；`skip-codex-gate` 会失败 Gate 并挡住自动合入） |
| Summary Running / Failed / 无 Completed 或 👍 | 失败 |
| Summary 已完成但未提及当前 head SHA | 失败（旧审查不算） |
| 仍有未解决 Codex **P0/P1（或未标注）** 行内线程 | 失败 |
| 完成且 0 未解决阻塞级 Codex 线程（纯 P2 可保持 open） | 通过 |

### 权限 / 安全 | Permissions / security

Gate **只申请 read**（`contents` / `pull-requests` / `issues`）。**没有** `checks: write` 或 `actions: write`。

- Gate 使用 **`pull_request_target`**（外加 comment / review / dispatch），因此 **workflow YAML 始终来自 base/default 分支**，不受 PR head 篡改。
- Job **只**跑 `actions/github-script` + GitHub API：**禁止** `actions/checkout` PR head、**禁止**执行任何 PR 控制的 shell/代码。这是安全的：评估输入只有 API 读到的 PR/评论/线程状态，没有密钥、没有 PR 树执行面。
- **不要**在 Gate 里 checkout PR 代码（那才是经典 RCE）；仅改 trigger 为 `pull_request_target` 且 API-only 是刻意的信任边界。
- **`pull_request_target` 事件**：job conclusion 把 check 名 `codex / Codex Review Gate` 挂到 PR（branch protection / Auto Merge 认这个）。
- **`issue_comment` / `pull_request_review` / `pull_request_review_comment` / `workflow_dispatch`**：仍会跑评估并在 Actions UI 显示 run，但**不会**再往 head SHA 单独 `checks.create`。要刷新 required check：对上一次 **`pull_request_target` 来源**的 Gate job 点 **Re-run**（或再 push / synchronize）。
- Auto Merge 已监听 `workflow_run`（workflow 名 `Codex Review Gate`；`codex / Codex Review Gate` 只是 check 名）；Gate **不必**自己 dispatch Auto Merge。
- **`ai-review.yml`**：`pull_request` 上只请求 Copilot；**不**把 provider API secrets 注入 PR 控制的 job。

点 Resolve 不会自动重跑。清完线程后：Actions 里对 **pull_request_target 来源**的 `codex / Codex Review Gate` 点 **Re-run**（重新挂 check）。Gate 已绿时也可对 Auto Merge 做 `workflow_dispatch`。

**前置：** org/repo 需安装 ChatGPT Codex connector（或等价 Codex GitHub App）。

---

## Auto-merge 工作流 | What `auto-merge.yml` will squash

`.github/workflows/auto-merge.yml` 只在**同时**满足时 squash 进 `main`：

1. PR 打开、非 draft、base 为 `main`、无 `no-auto-merge` / `skip-codex-gate`
2. 没有 `no-auto-merge` label
3. head SHA 上有成功的 **`ci / Build & Test`**、**`ci / Secret Scan`**、**`qa / QA Gate`** check run（`required_checks`；fail closed；不用 legacy combined status）
4. 相关 check 已完成且未失败（忽略 Custom LLM Review、Auto Merge 自己）。同名 check 只看最新 `created_at`
5. （已取消）head 上的 `copilot-pull-request-reviewer` check 不再参与判断（`copilot_scope: any`：缺失、运行中、失败都不阻断）。Copilot 只在 opened / ready_for_review 请求一次，没有按 push 的重审
6. head 上 **`codex / Codex Review Gate`** `conclusion: success`（缺失 / skipped / neutral → 不合）
7. 该 PR 上（**任一提交**）已有 Copilot review，且最新一条**不是** `CHANGES_REQUESTED`；head 新鲜度由 Codex Gate / CI / QA 保证（仓库变量 `DISABLE_COPILOT_REVIEW=true` 同时关闭请求与该要求）
   - **`APPROVED` 或 `COMMENTED` 均可。不要求原生 `APPROVED`。**
   - 没有 Copilot review → 不合
   - `COMMENTED` + 未解决行内线程 → 不合（靠第 8 条）
8. GraphQL `reviewThreads`：**非 Codex** 未解决一律阻断；**Codex** 仅阻断未解决 **P0/P1（或未标注）**（纯 P2 可保持 open）。解析失败且仍有 review comments → fail-closed

**永不**仅因 Build 绿灯自动合入。

`workflow_run` 只从 **default branch** 上的工作流定义运行。本文件合入 `main` 之后，后续 PR 才吃到新门槛。

线程 Resolve 后 GitHub **不会**再触发 auto-merge：先 **Re-run** 一次 `pull_request` 来源的 `codex / Codex Review Gate`（刷新 head 上的 required check），或在 Gate 已绿时对 **Auto Merge** 跑 `workflow_dispatch`。

---

## `no-auto-merge`

打上 **`no-auto-merge`** 后 auto-merge 直接 skip。也可保持 draft，或把 base 改成非 `main`。

---


### GitHub 原生保护 vs 工作流软门槛 | Native protection vs workflow soft gates

GitHub branch protection **没有**严重度 / soft-path 过滤器：

| 原生设置 | 与本仓工作流的关系 |
|----------|-------------------|
| Required check `copilot-pull-request-reviewer` | Auto Merge 的 Copilot 判断（`copilot_scope: any`：任一提交有过 Copilot review 即可，不看 head 上的 check）只影响工作流自身判断。若该 check 仍是 required status check，`pulls.merge` / UI 仍会因缺失 check 被拒，除非临时去掉 required、或给合并 actor（含 `github-actions`）开 bypass。配额耗尽时的人工合入仍须 Codex Gate + Build，禁止 Build-only。 |
| Require conversation resolution | 无作者/严重度例外。若开启，**未 Resolve 的纯 P2 也会挡住** merge。建议：Codex Gate 可对纯 P2 先行绿灯；合入前仍用 `P2: defer — …` Resolve（或关原生 conversation resolution，改信 Auto Merge 的 GraphQL 严重度门槛；若要「P2 真·保持 open 也能 API 合入」，给 `github-actions` bypass）。 |

## 评审严重度 | Review severity (P0 / P1 / P2)

合入前 review 意见按严重度分级。**codex / Codex Review Gate 只阻断未解决的 P0/P1（以及未标注严重度的线程；未标注默认按高优先级 fail-closed）**。P2 可保持 open，或回复 rationale 后 Resolve（无需改代码）；P0/P1 必须先改代码再 Resolve。

| 级别 | 含义 | 合入前要求 |
|------|------|------------|
| **P0** | 阻断：正确性错误、安全漏洞、数据丢失风险 | **必须改代码**，修复后再 Resolve |
| **P1** | 高优先级：实质性缺陷或明显行为回归 | **必须改代码**，修复后再 Resolve |
| **P2** | 可选：风格、命名、小优化、非阻塞建议 | **可不改代码**；可保持 open，或回复后 Resolve |

### P2 无代码改动时的 Resolve 话术

在 thread 中回复其一，再点 Resolve（也可不 Resolve，Gate 不因纯 P2 失败）：

- `P2: defer — <reason>`（本次不做，后续再跟）
- `P2: won't fix — <reason>`（明确不做）

### 未标注严重度时

- Gate / 正确性风险默认按 **P0/P1** 处理（须改代码；未标注会挡住 Codex Gate）
- 纯 nit / style → 显式标 **P2**（可保持 open 或 Resolve + rationale）

### 对 Copilot / Codex

审查评论应显式标注 **P0 / P1 / P2**，便于作者与 Gate 操作对齐。

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/auto-merge.yml` | 自动 squash 判定 |
| `.github/workflows/ci.yml` | `ci / Build & Test` → `node scripts/ci-check.mjs`；`ci / Secret Scan` → gitleaks |
| `.github/workflows/codex-gate.yml` | `codex / Codex Review Gate` |
| `.github/workflows/qa-gate.yml` | `qa / QA Gate`（label `qa-passed`，见 `QA.md`） |
| `.github/workflows/ai-review.yml` | 请求 Copilot；Custom LLM 可选 |
| `docs/QUALITY.md` | 本地/CI 质量检查 |
| `docs/ai-native-quality-gate.md` | 自测清单 + 门禁摘要 |
| `AGENTS.md` | Agent 操作简报（含 merge policy） |

<!-- gate e2e 2026-09-09 -->

## 自动修上限（2026-10-20）

- Gate 仍只挡 **P0/P1（及未标注）**；**不要求人类 approve**。
- **同类 P1** 自动修复超过 **3 轮**仍未清零（写死）：三轮上限**只**停自动修循环。**未 Resolve 的 P1 永远挡合入**；重试次数不改变严重度。开跟进 issue/PR 交给人/产品继续修。**严禁**因重试次数 observe / won't-fix / Resolve 放行。禁止为凑绿弱化测试。

## Test Integrity Gate（试验观察，暂非必需）

与 Diff Quiz 并排：调用 `devflow-gates` 的 Assertion Guard / Skip Guard，检查名：

- `integrity / Assertion Guard` — 拦删/削弱监控与测试断言
- `integrity / Skip Guard` — 拦 skip/xit/optional/continue-on-error 逃避

**暂不**加入 branch protection / auto-merge `required_checks`（等 2026-11-02 理解门禁验收前再定是否升必需）。逃生：`## Test Integrity Override` + 理由。
