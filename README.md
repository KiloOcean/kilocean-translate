# 千浩翻译 · Kilocean Translate

Chrome / Edge 扩展：用你自己的 DeepSeek API Key，渐进式翻译当前网页，并自动跟译新加载内容。

**Chrome Web Store:** https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke

## 功能

- **双语对照**：整页按段落保留原文，并在段落下插入译文（默认）
- **显示模式**：双语对照 / 仅译文 / 恢复原文（写入 `chrome.storage`）
- **划词翻译**：选中文本后弹出浮层译文，可关闭
- 整页渐进式翻译，不必等全部完成
- 自动跟译滚动 / 交互后新加载的内容
- 目标语言：简体中文、繁体中文、英语、日语、韩语
- 支持 DeepSeek V4 Flash / V4 Pro
- 一键清除译文并恢复页面
- 导出翻译后 HTML；打印 / 保存 PDF
- 自动跳过代码、输入框、链接、纯数字
- API Key 只存在本机 Chrome 存储；无登录、无会员墙
- 仅在用户主动打开扩展后访问当前标签页（`activeTab` + `scripting`）

## 安装（开发者模式）

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本仓库根目录
3. 点击扩展图标，填入 DeepSeek API Key，选择语言、模型与显示模式后翻译
4. 需要划词翻译时，先打开一次扩展弹窗以注入当前标签页脚本，再回到页面选中文本

## 权限说明

- `activeTab` / `scripting`：仅在你使用扩展时注入当前页
- `storage`：本机保存 API Key 与显示模式
- Host：仅 `https://api.deepseek.com/*`

## 商店包

正式发布请用商店后台上传的 zip（勿把含密钥的本地配置打进包）。当前版本见 `manifest.json`（1.3.0）。

## 隐私

网页文本会发往 DeepSeek API 以完成翻译；开发者不接收、不存储网页内容或你的 API Key。本扩展为独立第三方工具，与 DeepSeek 官方无隶属关系。


## 质量门禁 / Quality Gate

合并前请阅读 [AI-Native Quality Gate](docs/ai-native-quality-gate.md)：CI 绿灯必要但不充分，还需自测清单 + AI review。

本地检查：

```bash
node scripts/ci-check.mjs
```

## 许可

个人 / 团队维护中。Issues / PR 欢迎。
