# 千浩翻译 · Kilocean Translate

Chrome / Edge 扩展：用你自己的 DeepSeek API Key，渐进式翻译当前网页，并自动跟译新加载内容。

**Chrome Web Store:** https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke

## 功能

- 整页渐进式翻译，不必等全部完成
- 自动跟译滚动 / 交互后新加载的内容
- 目标语言：简体中文、繁体中文、英语、日语、韩语
- 支持 DeepSeek V4 Flash / V4 Pro
- 一键恢复原文
- 自动跳过代码、输入框、链接、纯数字
- API Key 只存在本机 Chrome 存储
- 仅在用户主动点击后访问当前标签页

## 安装（开发者模式）

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本仓库根目录
3. 点击扩展图标，填入 DeepSeek API Key，选择语言与模型后翻译

## 商店包

正式发布请用商店后台上传的 zip（勿把含密钥的本地配置打进包）。当前商店版本见 `manifest.json`。

## 隐私

网页文本会发往 DeepSeek API 以完成翻译；开发者不接收、不存储网页内容或你的 API Key。本扩展为独立第三方工具，与 DeepSeek 官方无隶属关系。

## 质量门禁 / Quality Gate

合并前请阅读：

- [Merge gates](docs/MERGE_GATES.md) — Codex Review Gate + conversation resolution + Build；禁止只靠 Build 合入；Copilot 配额耗尽可人工豁免 Copilot
- [Quality](docs/QUALITY.md) — CI / AI review 配置
- [AI-Native Quality Gate](docs/ai-native-quality-gate.md) — 自测清单

本地检查：

```bash
node scripts/ci-check.mjs
```

Agent 简报：[`AGENTS.md`](AGENTS.md)。

## 许可

个人 / 团队维护中。Issues / PR 欢迎。
