# Reddit draft (r/chrome_extensions / r/deepseek) — v1.3.0 live

Title: Kilocean Translate — DeepSeek BYOK page translator with bilingual view + selection confirm (minimal perms)

Body:
I built a Chrome extension that translates the current page with your own DeepSeek API key (Key stays local).

What shipped in 1.3.0 (now live on the Web Store):
- Progressive full-page translation + follow newly loaded content
- Display modes: bilingual / translation-only / original
- Selection translate with popup confirmation (so the page can’t trigger billable calls alone)
- Better handling of long multi-paragraph blocks (e.g. long X posts without <p> tags)
- Restore original / export HTML / print PDF
- Permissions: activeTab + scripting + storage; host only api.deepseek.com

Chrome Web Store:
https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke

GitHub:
https://github.com/KiloOcean/kilocean-translate

Early days — looking for honest feedback (bugs and “please don’t add X” both useful). No review farming.

Independent project, not affiliated with DeepSeek. API usage billed by DeepSeek.

> 更新：现已支持 DeepSeek / Kimi 自备 Key；仍不登录、无会员墙、权限最小化。
