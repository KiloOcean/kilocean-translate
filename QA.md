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
