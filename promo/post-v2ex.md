# V2EX 发帖草稿（1.3.0）

标题：分享自用的网页翻译扩展：千浩翻译 · Kilocean Translate（BYOK DeepSeek，双语/划词，权限极小）

正文：
读外文文档比较多，不太想给翻译插件开一堆权限或绑账号，所以做了个 Chrome 扩展：用自己的 DeepSeek API Key 翻当前页。

现在能做的（商店送审 1.3.0，过审前也可开发者模式加载）：
- 整页渐进翻译，懒加载内容会跟译
- 显示模式：双语对照 / 仅译文 / 原文
- 划词翻译：页面提示后，在扩展弹窗确认才翻译（防页面伪造请求）
- 超长多段落块（例如 X 长帖那种没有 <p> 的）也能翻
- 可恢复原文；可导出 HTML / 打印 PDF
- 权限：activeTab + scripting + storage；Host 仅 api.deepseek.com
- Key 只存在本机，不经过我

商店（当前线上仍可能是 1.2.0，1.3.0 审核中）：
https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke

开源：
https://github.com/KiloOcean/kilocean-translate

有 bug 或想要的功能直接回帖，按真实反馈排。独立开发，和 DeepSeek 官方无关；API 费用按官方计费。

> 更新：现已支持 DeepSeek / Kimi 自备 Key；仍不登录、无会员墙、权限最小化。
