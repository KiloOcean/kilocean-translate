# V2EX 发帖草稿

标题：分享一个自用的 DeepSeek 网页翻译插件（权限极小，动态内容跟译，可导出 HTML）

正文：
最近读外文文档比较多，市面上翻译插件要么捆绑账号，要么权限开很大。自己做了一个 Chrome 扩展，用自己的 DeepSeek API Key 做整页翻译。

能力大概是：
- 点一下翻译当前页，分批渐进出结果
- 滚动 / 懒加载出来的新内容会继续译
- 可恢复原文；翻完能导出 HTML 或打印 PDF
- 权限只有 activeTab / scripting / storage，Host 权限仅限 api.deepseek.com
- Key 只存在本地，不经过我

商店链接：
https://chromewebstore.google.com/detail/deepseek-网页实时翻译/lmdbhjngjhlgbpmbjfffegjalchblpke

目前用户还很少、也还没有评价。如果你也在用 DeepSeek，欢迎试试看；有 bug 或想要的功能（双语对照 / 划词）直接回帖，我按反馈排期。

（独立开发，和 DeepSeek 官方无关；API 费用按官方计费。）
