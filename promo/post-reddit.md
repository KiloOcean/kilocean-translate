# Reddit draft (r/chrome_extensions / r/deepseek)

Title: DeepSeek Live Page Translator — full-page + dynamic content, your own API key, minimal permissions

Body:
I built a small Chrome extension that translates the current page with your own DeepSeek API key.

Why I made it:
- I wanted DeepSeek quality without sending the key to another translation SaaS
- Most “AI translate” extensions ask for broad site access; this one uses activeTab and only talks to api.deepseek.com

What it does:
- Progressive full-page translation
- Keeps translating newly loaded DOM content as you scroll
- Restore original / export HTML / print to PDF
- Models: V4 Flash & V4 Pro
- Languages: zh-CN, zh-TW, en, ja, ko

Chrome Web Store:
https://chromewebstore.google.com/detail/deepseek-网页实时翻译/lmdbhjngjhlgbpmbjfffegjalchblpke

Still early (few installs, no reviews yet). Feedback welcome — bilingual side-by-side and selection translate are on my radar.

Independent project, not affiliated with DeepSeek. API usage billed by DeepSeek.
