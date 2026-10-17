# QA 验收单 / QA Sign-off Checklist

> 用法 / Usage: 复制本模板到 PR 描述或 issue，逐项勾选后，在**最新 head commit** 上完成验证，
> 再给 PR 打 `qa-passed` 标签。新的 push 会自动移除该标签，必须重新走一遍本单。
> Copy this template into the PR description or an issue, check every item
> against the **latest head commit**, then apply the `qa-passed` label.
> Any new push removes the label automatically — redo this checklist.

PR: #___
被验收的 head commit / Verified head commit: `<COMMIT_SHA>`
验收人 / Reviewer: @___
日期 / Date: ___

## 测试点 / Test Points

- [ ] 核心用户路径可用 / Main user path works end to end
- [ ] 本 PR 变更的行为按预期生效 / Behavior changed in this PR matches expectations
- [ ] 回归：相邻功能未被破坏 / Regression: adjacent features unbroken
- [ ] 错误与边界情况（空输入、无效输入、网络失败）/ Errors and edge cases (empty input, invalid input, network failure)
- [ ] 权限与可见性正确 / Permissions and visibility are correct
- [ ] 移动端 / 小屏表现正常（如适用）/ Mobile or narrow viewport looks right (if applicable)
- [ ] 控制台无新增错误、警告 / No new console errors or warnings

## 1.4.3 手动验证（Key 持久化）/ 1.4.3 Manual checks (key persistence)

- [ ] **商店升级不丢 Key**：从商店上一版本（1.4.2 / 1.3.x）升级到 1.4.3 后，打开扩展弹窗无需重新输入 Key（顶部「DeepSeek / Kimi：已配置 · 尾号 xxxx」直接可见），整页翻译与划词翻译正常。
  **Upgrade from the previous store version (1.4.2 / 1.3.x) to 1.4.3 keeps saved keys** — the popup shows the per-provider key status (已配置 · 尾号 xxxx) without re-entering anything, and page/selection translation still work.（1.3.x 的单 Key 存量会自动迁移为 DeepSeek Key。）
- [ ] **unpacked 与商店 ID 一致**：开发者模式「加载已解压的扩展程序」加载本仓库根目录后，`chrome://extensions` 中显示的 ID 为 `lmdbhjngjhlgbpmbjfffegjalchblpke`，与商店条目一致（`manifest.json` 的 `key` 字段 = 商店公钥，见 `docs/STORE_KEY.md`）；unpacked 下同样能看到已保存的 Key 状态。
  **Unpacked install shows the same ID as the store listing** (`lmdbhjngjhlgbpmbjfffegjalchblpke`) because `manifest.key` carries the store public key.

## 1.5.0 手动验证（极简交互改版）/ 1.5.0 Manual checks (minimalist UX)

**弹窗 / Popup**
- [ ] 全新 profile 安装后自动打开新手引导页（welcome.html）；从 1.4.3 **更新**时不打开。
- [ ] 引导页：选服务商 → 粘贴 Key 自动验证（格式错误就地提示、不发请求；有效 Key 显示「✓ 已连接 · 尾号 xxxx」）→「试翻这段」出现双语结果；每一步都可以跳过。
- [ ] 没有 Key 时打开弹窗：首屏是「两步连上翻译服务」配置卡，**不出现「准备就绪」**，也看不到「翻译此页」按钮；粘贴有效 Key 验证通过后 1 秒内切换为已配置首屏。
- [ ] 已配置首屏：「译为 xx」、连接状态行、大按钮「翻译此页 Alt+A」、双语 / 译文 / 原文切换、划词提示，不滚动即可看全，弹窗高度约 300px（任何状态都不超过 600px）。
- [ ] 齿轮进入设置：服务商、Key、模型、测试连接、快捷键、导出 / 导入设置都在这里；「导入设置」仍会打开 popup.html?view=settings 标签页，Linux Chromium 上选择文件后导入正常。
- [ ] chrome:// 页面或应用商店页打开弹窗，直接显示「这个页面不能翻译」，翻译按钮不可点。

**快捷键与右键菜单 / Shortcuts and context menu**
- [ ] `chrome://extensions/shortcuts` 中显示「翻译此页 Alt+A」「翻译选中文字 Alt+T」（如被其他扩展占用则显示未设置，弹窗中也显示「未设置」）。
- [ ] 新打开、从没开过弹窗的网页：选中文字 → 按 Alt+T，2 秒内选区旁出现译文气泡；右键「翻译选中文字」同样可用。
- [ ] 没有选中文字时按 Alt+T：气泡提示「先选中要翻译的文字…」，不发请求。
- [ ] 没有 Key 时按 Alt+T：气泡提示「还没有配置 API Key」并有「打开设置」；按 Alt+A：打开设置标签页，不发请求。
- [ ] 网页脚本伪造的 mouseup / keyup / click 不会产生任何翻译请求（页内提示里没有可计费的按钮）。
- [ ] manifest 没有 `content_scripts`，host_permissions 仍只有两个翻译 API；新增的 `contextMenus` 在安装和更新时都没有权限警告。

**整页翻译 / Page translation**
- [ ] 长页面滚到中部后按 Alt+A：视口内的段落最先出现译文；右下角胶囊显示真实的「翻译中 N / M」，与弹窗进度一致。
- [ ] 人为制造失败（如断网后翻译几段）：失败段落末尾出现「这段没翻译成功（原因）· 重试」；胶囊显示「重试 K 段」，点击后只重发失败的段（background 日志里条目数 = K），已完成的段不重翻。
- [ ] 超过 5000 字的单个段落：任一半返回空时计为失败（胶囊 / 弹窗显示失败数），不再显示为全部成功。
- [ ] Key 无效（401）时胶囊保持显示，不自动消失，带「打开设置」。
- [ ] 完成后胶囊可切换双语 / 译文 / 原文、「还原」；导出 HTML 和打印里不包含胶囊和失败标记。

## 黄金样例 / Golden Samples

> 用真实输入/输出对固定行为，防止悄悄漂移。
> Use real input/output pairs to pin behavior against silent drift.

| # | 场景 Scenario | 输入 Input | 期望输出 Expected output | 实际 Actual | 通过 Pass |
| --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  | ☐ |
| 2 |  |  |  |  | ☐ |
| 3 |  |  |  |  | ☐ |

## 回滚命令 / Rollback Command

> 上线出问题时第一时间执行的命令（部署回退、功能开关、数据修复）。
> The first command to run when the release goes wrong (deploy revert,
> feature flag, data repair).

```bash
# 插件发布在 Chrome 网上应用店，商店不支持一键回退，也不允许重传更低版本号。
# 回滚做法：从上一个已知可用的提交（或 tag）重新打包，把版本号升到比线上更高的补丁号，再重新上传。
GOOD=<上一个已知可用的 commit 或 tag，例如 0253a57>
git worktree add /tmp/kt-rollback "$GOOD" && cd /tmp/kt-rollback
# 把 manifest.json 的 version 改成线上版本 +1 个补丁号（如线上 1.4.2 -> 1.4.3）
if [ -f scripts/pack.mjs ]; then node scripts/pack.mjs; else
  # 旧提交没有 pack.mjs：只打包扩展运行所需文件（排除 .git/scripts/tests/promo/selftest/docs）
  mkdir -p dist && zip -r "dist/kilocean-translate-$(node -p "require('./manifest.json').version").zip" \
    manifest.json *.js *.html *.css icons _locales -x '*.map' 2>/dev/null
  unzip -l dist/*.zip   # 核对清单：不能含 .git、key、测试文件
fi
# 在 https://chrome.google.com/webstore/devconsole 上传 dist/*.zip 并提交审核；审核通过前，可先在商店里暂停分阶段发布或取消待审核版本
```

### 1.4.3 额外检查

- [ ] 旧 unpacked（≤1.4.2，路径 ID）改为加载 1.4.3：ID 变为商店 ID，popup 显示「未配置」且缺 Key 引导含一次性过渡说明；粘贴一次后再次重载/更新不再需要输入。
- [ ] 导入设置：popup 点「导入设置」打开设置标签页（popup.html?view=settings），在该页选择 JSON 导入成功；Linux Chromium 上选择文件后导入仍执行。

## 签署 / Sign-off

- [ ] 我在上述 head commit 上完成了全部测试点与黄金样例 / I verified all test points and golden samples on the head commit above
- [ ] 回滚命令已演练或在预发验证过 / The rollback command was rehearsed or verified in staging
- [ ] 现在给 PR 打 `qa-passed` 标签 / Apply the `qa-passed` label to the PR now

> 注意 / Note: 打标签时间必须晚于最后一次 push —— 否则 QA Gate 会以
> "label predates the latest push" 拒绝。push 新提交后标签被自动移除，
> 需重新验收并再次打标。
> The label must be applied AFTER the last push — otherwise the QA Gate
> rejects with "label predates the latest push". A new push removes the
> label; re-verify and re-apply it.
