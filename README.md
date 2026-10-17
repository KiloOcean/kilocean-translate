# 千浩翻译 · Kilocean Translate

Chrome / Edge 扩展：用你自己的 DeepSeek 或 Kimi（Moonshot）API Key，渐进式翻译当前网页，并自动跟译新加载内容。

**Chrome Web Store:** https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke

## 功能

- **双语对照**：整页按段落保留原文，并在段落下插入译文（默认）
- **显示模式**：双语对照 / 仅译文 / 恢复原文（写入 `chrome.storage`）
- **划词翻译**：选中文字后按 `Alt+T`，或右键「翻译选中文字」，译文直接显示在选区旁的气泡里，不用先打开弹窗。只有浏览器快捷键、右键菜单或扩展弹窗能触发计费，网页里的按钮无法触发
- **一键整页**：弹窗首屏就是「翻译此页」按钮，快捷键 `Alt+A`
- **页内进度胶囊**：右下角显示真实的「已翻译 N / M 段」，先翻可见区域；失败的段落就地标出，可以只重试失败的段（不会重翻已完成的段）
- 整页渐进式翻译，不必等全部完成
- 自动跟译滚动 / 交互后新加载的内容
- 目标语言：简体中文、繁体中文、英语、日语、韩语
- 支持 DeepSeek Flash / V4 Pro，以及 Kimi（K2.6 / K3 / Moonshot V1 128k）
- 一键还原原文
- 导出翻译后 HTML；打印 / 保存 PDF
- 自动跳过代码、输入框、链接、纯数字
- API Key 只存在本机 Chrome 存储；无登录、无会员墙
- 只在你主动使用扩展（点图标、按快捷键、点右键菜单）时访问当前标签页（`activeTab` + `scripting`），不常驻注入任何网页

## 安装（开发者模式）

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本仓库根目录
3. 首次安装会自动打开新手引导页：选服务商 → 粘贴 Key（自动验证）→ 试翻一段示例
4. 之后在任意网页：点扩展图标再点「翻译此页」（或按 `Alt+A`）；划词时选中文字后按 `Alt+T` 或右键「翻译选中文字」
5. 快捷键可在 `chrome://extensions/shortcuts` 修改；弹窗右上角齿轮进入设置（服务与 Key、模型、快捷键、备份）

## 快捷键

| 操作 | 默认快捷键 | 说明 |
| --- | --- | --- |
| 翻译此页 | `Alt+A`（macOS：`Option+A`） | 与 Chrome 自带快捷键不冲突（Chrome 用的是 `Alt+Shift+A`） |
| 翻译选中文字 | `Alt+T`（macOS：`Option+T`） | 与 Chrome 自带快捷键不冲突（Chrome 用的是 `Alt+Shift+T`） |

如果其他扩展已经占用了同一组合，Chrome 不会分配建议快捷键，弹窗里会显示「未设置」，到 `chrome://extensions/shortcuts` 重新设置即可。

## 权限说明

- `activeTab` / `scripting`：只在你点扩展图标、按快捷键或点右键菜单时，向当前标签页注入翻译脚本；没有 `content_scripts`，也没有「读取所有网站」权限
- `storage`：本机保存 API Key 与显示模式
- `contextMenus`（1.5.0 新增）：在右键菜单里加「翻译选中文字」「翻译此页」两项。按 Chrome 文档，这个权限**不会**触发安装或更新时的权限警告，已安装用户更新后扩展不会被停用
- Host：`https://api.deepseek.com/*`；启用 Kimi 时另需 `https://api.moonshot.cn/*`

## 商店包

正式发布请用商店后台上传的 zip（勿把含密钥的本地配置打进包）。当前版本见 `manifest.json`（1.5.0）。

`manifest.json` 中的 `key` 字段是本扩展在 Chrome Web Store 的**公钥**（public key），不是 API Key，可以安全保留在仓库与上传包中：它保证 unpacked（开发者模式加载）与商店安装得到同一个扩展 ID（`lmdbhjngjhlgbpmbjfffegjalchblpke`），存储（含已保存的 API Key）在两者之间通用。此前以开发者模式加载 ≤1.4.2 的用户在切换到固定 ID 时会有一次性的存储变化（新 ID 读不到旧 ID 的存储，≤1.4.2 也没有导出功能）：可在原路径临时去掉 `key` 加载 1.4.3，用「设置备份」导出（勾选「包含 API Key（明文保存，勿分享）」），恢复 `key` 后再导入；或直接重新粘贴一次 Key。商店安装不受影响。CWS 上传包含 `key` 的 zip 时，仅当该 key 与商店条目的公钥一致才会被接受；不一致时须先移除该字段再上传。详见 [`docs/STORE_KEY.md`](docs/STORE_KEY.md)。

## 隐私

网页文本会发往你选择的服务商 API（DeepSeek 或 Moonshot/Kimi）以完成翻译。划词翻译只发送你选中的文字，并且只在你按快捷键或点右键菜单后发送；右键菜单本身不读取页面内容。开发者不接收、不存储网页内容或你的 API Key。本扩展为独立第三方工具，与 DeepSeek / Moonshot 官方无隶属关系。


## 质量门禁 / Quality Gate

合并前请阅读：

- [Merge gates](docs/MERGE_GATES.md) — ci / Build & Test + ci / Secret Scan + codex / Codex Review Gate + qa / QA Gate + conversation resolution；禁止只靠 Build 合入；Copilot 配额耗尽可人工豁免 Copilot
- [Quality](docs/QUALITY.md) — CI / AI review 配置
- [AI-Native Quality Gate](docs/ai-native-quality-gate.md) — 自测清单

本地检查：

```bash
node scripts/ci-check.mjs
```

Agent 简报：[`AGENTS.md`](AGENTS.md)。

## 许可

个人 / 团队维护中。Issues / PR 欢迎。
