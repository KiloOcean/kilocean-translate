# Webpage-translation extension user complaints (Chrome/Edge focus)

**Collected:** 2026-09-22 (Asia/Taipei)  
**Purpose:** Pain points useful for **Kilocean Translate / 千浩翻译** positioning (DeepSeek BYOK, bilingual, selection confirm, minimal permissions).  
**Method:** Primary store reviews (Firefox AMO where Chrome text is JS-gated; Extpose/ExtSpot/Tooltivity for Chrome aggregates), V2EX public threads, X/Twitter public posts via API, GitHub issues, own CWS + GitHub.  
**Caveats:** Chrome Web Store review *bodies* are not reliably scrapeable without browser UI; Immersive 1★ quotes below lean on **Firefox AMO** (same product family) + review aggregators that claim Chrome-sample analysis. Reddit keyword search returned a **thin** set of organic complaints (many Immersive promo replies). 即刻 public pages not retrieved without login. Prefer quotes labeled with source; do not treat aggregator summaries as verbatim user text.

---

## 1. Summary themes (ranked by observed frequency)

| Rank | Theme | Frequency signal | Main products named |
|------|--------|------------------|---------------------|
| 1 | **Paywall / freemium bait-and-switch** (free engines removed, quotas, VIP nags) | Very high — Immersive recent rating collapse; DeepL full-page Pro gate | Immersive Translate, DeepL |
| 2 | **Forced login / account funnel + upgrade pop-ups** | Very high — AMO 1★ cluster; Tooltivity “hourly full-screen signup” | Immersive Translate, DeepL |
| 3 | **BYOK / custom API gated or unreliable** (import API behind Pro; model swap / fallback) | High — V2EX + X + ExtSpot | Immersive Translate |
| 4 | **Privacy / key & content exposure** (token sync; public “网页快照”) | High in CN community (V2EX spikes) | Immersive Translate |
| 5 | **Extension breaks host sites** (unscoped CSS, layout, Google Apps, SPA/DOM) | High — DeepL Jul 2026 update storm on Extpose | DeepL; also Google Translate vs React (dev issues) |
| 6 | **Translation quality / wrong language / free-tier AI bad** | High in recent Immersive 1★ | Immersive Translate |
| 7 | **Reliability: 429, silent fail, SPA/dynamic pages, Reddit/iframes** | Medium–high | Immersive, KISS, DeepL-on-Reddit reports |
| 8 | **Bloat / intrusive UI** (floating icons, auto-translate can’t turn off, memory) | Medium | Immersive, DeepL, KISS (icon too loud) |
| 9 | **Broad permissions / tracker / closed-source trust** | Medium (privacy-minded users + Tooltivity flags) | Immersive (`<all_urls>`, GA) |
| 10 | **PDF / document / subtitle edge cases** | Medium (feature demand + breakage) | Immersive, KISS YouTube issues |
| 11 | **Opaque billing / refunds / high annual price** | Medium (ExtSpot CN ~¥600/yr mentions) | Immersive, DeepL pricing complaints |

---

## 2. Evidence table (theme | quote | source | product)

### Theme A — Paywall / free engines removed / VIP nags

| Example quote (verbatim where possible) | Source | Stars / date if shown | Product |
|-----------------------------------------|--------|----------------------|---------|
| 「为了卖vip阉割免费版有点过分了，何况vip这么贵」 | [Firefox AMO Immersive reviews (1★)](https://addons.mozilla.org/en-US/firefox/addon/immersive-translate/reviews/?score=1) | 1★ · ~1 month ago | Immersive Translate |
| 「免费的微软翻译已经不可用了，现阶段有弹窗强推pro服务的销售行为。目前免费的只能用插件自带的翻译水平很烂的普通ai翻译」 | same AMO 1★ list | 1★ · 13 days ago | Immersive Translate |
| “Aggressively pushing for login and payment, terrible quality in free version” | same | 1★ · 17 days ago | Immersive Translate |
| “Antes funcionava, agora tem que pagar. Pessimo” | same | 1★ · ~3 months ago | Immersive Translate |
| “Sorry, I don't support paywalls.” | [Firefox AMO DeepL 1★](https://addons.mozilla.org/en-GB/firefox/addon/deepl-translate/reviews/?score=1) | 1★ · ~1 month ago | DeepL |
| “Paygated full-site translations.” / “No full web-page translation… Available for PRO users” | same DeepL AMO | 1★ | DeepL |
| “its so bad doesnt even work have to pay” | [Extpose DeepL Chrome reviews](https://extpose.com/ext/249020) | ~2026-08-10 | DeepL |
| Aggregator: free Google/Microsoft engines removed; own API keys require Pro; last-100-review mood ~2.2★ (Tooltivity) | [Tooltivity Immersive review](https://tooltivity.com/extensions/immersive-translate) (updated 2026-07-22) | CWS lifetime ~3.9–4.0★ / ~3M users | Immersive Translate |

**Store snapshots (approx., from CWS HTML / ExtSpot, 2026-09-22):**

| Extension | CWS ID / URL | Rating (HTML) | Users (HTML) |
|-----------|--------------|---------------|--------------|
| Immersive Translate | [bpoadfkcbjbfhfodiogcnhhhpibjhbnh](https://chromewebstore.google.com/detail/immersive-translate-ai-we/bpoadfkcbjbfhfodiogcnhhhpibjhbnh) | ~3.9 / 5 | ~3,000,000 |
| DeepL | [cofdbpoegempjloogbagkncekinflcnj](https://chromewebstore.google.com/detail/deepl-translate-reading-w/cofdbpoegempjloogbagkncekinflcnj) | ~4.7 / 5 | ~4,000,000 |
| Google Translate | [aapbdbdomjkkjkaonfhkkikfgjllcleb](https://chromewebstore.google.com/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb) | ~4.2 / 5 | ~37,000,000 |
| Trancy | [mjdbhokoopacimoekfgkcoogikbfgngb](https://chromewebstore.google.com/detail/trancy-ai-translator-dual/mjdbhokoopacimoekfgkcoogikbfgngb) | ~4.7 / 5 | ~300,000 |
| KISS Translator | [bdiifdefkgmcblbcghdlonllpjhhjgof](https://chromewebstore.google.com/detail/kiss-translator/bdiifdefkgmcblbcghdlonllpjhhjgof) | ~4.8 / 5 | ~100,000 |
| FluentRead 流畅阅读 | [djnlaiohfaaifbibleebjggkghlmcpcj](https://chromewebstore.google.com/detail/fluentread-%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/djnlaiohfaaifbibleebjggkghlmcpcj) | ~4.5 / 5 | ~20,000 |
| DeepSeek Immersive Translator | [ekmmhhmapbhjoaelnhccpepclpfalbnd](https://chromewebstore.google.com/detail/deepseek-immersive-transl/ekmmhhmapbhjoaelnhccpepclpfalbnd) | **No ratings** | ~15 users |

---

### Theme B — Forced login / upgrade pop-ups / “adware” feel

| Quote | Source | Product |
|-------|--------|---------|
| “the add-on has interrupted my browser use with a full-screen pop-up window to sign up with an account once per hour… I'm uninstalling it.” | [AMO Immersive 1★ — Ru](https://addons.mozilla.org/en-US/firefox/addon/immersive-translate/reviews/?score=1) (~2 months ago) | Immersive |
| “Forces you to log in to track you and forces you into a dumb subscription…” | AMO Immersive — Valkris | Immersive |
| 「我只想安安静静的翻译文本，一直弹出升级VIP……」 | AMO Immersive | Immersive |
| 「越更新越难用，非要逼人充值我也是服了」 | AMO Immersive | Immersive |
| “rubbish. if you don't log in you get close to nothing.” | [AMO DeepL 1★](https://addons.mozilla.org/en-GB/firefox/addon/deepl-translate/reviews/?score=1) | DeepL |
| “Постійно просить авторизуватись. Не працює” | AMO DeepL | DeepL |
| AMO Immersive (en-GB older list): “Its ad generation addon not translator… constantly pester you to log-in and then to pay” | [AMO Immersive reviews en-GB](https://addons.mozilla.org/en-GB/firefox/addon/immersive-translate/reviews/) | Immersive |

---

### Theme C — BYOK / custom API paywalled or untrustworthy

| Quote | Source | Product |
|-------|--------|---------|
| 「沉浸式翻译去年爆出隐私漏洞问题我就卸载了。现在居然导入 API 也是付费功能…」 (+ recommends Trancy + DeepSeek) | [X @Ivanfomo](https://x.com/Ivanfomo/status/2067812328360611940) (2026-06-19; still recirculated Sep 2026) | Immersive |
| 「实在受不了沉浸式翻译越来越臃肿，一个普通的翻译功能，竟然还收费！还不能用自己的API key？」 | [X @ChanFountain](https://x.com/ChanFountain/status/2095709994020962504) (2026-09-04) | Immersive |
| 「不允许未认证的第三方 api ，只允许本地的 api ，这有点离谱了吧。」 → official apology: 「立即撤回所有关于限制第三方服务的计划…永久保持开放」 | [V2EX t/1151127](https://www.v2ex.com/t/1151127) (2025-08-08/09) | Immersive |
| 「我用啥 API 为什么要管我？想赚钱直说…越来越臃肿。」 | same thread, reply Lanzhijiang | Immersive |
| Paying member: selection translate silently falls back after 429; 「最后使用了免费模型 glm-4-flash」; official: 划词不跟随网页翻译服务 | [V2EX t/1150696](https://www.v2ex.com/t/1150696) (2025-08-07) | Immersive |
| Tooltivity / ExtSpot: “Own API keys require Pro”; “custom API integrations not functioning as expected” | [Tooltivity](https://tooltivity.com/extensions/immersive-translate), [ExtSpot](https://extspot.com/extension/bpoadfkcbjbfhfodiogcnhhhpibjhbnh) | Immersive |

---

### Theme D — Privacy (API tokens, public snapshots)

| Quote / fact | Source | Product |
|--------------|--------|---------|
| 「沉浸式翻译强制会收集所有用户大模型服务和翻译服务的 token ，同步至他们的服务器」 (endpoint `api2.immersivetranslate.com/v1/user/settings`) | [V2EX t/1042477](https://www.v2ex.com/t/1042477) (2024-05-21) | Immersive |
| 「沉浸式翻译的网页快照功能会泄露隐私」 — users report searchable public snapshots; design criticism: no password / robots / default-public | [V2EX t/1151165](https://www.v2ex.com/t/1151165) (2025-08-09) | Immersive |
| 「按钮叫网页快照，这个文案将背后的分享风险大大隐藏了」 | same thread, AlwaysBee | Immersive |
| FluentRead author thread references prior token-upload controversy + community distrust | [V2EX t/1151203](https://www.v2ex.com/t/1151203) (search hit; full fetch intermittent) | Immersive vs FluentRead |
| Tooltivity security note: tracker `google-analytics.com`; permissions include `<all_urls>`, `webRequest`, DNR | [Tooltivity](https://tooltivity.com/extensions/immersive-translate) | Immersive |

---

### Theme E — Extension breaks websites / unscoped CSS / SPA

| Quote | Source | Product |
|-------|--------|---------|
| “v1.96.0 injects an unscoped CSS rule… `.search-icon`… silently breaks third-party sites.” | [Extpose DeepL](https://extpose.com/ext/249020) — Peter Moussa, 2026-07-28 | DeepL |
| “The latest update broke a ton of Tailwind sites!” / bare `.hidden { display: none }` | Extpose DeepL — Andrii Poluosmak / Shain Padmajan, 2026-07-27 | DeepL |
| “broke my Google Drive formatting bar” / “Google Docs/Spreadsheet menus” (cluster of same-day 1★) | Extpose DeepL, 2026-07-27–28 | DeepL |
| “An hour debugging… Google Sheet Top Menu disappearing… this extension was the cause.” | Extpose DeepL — Carlos | DeepL |
| React/Solid known breakage when Google Translate mutates text nodes | [facebook/react#11538](https://github.com/facebook/react/issues/11538), [solid#1451](https://github.com/solidjs/solid/issues/1451) | Google Translate (engine/extension class) |
| KISS: 「YouTube 评论排序菜单被翻译节点破坏导致布局异常」 | [kiss-translator#1067](https://github.com/fishjar/kiss-translator/issues/1067) | KISS Translator |
| KISS: 「部分页面内嵌的 script 代码被误识别为正文并附加译文」 | [kiss-translator#1095](https://github.com/fishjar/kiss-translator/issues/1095) | KISS Translator |
| KISS: Reddit / cross-origin iframe settings fallback | [kiss-translator#1089](https://github.com/fishjar/kiss-translator/issues/1089) | KISS Translator |

**Reddit note:** Search for organic “paywall/permissions” threads on r/chrome_extensions etc. was **thin**; one cited Edge thread about DeepL not working on Reddit ([r/MicrosoftEdge](https://www.reddit.com/r/MicrosoftEdge/comments/1de6104/deepl_extension_not_work_on_reddit/) — page fetch timed out here). Older Reddit threads often contain Immersive **promo-style** replies claiming “totally free,” which is **stale relative to 2025–2026 monetization** and should not be used as current user praise.

---

### Theme F — Quality, reliability, auto-translate, memory, UI chrome

| Quote | Source | Product |
|-------|--------|---------|
| Free plan: “translated sentences are completely different from the original…” | AMO Immersive — Kei | Immersive |
| “article titles will be translated into Mandarin instead of English” after AI switch | AMO Immersive | Immersive |
| 「自动翻译关不掉，体验太差了！！」 | AMO Immersive — aspi | Immersive |
| Tooltivity: silent fails, greyed translations, YouTube 429, Netflix needs refreshes; ~12 MB heavyweight | [Tooltivity](https://tooltivity.com/extensions/immersive-translate) | Immersive |
| DeepL: RAM grows “even above 1GB” until disable | AMO DeepL — anon | DeepL |
| DeepL: intrusive icon / Write mode hard to turn off | AMO DeepL — BullFrog / Kavinskyx | DeepL |
| DeepL: “Sorry, we cannot translate your text” EN→ZH | AMO DeepL — ffzby | DeepL |
| Trancy BYOK free model: 「中国語と日本語と英語が入り混じったキメラ言語に翻訳されて終わってる」 | [X @minatochang](https://x.com/minatochang/status/2094142171846980028) | Trancy |
| Users switching Immersive → Trancy for speed/simplicity | [X @jaycybird](https://x.com/jaycybird/status/2084149271897739299) | Immersive → Trancy |
| FluentRead GH: selection UI obscured / color issues | [FluentRead#207](https://github.com/Bistutu/FluentRead/issues/207), [#143](https://github.com/Bistutu/FluentRead/issues/143) | FluentRead |
| NodeLoc: KISS selection icon “too eye-catching” → users want subtler trigger | [NodeLoc topic](https://www.nodeloc.com/t/topic/65275) | KISS Translator |

---

### Theme G — PDF / video / learning extras (adjacent complaints)

- Immersive marketed for PDF/EPUB/subtitles; complaints mix **quota** and **429 on YouTube** (AMO + Tooltivity) rather than “PDF unsupported.”
- KISS open issues include YouTube subtitle / PiP / repeated re-translate after interaction (`#1072`, `#1054`, `#1052`).
- Product implication for Kilocean: users still want **dynamic page follow**; PDF/video are competitor strengths but also **complexity/bloat** magnets.

---

## 3. Gaps vs Kilocean Translate (already solve vs still open)

**Kilocean facts (primary):**  
- CWS: [lmdbhjngjhlgbpmbjfffegjalchblpke](https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke) — listing shows **“No ratings”**, ~**8 users**, v1.3.0 listed on store page (repo `manifest.json` is **1.3.1**).  
- GitHub: [KiloOcean/kilocean-translate](https://github.com/KiloOcean/kilocean-translate) — **0 stars**, **0 open issues**; history is closed internal PRs only (no external user bug reports yet).  
- Permissions: `activeTab`, `scripting`, `storage` + host `https://api.deepseek.com/*` only. Key local; no account/membership in README.

| Competitor pain | Kilocean today | Gap / risk for Kilocean |
|-----------------|----------------|-------------------------|
| Paywall / VIP nags / engine removal | No membership; user pays DeepSeek directly | Must stay that way; document cost transparency (token bills) |
| Forced login | No login | — |
| BYOK gated behind Pro | DeepSeek BYOK is the product | Only DeepSeek today — multi-provider demand exists (OpenRouter etc.) |
| Token uploaded to vendor cloud | Key stays in `chrome.storage` | Keep “no sync of keys”; don’t add cloud sync without explicit opt-in |
| Public webpage snapshot SEO leak | No snapshot/share feature | Don’t add public share without password/expiry/robots |
| `<all_urls>` always-on + trackers | `activeTab` inject on use | Users must open popup once before selection translate — UX friction vs always-injected rivals |
| Unscoped CSS breaking Google Apps | Smaller surface; still injects into page | Need regression watch on Tailwind/SPA sites |
| Auto-translate can’t turn off | User-triggered translate + follow new content | Follow-content must stay controllable; avoid Immersive-style “always on” |
| Selection UX (confirm / subtle) | Selection float exists; README notes inject-first | “Selection confirm” / less-intrusive trigger is a **positioning win** vs loud icons |
| Bilingual layout | Supported (双语 / 仅译文 / 原文) | Match Immersive quality on complex DOM (tables, shadow DOM) |
| SPA / Reddit / iframe | Progressive + MutationObserver-style follow (per README) | Open risk: same class of bugs as KISS `#1089`, `#1072` — **no public filed issues yet** |
| PDF / EPUB / dual subtitles | Print/export HTML→PDF only | Feature gap vs Immersive/Trancy if users need reader/subtitle suite |
| Free MT without API key | Requires DeepSeek key | Barrier for casual users who want zero-config Google/Bing |
| Memory / 12 MB bloat | ~59 KiB store size | Keep lean as differentiator |
| Trust / open source narrative | Public GitHub; early | Competitors’ “fake open source” history (V2EX) — **clarity** helps |

---

## 4. Own-product feedback status

| Channel | Status (2026-09-22) |
|---------|---------------------|
| Chrome Web Store reviews | **Zero ratings / “No ratings”**; ~8 users on listing HTML |
| Chrome Web Store stars | N/A (0) |
| GitHub Issues (user-facing) | **None open**; repo `open_issues_count: 0` |
| GitHub history | Closed PRs only (features/CI); e.g. bilingual+selection in PR #5/#3; long-post recovery PR #8 |
| External complaint corpus about Kilocean | **None found** in this pass (expected at early install count) |

**Implication:** Competitive complaint themes are abundant; first-party feedback is still a **blank slate**. Promo/docs should answer Immersive/DeepL pains *before* users hit them (BYOK free of Pro, no login, minimal perms, key never leaves machine).

---

## 5. Source index (primary & near-primary)

1. Firefox AMO Immersive 1★: https://addons.mozilla.org/en-US/firefox/addon/immersive-translate/reviews/?score=1  
2. Firefox AMO DeepL 1★: https://addons.mozilla.org/en-GB/firefox/addon/deepl-translate/reviews/?score=1  
3. Chrome Immersive listing: https://chromewebstore.google.com/detail/immersive-translate-ai-we/bpoadfkcbjbfhfodiogcnhhhpibjhbnh  
4. ExtSpot Immersive: https://extspot.com/extension/bpoadfkcbjbfhfodiogcnhhhpibjhbnh  
5. Tooltivity Immersive: https://tooltivity.com/extensions/immersive-translate  
6. Extpose DeepL reviews: https://extpose.com/ext/249020  
7. V2EX token sync: https://www.v2ex.com/t/1042477  
8. V2EX third-party API ban (withdrawn): https://www.v2ex.com/t/1151127  
9. V2EX model swap: https://www.v2ex.com/t/1150696  
10. V2EX webpage snapshot privacy: https://www.v2ex.com/t/1151165  
11. X Ivanfomo (API paywall): https://x.com/Ivanfomo/status/2067812328360611940  
12. X ChanFountain (bloat/API): https://x.com/ChanFountain/status/2095709994020962504  
13. KISS Translator issues: https://github.com/fishjar/kiss-translator/issues  
14. FluentRead issues: https://github.com/Bistutu/FluentRead/issues  
15. Kilocean CWS: https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke  
16. Kilocean GitHub: https://github.com/KiloOcean/kilocean-translate  

---

## 6. Sampling honesty

- **Strongest evidence:** Immersive AMO 1★ + V2EX threads + DeepL Extpose Jul-2026 CSS incident cluster.  
- **Moderate:** Tooltivity/ExtSpot theme counts (secondary analysis of store reviews).  
- **Thin:** Organic Reddit complaint threads; Chrome CWS raw 1★ text (JS-gated); 即刻; non-Immersive “DeepSeek translate” clones (almost no reviews).  
- **Do not fabricate** Chrome Immersive 1★ bodies not captured in this pass — use AMO/V2EX/X/GitHub instead.

