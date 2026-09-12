# MiniDeck Product Board Audit — 2026-09-12 10:10 Asia/Taipei

> 本報告中的 50 Persona 與偏好份額全部是合成情境模擬，不是真人研究、可用性測試、市場調查或真實市占。所有 Runtime 結論均另行標記。

## Executive Summary

本輪對 `Reese-max/minideck` 的 default branch `main@3fb825509e4a95d3acb694f26e7d90f5e62d678a` 做增量深巡檢。MiniDeck 是部署於 Cloudflare Worker、D1 與 R2 的輕量 AI 簡報產品：使用者可由題目產生 HTML deck、競選三個版本、產圖、修訂、版本回退、公開播放及匯出 HTML/PDF/PPTX。

最值得保留的產品優勢是「低負擔地從 prompt 到可分享 HTML」。最大可信度缺口仍是同一個已知根因：匿名 `/p/:id` 直接追隨 `current_version`；每次 save/generate/revise/rollback 都可能無聲改變已交付內容，且沒有 `published_version`、preview/publish/unpublish 邊界。

**Decision: INVEST / SIMPLIFY.** 不增加更多生成器、協作或分享分析；先完成 Issue #4 的一個公開 head、明確發布與撤回，並以實際 Worker/D1/R2 驗證。

## Scope, Discovery, and Evidence Discipline

### Read surface

- README、`package.json`、`schema.sql`、`src/store.js`、`src/worker.js`、`public/index.html`。
- 近期 commits、open/closed Issues、open PRs、branches、CI workflow、tests、既有 persona/audit 文件。
- Open PR #1（MCP v2/runner）及 PR #3（#2 歷史版本授權）只作協調背景，未修改、評論或重複處理。
- `Reese-max/autodev-ng` 未找到 minideck 的 active goal/Issue/PR/branch 記錄。

### Product discovery

| Dimension | Finding | Evidence |
|---|---|---|
| Product type | AI-assisted web presentation generator and player | CONFIRMED — README/source |
| Maturity | Functional prototype/product with generation, revision, versioning, sharing and export; parallel v2 work exists | CONFIRMED — code, tests, PR #1 |
| Target users | Students, educators, founders, consultants and small teams needing a fast shareable deck | LIKELY — flows and synthetic segmentation; no real market study |
| Core task | Prompt → choose variant → revise → share/play/export | CONFIRMED — source/UI |
| Core value | Fast, self-contained HTML output with lightweight Cloudflare operation | CONFIRMED/LIKELY |
| Largest weakness | Draft/current head is also anonymous public head | CONFIRMED — code/schema |
| CI | Workflow calls `npm ci` and `npm run check`; current audit baseline has no returned run/status receipt | CONFIRMED config; current execution UNKNOWN |
| Runtime | Production Worker, D1/R2 migration, caches, browser usability and real accessibility | UNKNOWN / NEEDS_RUNTIME_VERIFICATION |

### Confirmed code contract

- `projects.current_version` exists; no `published_version`, `published_at`, or unpublish state was found.
- `saveDeckVersion()` advances current head.
- Anonymous player resolves current head.
- UI copies one stable `/p/<projectId>` link.
- These facts support a static reproduction; they do not prove a specific live deployment or actual disclosure event.

## Competitive Intelligence — checked 2026-09-12

Official sources:
- Gamma publish/preview/disable: https://help.gamma.app/en/articles/11047576-can-i-publish-or-disable-my-gamma-site
- Pitch managed external links: https://help.pitch.com/en/articles/3748926-share-an-external-link-to-your-presentation
- Pitch expiring links, 2026-03-18: https://pitch.com/whats-new/share-expiring-links-and-sync-slide-edits
- Canva May 2026 release: https://www.canva.com/newsroom/news/whats-new-may-2026/
- Microsoft PowerPoint: https://www.microsoft.com/en-us/microsoft-365/powerpoint

### Capability matrix: user and product surface

| Product / substitute | Target user & value | Core / killer feature | Onboarding & UX | AI / automation | Collaboration & integrations | Mobile / distribution |
|---|---|---|---|---|---|---|
| MiniDeck | Individuals needing a fast HTML deck | Prompt-to-deck, three variants, version/revise/rollback, public player | Lightweight browser flow; public-state semantics unclear | MiniMax generation, image, revise, judge | REST/Worker surface; parallel MCP v2 PR; no confirmed live team workspace | Web link; HTML/PDF/PPTX export; native app absent |
| Gamma | Fast AI documents, decks and sites | Structured AI creation plus explicit preview/publish/disable | Polished SaaS; edits can remain unpublished | Strong AI authoring | Team/web publishing ecosystem | Responsive preview and web distribution |
| Pitch | Teams, sales and board decks | Collaborative deck workspace and managed external links | Workspace-oriented, richer controls | AI creation/sharing helpers | Analytics links, embed, passcode, expiry, download control | Web/apps and shared links |
| Canva | Broad creators and marketing teams | Large design/template ecosystem and many publish destinations | Easy template-led UX, but broad surface | Extensive AI design tools | Many apps and direct publishing targets | Strong web/mobile/distribution |
| PowerPoint | Professional and enterprise presentation users | Native PPTX fidelity and established editing model | Familiar but heavier desktop/web suite | Copilot/design aids | Microsoft 365 collaboration and file ecosystem | Desktop/web/mobile and file distribution |
| Manual HTML/PPTX | Technical users or strict offline workflows | Full control and no SaaS dependency | High effort | Script-dependent | File/Git/email | Portable files; weak live workflow |

### Capability matrix: quality, business and governance

| Product | Performance / reliability | Security / privacy | Pricing | Open / closed | Community / docs | Common strength | Common weakness |
|---|---|---|---|---|---|---|---|
| MiniDeck | Cloudflare architecture and tests exist; current runtime unknown | Project token for owner APIs; anonymous public head lacks draft boundary | Cloudflare/AI quota economics; exact unit costs UNKNOWN | Private repository / self-operated deployment | Repository docs/tests; small distribution | Lightweight, controllable HTML pipeline | Trust gap between save and publish |
| Gamma | Hosted service; publishing controls documented | Can disable public site; exact tenant controls depend on plan | Freemium/paid SaaS; exact current tiers not audited here | Closed SaaS | Mature help center | Fast AI-to-web publishing | Vendor/format dependence |
| Pitch | Hosted team product | Passcode, expiry, consent and disable options for external links | Premium link controls; exact plan totals not audited | Closed SaaS | Strong product/help docs | Collaboration and share lifecycle | Heavier workspace/analytics complexity |
| Canva | Large hosted ecosystem | Broad account and publishing governance; details plan-dependent | Freemium/paid SaaS | Closed SaaS | Very large community/templates/docs | Distribution breadth | Feature breadth and lock-in |
| PowerPoint | Mature native file workflow | Enterprise Microsoft controls; configuration-dependent | Free web and paid Microsoft 365 options | Closed | Very large ecosystem/docs | Fidelity, offline and familiarity | Heavier authoring; AI web output less direct |
| Manual HTML/PPTX | Reliability controlled by author | Can remain local/offline | Tool/time cost | Varies | Fragmented | Maximum control | Slow and hard to maintain |

### Gap classification

- **MUST MATCH:** explicit preview/publish/unpublish; public link must resolve an intentional version; clear public version/timestamp; legacy-safe migration; negative authorization/runtime tests.
- **SHOULD BE BETTER:** one low-concept public head using existing version primitives; self-contained export; transparent evidence receipt without account/workspace burden.
- **DIFFERENTIATOR:** lightweight Cloudflare deployment, self-contained HTML, version-aware generation/revision, and a narrow inspectable pipeline.
- **DO NOT COPY:** Pitch analytics/passcode/multiple named links in MVP; Canva marketplace and multi-channel publishing; Microsoft office suite breadth; Gamma site-builder breadth.

## Virtual Executive Board

| Role | Independent question / concern | Opportunity / priority |
|---|---|---|
| CEO | Can recipients trust a sent link while the author keeps working? | Do only three things: separate draft/public heads; verify deployed publication lifecycle; decide product boundary against MCP v2. Do not add distribution breadth first. |
| CPO | Does Save mean private work or public release? | Establish a single understandable Preview → Publish → Unpublish model. |
| CTO | Can schema migration and concurrent save/publish preserve a valid head? | Conditional/atomic update, immutable version reference, legacy migration fixture. |
| Staff / Principal Engineer | Can the solution reuse the existing player/version store? | Avoid a second renderer and avoid multi-link data model in MVP. |
| UX Lead | Can users answer “what is public?” at a glance? | Display draft vN, published vM, pending-change count and explicit verbs. |
| UX Researcher | Which mental model fails across novice and expert segments? | Run task-based tests after implementation; current personas are hypotheses only. |
| Growth Lead | Would link analytics improve sharing? | Minority opinion: later, only after share trust; no analytics now. |
| CFO / Business Analyst | Is this a contained investment? | One published pointer plus lifecycle controls has higher risk-adjusted value than a sharing SaaS. |
| Security / Privacy Lead | Can a private sentinel enter anonymous output without an explicit action? | Fail closed; negative deployed test; unpublish must make public retrieval impossible. |
| QA Lead | What exact state transitions can regress? | Cover migration, draft-after-publish, older-version publish, rollback, unpublish, delete and concurrency. |
| SRE Lead | What about cache and partial D1/R2 failure? | Version-stamped receipts and cache invalidation/rollback checks. |
| Accessibility Specialist | Will new publish controls expose name, state and focus? | Native controls, non-color status, keyboard and screen-reader runtime validation. |
| Customer Support Lead | Can support determine what a recipient saw? | Published version/timestamp receipt; simple support diagnostic. |

### Cross-review and minority opinion

Board consensus is to keep the stable public URL but make its target explicit and immutable until republished. Growth’s minority opinion favors named/expiring links because Pitch shows market demand; CFO, Staff Engineer and Red Team reject that scope for the first release. Accessibility also rejects claiming the current UI has a verified assistive-technology failure: the relevant publish UI does not yet exist, so acceptance requires future runtime testing rather than a fabricated result.

## 50 Synthetic Personas

Legend: B = 30-person regression baseline; R = 20-person rotating exploration. Outcomes are simulated. “未知” means static evidence cannot prove runtime behavior.

| ID | Cohort | Background | Goal | Expectation | Task | Journey | Friction | Success / Failure | Comment | Severity | Suggestion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 | B | 22／大學生；首次；Android；4G；中；無障礙需求未知 | 交課堂報告 | 分享後仍能改草稿 | 產生 v1 並寄連結，再修 v2 | 生成→分享 v1→存 v2→同學重載 | 無法知道 v2 已公開 | 失敗 | 「我只是在修下一版。」 | P1 | Save 與 Publish 分離並顯示公開版 |
| P02 | B | 31／新創 PM；熟練；Mac；穩定 Wi-Fi；高 | 投資人簡報 | 已寄版本保持固定 | 分享 v3 後改市場數據 | 分享→修改→投資人重載 | current head 靜默覆蓋 | 失敗 | 「對外版本必須可稽核。」 | P1 | published_version 與 receipt |
| P03 | B | 44／業務主管；Power User；Windows；公司網路；高 | 客戶提案 | 連結可控且內容穩定 | 寄出報價後準備新版 | 分享→複製專案內版本→儲存 | 舊收件者看到未核准價格 | 失敗 | 「不能讓草稿報價上線。」 | P1 | 明確 publish／unpublish |
| P04 | B | 38／教師；熟練；Chromebook；校園網路；中 | 發布教材 | 學生只看核准版本 | 先發講義再加答案 | 分享→加答案草稿→學生重載 | 答案提前曝光 | 失敗 | 「草稿不應等於公開。」 | P1 | 發布快照 |
| P05 | B | 19／學生；首次；iPhone；行動網路；低 | 快速做社團簡報 | 一鍵分享但可放心修稿 | 分享後修錯字 | 生成→分享→修字→預覽 | 預覽與公開狀態不清 | 失敗 | 「哪一版正在公開？」 | P1 | 狀態徽章與 preview |
| P06 | B | 52／公務員；首次；Windows；受限網路；低 | 會議簡報 | 操作詞義清楚 | 產生後分享、翌日續修 | 建立→分享→修訂 | Save 被誤認為只存私人草稿 | 失敗 | 「儲存不該等於發布。」 | P1 | 文案區分儲存／發布 |
| P07 | B | 29／設計師；Power User；Mac；高速網路；高 | 比較三個風格 | 未選版本不外流 | 分享 A 後試 B/C | 競賽→選 A→分享→保存 B | 穩定 URL 改指 B | 失敗 | 「試稿污染正式稿。」 | P1 | 公開 head 獨立 |
| P08 | B | 35／行銷；熟練；Windows；Wi-Fi；高 | 活動提案 | 可撤回公開內容 | 活動取消後下線 | 分享→取消→尋找停用 | 沒有 unpublish | 失敗 | 「只能刪專案太重。」 | P1 | 保留草稿的 unpublish |
| P09 | B | 26／求職者；首次；Android；4G；中 | 作品集簡報 | 送出後保持一致 | 投遞後為下一家公司改版 | 分享→複製內容→修改 | 原公司連結被改動 | 失敗 | 「同一 URL 不該跟著草稿跑。」 | P1 | published snapshot |
| P10 | B | 47／顧問；Power User；iPad；飯店 Wi-Fi；高 | 客戶工作坊 | 離線備援與穩定連結 | 分享後匯出 PDF 再修稿 | 分享→匯出→修訂 | Web 連結與匯出版本失配 | 部分失敗 | 「需要看見版本號。」 | P2 | 公開版號與匯出標記 |
| P11 | B | 33／研究員；熟練；Linux；校園網路；高 | 研討會簡報 | 引用版不可漂移 | 寄出審稿連結後改結論 | 分享→修訂→審稿者重載 | 證據版本不可追溯 | 失敗 | 「評審看到的不是我提交的版。」 | P1 | publish receipt |
| P12 | B | 41／法務；熟練；Windows；VPN；中 | 內部簡報 | 敏感草稿不匿名公開 | 發布刪節版後加入內部細節 | 分享→加入敏感字串→保存 | 匿名頁可能顯示草稿 | 失敗 | 「公開邊界要 fail closed。」 | P1 | 未發布內容不得進 public path |
| P13 | B | 28／自由工作者；熟練；Mac；家用網路；高 | 客戶提案 | 客戶只看批准版本 | 客戶看 v1 時準備 v2 | 分享→保存 v2→客戶重載 | 無版本鎖定 | 失敗 | 「我要先預覽再發布。」 | P1 | authenticated preview |
| P14 | B | 60／非營利主管；首次；iPad；4G；低 | 募款簡報 | 最少操作且不誤發 | 請助理分享後自己修字 | 開啟→修訂→關閉 | 不知道已改公共頁 | 失敗 | 「介面沒有警告。」 | P1 | 顯著公開狀態 |
| P15 | B | 24／社群編輯；熟練；Android；5G；中 | 活動簡報 | 可暫停連結 | 活動結束後下線 | 分享→活動結束→停用 | 只能刪除全部版本 | 失敗 | 「需要暫時下線。」 | P2 | unpublish 不刪資料 |
| P16 | B | 36／工程師；Power User；Linux；高速網路；高 | 技術簡報 | API 狀態具一致性 | publish v2 同時 save v3 | 並發 save／publish | 原子性未定義 | 未知 | 「race 必須有 receipt。」 | P1 | 條件更新與 concurrency test |
| P17 | B | 45／產品主管；熟練；Windows；公司網路；高 | 董事會簡報 | 正式版可識別 | 回退錯誤圖表 | 分享 v4→rollback v2 | rollback 直接成 current/public | 失敗 | 「回退也要再次發布。」 | P1 | rollback 不動 public head |
| P18 | B | 21／學生；首次；舊 Android；慢 3G；低 | 臨時報告 | 連結快速可靠 | 老師重載已分享頁 | 生成→分享→後台保存 | 低速端收到不同內容且無提示 | 失敗 | 「我無法判斷是不是快取。」 | P2 | 版本戳與 cache 規則 |
| P19 | B | 50／採購；收件者；Windows；公司代理；低 | 審核供應商簡報 | 審核標的固定 | 隔日重開同一連結 | 開啟→記錄→重開 | 內容變了卻無版本訊息 | 失敗 | 「審核紀錄失真。」 | P1 | 公開版號 |
| P20 | B | 32／記者；收件者；iPhone；4G；高 | 查看發布資料 | 公開內容有時間戳 | 收藏連結後重訪 | 開啟→引用→重訪 | current head 變化不可見 | 失敗 | 「引用需要發布時間。」 | P2 | published_at |
| P21 | B | 39／活動企劃；熟練；Mac；Wi-Fi；高 | 舞台簡報 | 演出中不被後台修改 | 現場播放時同事修下場版本 | 分享→播放→他人保存 | 正式畫面可能切換 | 失敗 | 「現場連結要固定。」 | P1 | immutable published head |
| P22 | B | 27／代理商 AE；熟練；Windows；4G；中 | 多客戶提案 | 一客戶一批准內容 | 從同專案改客戶名稱 | 分享 A→改 B→保存 | A 連結變 B 草稿 | 失敗 | 「這是跨客戶洩露風險。」 | P1 | 明確發布；MVP 不做多 link |
| P23 | B | 55／校長；收件者；iPad；校園網路；低 | 審核教師提案 | 看到提交版本 | 會議前再開連結 | 開啟→註記→重開 | 內容無聲改變 | 失敗 | 「決策依據不能漂移。」 | P1 | 發布快照 |
| P24 | B | 30／資料分析師；Power User；Linux；Wi-Fi；高 | 數據簡報 | 更新可控且可驗證 | 修正數字但尚未批准 | 分享→保存修正→等待核准 | 保存已對外 | 失敗 | 「缺少 approval boundary。」 | P1 | publish action |
| P25 | B | 42／客服主管；熟練；Windows；公司網路；中 | 內訓簡報 | 舊連結在核准前不變 | 新增未完成流程頁 | 分享→新增→保存 | 學員提前看到半成品 | 失敗 | 「客服內容會誤導。」 | P1 | draft isolation |
| P26 | B | 18／高中生；首次；Chromebook；校園網路；低 | 專題發表 | 簡單但安全 | 寄給老師後嘗試新主題 | 分享→換版型→保存 | 老師頁跟著變 | 失敗 | 「試樣式不等於交件。」 | P1 | preview then publish |
| P27 | B | 34／創業者；Power User；Mac；高速網路；高 | 募資 deck | 投資人版本有確定性 | 數次修訂 traction | 分享→持續修訂 | 無 changelog/public pointer | 失敗 | 「無法證明投資人看的版。」 | P1 | publish receipt |
| P28 | B | 48／醫療行政；熟練；Windows；封閉網路；中 | 內部政策簡報 | 敏感附件不意外公開 | 發布去識別版後補內部註記 | 分享→修稿→保存 | 匿名頁可能包含內部註記 | 失敗 | 「匿名連結必須明確控制。」 | P1 | fail-closed published_version |
| P29 | B | 37／UX 研究員；熟練；Mac；Wi-Fi；高 | 研究回放 | 參與者版本固定 | 訪談後補分析 | 分享→保存新分析 | 原參與者看到新內容 | 失敗 | 「研究邊界被破壞。」 | P1 | public snapshot |
| P30 | B | 65／董事；收件者；iPad；行動網路；低 | 閱讀董事會材料 | 每次打開一致 | 會前與會中開連結 | 開啟→註記→重開 | 內容改變無通知 | 失敗 | 「我需要版號和發布時間。」 | P1 | 顯示公開版號／時間 |
| P31 | R | 33／螢幕閱讀器使用者；熟練；Windows；Wi-Fi；高；盲 | 獨立發布簡報 | 狀態與操作可朗讀 | 鍵盤找預覽／發布狀態 | 生成→Tab 導覽→分享 | 現況沒有發布邊界；實際可及性未測 | 未知 | 「狀態需程式化呈現。」 | P1 | 語意化狀態＋真人 AT 驗證 |
| P32 | R | 29／鍵盤使用者；熟練；Linux；Wi-Fi；高；運動障礙 | 不靠滑鼠完成發布 | 焦點順序明確 | 保存後確認公開版 | 鍵盤操作→查狀態 | 未實作 publish UI；不可宣稱現況缺陷 | 未知 | 「驗收要含鍵盤流程。」 | P2 | publish UI 加鍵盤 regression |
| P33 | R | 46／低視力顧問；熟練；Windows；4G；中 | 確認公開與草稿差異 | 高對比非僅顏色 | 查看狀態徽章 | 開啟→放大 200%→發布 | 未有狀態 UI；需 runtime | 未知 | 「不要只靠綠／黃。」 | P2 | 文字＋圖示＋放大測試 |
| P34 | R | 25／色覺差異設計師；Power User；Mac；Wi-Fi；高 | 辨識版本狀態 | 不只顏色 | 比較 draft/published | 生成→保存→查狀態 | 未實作狀態 surface | 未知 | 「版號文字最可靠。」 | P2 | 非色彩提示 |
| P35 | R | 40／聽障講師；熟練；Windows；Wi-Fi；高 | 製作課程 deck | 核心流程不依聲音 | 分享再更新 | 生成→預覽→發布 | 發布邊界缺失；聽覺非根因 | 失敗 | 「問題是版本，不是媒體。」 | P1 | 保持文字化控制 |
| P36 | R | 57／認知負荷敏感使用者；首次；iPad；4G；低 | 安全分享 | 一個明確主動詞 | 看到 Save／Share | 生成→保存→分享 | 目前心智模型是 current=public | 失敗 | 「請說『發布 v3』。」 | P1 | 簡化為 Preview／Publish／Unpublish |
| P37 | R | 23／國際學生；首次；Android；慢網路；中；中文非母語 | 交雙語簡報 | 狀態詞一致 | 分享中文 deck 後修英文 | 生成→分享→改稿 | 公開狀態難推斷 | 失敗 | 「版本數字比長文好懂。」 | P2 | 短文案＋版本號 |
| P38 | R | 51／資安人員；Power User；Linux；公司 VPN；高 | 評估匿名表面 | 未發布內容不可匿名讀 | 植入 sentinel 後保存 | publish v1→save PRIVATE_DRAFT→匿名 GET | 靜態路徑顯示 current；未做 deployed probe | 靜態失敗 | 「要有負向安全測試。」 | P1 | sentinel runtime regression |
| P39 | R | 36／SRE；Power User；Mac；高延遲網路；高 | 驗證一致性 | save/publish 競爭可觀察 | 並發兩請求 | save v4 與 publish v3 並發 | 交易與 cache 行為未知 | 未知 | 「回傳 ETag/receipt。」 | P1 | 原子條件更新 |
| P40 | R | 28／QA；Power User；Windows；Wi-Fi；高 | 建立回歸矩陣 | 每一狀態可驗證 | 測 legacy migration | 舊 project→migration→匿名讀 | 相容政策尚未實作 | 未知 | 「不得意外下線舊分享。」 | P1 | legacy fixture |
| P41 | R | 43／資料保護官；熟練；Windows；公司網路；高 | 降低非預期揭露 | 撤回不等於刪除 | 發布後要求暫停 | 分享→unpublish→owner 繼續編輯 | 沒有 unpublish | 失敗 | 「撤回要保留工作。」 | P1 | unpublish 404/410 |
| P42 | R | 20／低儲存手機使用者；首次；Android；4G；低 | 用 Web 不裝 App | 快速查看正式版 | 重開連結 | 開啟→背景→重開 | 版本變化無標示 | 失敗 | 「請顯示『發布 v2』。」 | P2 | 輕量版本標籤 |
| P43 | R | 58／網路偶發斷線教師；熟練；Chromebook；不穩定 Wi-Fi；中 | 課堂穩定播放 | 斷線重連仍同版 | 播放中重連 | 開啟 v1→斷線→作者存 v2→重連 | 可能切到 v2 | 失敗 | 「重連不應換內容。」 | P1 | 固定 published head |
| P44 | R | 32／行動業務；熟練；iPhone；5G；高 | 旅途中更新草稿 | 手機存檔不誤發 | 分享後在手機修一頁 | 分享→修訂→保存 | 無 publish gate | 失敗 | 「手機誤觸風險更高。」 | P1 | 明確確認發布 |
| P45 | R | 49／品牌主管；熟練；Mac；公司網路；高 | 品牌審批 | 核准版才公開 | 設計師更新未核准配色 | share approved→save draft | 公開品牌可能改變 | 失敗 | 「品牌治理先於更多模板。」 | P1 | published snapshot |
| P46 | R | 27／開源維護者；Power User；Linux；Wi-Fi；高 | 自架簡報 | 可讀的資料契約 | 檢查 D1 migration | schema→save→player | 只有 current_version | 失敗 | 「最小 migration 很清楚。」 | P1 | 分離兩個 head |
| P47 | R | 54／財務主管；收件者；Windows；公司網路；中 | 核對數字 | 審核版本不可變 | 下載 PDF 後再看 web | PDF v2→web 重開 | 兩者可能不同且不顯示 | 部分失敗 | 「版號要跨輸出一致。」 | P2 | 公開版／匯出版 metadata |
| P48 | R | 35／客戶支援；熟練；Windows；Wi-Fi；中 | 處理『連結變了』工單 | 可解釋狀態 | 查專案 current/public | 收到工單→查 UI | 沒有 public head 可查 | 失敗 | 「客服無法回答哪版公開。」 | P1 | 可見狀態與 receipt |
| P49 | R | 30／成長 PM；Power User；Mac；Wi-Fi；高 | 提高分享轉換 | 想加 analytics | 建立多連結測試 | 檢視 Pitch 功能→規劃複製 | 會分散核心可靠性 | 被 Red Team 拒絕 | 「先修信任，再量成長。」 | P2 | DON'T: analytics before publish safety |
| P50 | R | 42／CFO；熟練；Windows；公司網路；高 | 控制開發成本 | 最小可驗收投資 | 比較單一 published head 與完整 share SaaS | 估算→排序→決策 | 完整 SaaS 過度工程 | 成功決策 | 「做一個 head，不做十種權限。」 | P1 | 限縮 MVP |

### Coverage summary

- Age 18–65; students, educators, founders, sales, consulting, design, research, public service, legal/privacy, QA/SRE, support and executive recipients.
- First-time, proficient and power users; author and recipient roles.
- Android, iPhone, iPad, Chromebook, Windows, macOS and Linux.
- Stable, restricted, high-latency and intermittent networks.
- Screen reader, keyboard-only, low vision, color vision and cognitive-load scenarios.
- The only Quality-Gate root finding is publication coupling. Accessibility, performance and live-security outcomes remain Runtime Pending unless source directly confirms the contract.

## Competitor Switching Test

Scenario: “Create a deck quickly, send it to a reviewer, continue editing privately, later deliberately update or withdraw the public version.”

| Choice | Personas | Synthetic preference share | Main simulated reason |
|---|---:|---:|---|
| MiniDeck | 14 | 28% | Lightweight HTML, fast generation, self-operated pipeline |
| Gamma | 12 | 24% | Clear preview/publish/disable lifecycle |
| PowerPoint | 9 | 18% | File fidelity, offline familiarity and enterprise workflow |
| Canva | 8 | 16% | Templates, mobile reach and distribution |
| Pitch | 5 | 10% | Managed external links and team workflow |
| Manual HTML/PPTX | 2 | 4% | Maximum offline/control needs |

These are simulated choices from 50 synthetic personas, not real preference data, market share or a forecast.

## Red Team

1. Persona bias: the scenario overweights already-shared decks; new-user generation quality could dominate real adoption. Keep preference figures non-empirical.
2. Competitor selection: Canva and PowerPoint are broad substitutes, not perfect direct competitors; do not infer feature parity.
3. Confirmation bias: prior Issue #4 primed this audit. Counter-check found the code contract unchanged, making update—not a new Issue—the correct mapping.
4. Over-engineering: multiple links, passwords, analytics, approvals and workspaces would enlarge state space before the basic head is safe.
5. Feature bloat: no marketplace, billing, native app, comments or additional AI layer.
6. Copying: import only the principle of intentional publication, not a competitor’s full sharing model.
7. Growth bias: trust precedes engagement analytics.
8. Simplification: one nullable `published_version` is the minimum useful abstraction.
9. Removal option: remove/disable the Share action until a safe published head exists if migration cannot be shipped safely.
10. Evidence limit: no live Worker, browser, D1 migration or assistive-technology session was performed; do not claim a production incident.

## Findings and Quality Gate

| Finding | Type | Priority | Impact | Strategic value | Gap | Risk reduction | Confidence | Effort | Gate | Mapping |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Anonymous player follows mutable current head; no explicit published head | FEATURE / RELIABILITY / PRIVACY / COMPETITIVE_GAP | P1 | 5/5 | 5/5 | 5/5 | 5/5 | High 0.96 | Medium | PASS: direct evidence, distinct fingerprint, actionable, accepted criteria, duplicate checked | UPDATED existing #4 |

Stable fingerprint: `Reese-max/minideck + public player/version lifecycle + save/revise/rollback after sharing + recipient sees mutable current head + no separate published_version`.

## Issue Mapping and Duplicate Check

- **UPDATED EXISTING ISSUE:** https://github.com/Reese-max/minideck/issues/4
- **NEW:** none.
- **REOPENED:** none.
- **RESEARCH:** none.
- Closed #5 is the known duplicate of #4; no reopen.
- Closed #2 covers anonymous historical-version API access, not publication lifecycle. Source fix exists; live verification is pending.
- Open PR #1 and PR #3 have independent scopes and branches; this audit did not write to them.
- Quality-Gate mapping: 1/1 PASS.

## Priority and Roadmap

### NOW — SIMPLIFY / FIX

1. Implement #4’s separate draft/public heads and legacy-compatible migration.
2. Add authenticated preview, explicit publish and unpublish; ensure save/revise/rollback never republish.
3. Run the complete Worker/D1/R2/browser regression matrix and capture receipts.

### NEXT — IMPROVE

- Verify #2’s historical-version authorization on the deployed Worker.
- Decide whether current MiniDeck or PR #1’s MCP v2 is the primary product surface before expanding either.
- Make version/timestamp visible across public view and exports where feasible.

### LATER — ADD only if evidence supports it

- Named or expiring links.
- Optional collaboration.
- Additional integrations.

### DON'T

- Analytics, passcodes, workspaces, billing, marketplace, native app, comments, another AI provider/judge, or a general office suite before publication safety.
- Do not treat Save or Rollback as Publish.
- Do not expose preview through a guessable permanent URL.

## Regression

| Tracking object | State | Evidence | Verdict |
|---|---|---|---|
| #4 publication boundary | Open | current source/schema still couples public and current heads | STILL REPRODUCIBLE / NEEDS_RUNTIME_VERIFICATION |
| #2 historical version authorization | Closed | authorization fix is present in source; open PR #3 is stale/parallel context | PARTIALLY VERIFIED BY STATIC EVIDENCE; NEEDS_DEPLOYED_RUNTIME_VERIFICATION |
| #5 duplicate publication issue | Closed duplicate | same fingerprint as #4 | DUPLICATE; no action |

Verified Fixed: 0. No Issue is marked VERIFIED FIXED because deployed acceptance and regression scenarios were not executed in this audit.

## Runtime Pending

- Legacy D1 migration with an existing shared project.
- Generate/save/revise/rollback while a published version exists.
- Publish old/current versions, unpublish, delete, and concurrent save/publish.
- Anonymous player cache invalidation and version receipt.
- Negative `PRIVATE_DRAFT` sentinel test.
- Mobile/WebView, high latency, keyboard, screen reader, zoom/reflow and non-color status validation.
- HTML/PDF/PPTX fidelity against the published version.
- Real user research and actual preference/adoption metrics.

## Rejected Findings

1. Create a new publication Issue — rejected as duplicate of open #4.
2. Reopen #5 — rejected because it is a confirmed duplicate.
3. Reopen #2 — rejected; distinct source fix exists and current live regression is not proven.
4. Add accounts/RBAC — rejected as disproportionate to one public-head problem.
5. Add link analytics — rejected; growth feature before trust.
6. Add multiple named/passcoded/expiring links now — rejected as feature bloat.
7. Add billing/subscriptions — rejected; no validated business need.
8. Add template marketplace — rejected; distribution breadth does not fix public-state trust.
9. Build a native app — rejected; browser workflow is adequate for current core task.
10. Add another AI provider/judge — rejected; unrelated to publication root cause.
11. Declare a live sensitive-data leak — rejected; no deployed incident was tested.
12. Declare current accessibility/performance defects — rejected without runtime/person testing.

## Decision Memo

- **What this product should become:** the simplest trustworthy path from prompt to a self-contained, deliberately published web presentation.
- **Who it should serve:** individuals and small teams that value speed, controllable hosting and portable HTML more than enterprise collaboration.
- **Why users would choose it:** lightweight flow, inspectable stack, version primitives and exports.
- **Why users choose competitors:** clearer publication controls, richer templates/collaboration, native PPTX fidelity, mobile reach and mature distribution.
- **Biggest competitive gaps:** explicit publication lifecycle, deployed reliability receipts and clear product boundary.
- **Potential moat:** compact Cloudflare-native generation/render/version pipeline with evidence-aware operations.
- **Top strategic/engineering/UX priorities:** #4 publication boundary; deployed contract verification; consolidate current/v2 direction and status language.
- **What NOT to build:** full SaaS sharing, marketplace, analytics, billing, native app or office-suite parity.
- **Features worth removing:** if safe publication cannot ship, temporarily remove/disable anonymous Share rather than expose mutable drafts.
- **Biggest risks:** accidental draft exposure, migration downtime, concurrent state races, parallel product surfaces and unverified deployment state.
- **Next experiments:** migration fixture; sentinel publish test; five task-based author sessions; recipient re-open test; compare one-head UX versus named links only after trust baseline.
- **Portfolio decision:** **INVEST / SIMPLIFY**.

## Portfolio CEO Review

MiniDeck overlaps with `ppt-studio`, the portfolio’s presentation skills, and the MCP v2 work in PR #1. The portfolio should not maintain three indistinguishable “AI presentation products.”

Suggested boundary:
1. **MiniDeck:** lightweight prompt-to-HTML authoring and trustworthy public player.
2. **ppt-studio / presentation skill:** high-fidelity, evidence/provenance-heavy production workflow.
3. **MCP v2:** integration surface only after one canonical deck/version/artifact contract is chosen.

Shared candidates: deck schema, render/export adapter, evidence receipt, public-state model, design tokens and provider gateway. Do not merge projects automatically; first decide ownership, migration and user promise.

Portfolio ranking for presentation-related scope:
1. MiniDeck — INVEST / SIMPLIFY; highest near-term user-value-to-effort if #4 closes.
2. ppt-studio / presentation workflow — MAINTAIN / DIFFERENTIATE around provenance and fidelity.
3. Parallel MCP v2 surface — PAUSE expansion pending canonical contract and product decision.

## Mandatory Verification

- Total Findings: 1
- New Issues Created: 0
- Updated Existing Issues: 1 — `Reese-max/minideck#4`
- Reopened Issues: 0
- Research Issues: 0
- Duplicate Avoided: 9 root/symptom groups
- Issue Write Blocked: 0
- SKIPPED_LOCKED / excluded active scopes: PR #1 branch `feature/presentation-studio-mcp-v2`; PR #3 branch `security/issue-2-require-token-on-deck-read`
- Rejected Findings: 12, with reasons above
- Verified Fixed: 0
- Priority distribution: P0 0 / P1 1 / P2 0 / P3 0 / STRATEGIC 0
- Highest Priority: #4
- Finding mapping: 1/1 — PASS
- Runtime verification: pending as listed above
