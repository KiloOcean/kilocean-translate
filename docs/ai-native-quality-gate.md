# AI-Native Quality Gate · 质量门禁

CI 绿灯是**必要但不充分**条件。**禁止**仅凭 `Build & Test` 合入。

完整策略：[`MERGE_GATES.md`](MERGE_GATES.md) · [`QUALITY.md`](QUALITY.md) · [`AGENTS.md`](../AGENTS.md)

## 硬门槛（合并前必须）

1. **Build & Test**（`node scripts/ci-check.mjs`）
2. **Codex Review Gate**：Summary 覆盖当前 head SHA，且 **0** 个未解决 Codex 行内线程
3. **Conversation resolution**：所有 review threads 已 resolve
4. **自测清单**勾选（见下）
5. **权限未扩大**：`activeTab` / `scripting` / `storage`；host 仅 `https://api.deepseek.com/*`

### Copilot

- 默认要求 `copilot-pull-request-reviewer`（auto-merge 亦然）
- 配额耗尽时可**人工**豁免，但仍须 Codex + 会话解决 + Build
- Review 可为 `COMMENTED`（不要求 `APPROVED`）；`CHANGES_REQUESTED` 或未解决线程则不合

## 自测清单（PR #3 / bilingual + selection）

- [ ] 加载未打包扩展；版本 1.3.0，权限未变
- [ ] API Key；英文文章 → 默认双语对照
- [ ] 切换仅译文/原文/双语无需重新 API；清除译文不重置 displayMode
- [ ] MutationObserver 跟译新块
- [ ] 划词浮层；关闭后迟到响应不得重开/覆盖
- [ ] popup 注入后再划词
- [ ] 原文模式点翻译 → 自动双语并同步 storage
- [ ] 导出 HTML / 打印 PDF
- [ ] 跳过代码块/输入框/contenteditable
- [ ] chrome:// 友好错误

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/ci.yml` | **Build & Test** |
| `.github/workflows/codex-gate.yml` | **Codex Review Gate** |
| `.github/workflows/ai-review.yml` | 请求 Copilot；可选 Custom LLM |
| `.github/workflows/auto-merge.yml` | 全绿 squash（永不只靠 Build） |
| `scripts/ci-check.mjs` | `node scripts/ci-check.mjs` |
| `AGENTS.md` | Agent merge policy |
