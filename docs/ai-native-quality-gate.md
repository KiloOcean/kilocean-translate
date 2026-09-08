# AI-Native Quality Gate · 质量门禁

CI 绿灯是**必要但不充分**条件（necessary, not sufficient）。合并前还必须完成人工自测与 AI 审查。

`CI green ≠ ready to merge.`

## 合并前必须满足

1. **CI `Build & Test` 通过**（`scripts/ci-check.mjs`：manifest / 权限白名单 / 语法 / 静态安全禁令）
2. **自测清单全部勾选**（见下方 / PR #3 test plan）
3. **AI 审查**：Copilot / Codex（或同类）完成 review，相关 threads 已 resolve
4. **权限未扩大**：仍仅为 `activeTab` / `scripting` / `storage`，host 仅 `https://api.deepseek.com/*`

## 自测清单（PR #3）

- [ ] 加载未打包扩展；确认版本 1.3.0，权限未变
- [ ] 填写 API Key；翻译英文文章 → 默认双语对照（原文 + 段落下译文）
- [ ] 切换「仅译文 / 原文 / 双语对照」无需重新调用 API；「清除译文」后 DOM 正确恢复，且**不重置**用户显示模式偏好
- [ ] 滚动 / 动态内容 → MutationObserver 跟译新块
- [ ] 划词 → 浮层译文；× / Esc / 点击外部可关闭；关闭后迟到的翻译响应**不得**重新打开或覆盖更新的划词结果
- [ ] 先打开一次 popup 注入，再划词（selection inject path）
- [ ] 在「原文」模式下点翻译 → 自动切到双语，并同步 popup 单选与 `chrome.storage.displayMode`
- [ ] 导出 HTML / 打印 PDF 在双语翻译后仍可用
- [ ] 代码块 / 输入框 / contenteditable 被跳过
- [ ] `chrome://` 等受限页显示友好错误

## AI Review

- 请 Copilot / Codex 审查内容脚本划词竞态、显示模式与 storage 一致性、权限面
- 合并前 resolve 所有 review threads；有争议先修再合

## 相关文件

- `.github/workflows/ci.yml` — job name: **Build & Test**
- `scripts/ci-check.mjs` — 本地可跑：`node scripts/ci-check.mjs`
