# minideck

Cloudflare Worker 上的 MiniMax HTML 簡報生成器。瀏覽器 UI 的建立專案、生成、填圖、修訂、版本存取與分享，都有對等的 REST／`curl` 操作。

## 本機啟動

```powershell
.\dev.cmd
```

既有 Cloudflare D1 升級到 project token 權限欄位時，部署前先執行一次：

```powershell
npx wrangler d1 execute minideck --remote --file migrations/0001_project_access_token.sql
```

已具備 token 欄位的既有資料庫，升級本版前另執行一次發布狀態 migration（以下使用本機資料；正式環境由操作者核准後改為 `--remote`）：

```bash
npx wrangler d1 execute minideck --config ./wrangler.toml --local --file migrations/0002_published_version.sql
```

`0002` 會把每個既有專案當下存在的 `current_version > 0` 固定為 `published_version`，並記錄 migration 時間為 `published_at`，理由是保留已分享連結的內容。空專案或缺少版本資料的專案維持未發布。此為保留既有分享的唯一自動發布例外；之後生成、修訂、儲存及回退均只更新草稿。migration 與新 Worker 必須協調上線，避免舊 Worker 繼續依草稿提供公開內容。全新資料庫直接使用 `schema.sql`；不要對新 schema 或已完成遷移的資料庫重跑此 migration。

下列範例以 Git Bash／WSL 的 `curl` 語法表示：

```bash
BASE=http://127.0.0.1:8787
```

## 主要端點

| # | 方法與路徑 | 用途 |
|---:|---|---|
| 1 | `GET /api/quota` | 查詢 IP 與全站今日剩餘額度 |
| 2 | `POST /api/projects` | Turnstile 驗證後建立專案 |
| 3 | `POST /api/projects/:id/generate` | 生成簡報；回應為 SSE |
| 4 | `POST /api/projects/:id/image` | 生成或命中快取圖片 |
| 5 | `POST /api/projects/:id/revise` | 依指令修訂；回應為 SSE |
| 6 | `POST /api/projects/:id/deck` | 儲存完整 HTML 為新版本 |
| 7 | `GET /api/projects/:id` | 讀取狀態、版本與對話紀錄 |
| 8 | `DELETE /api/projects/:id` | 刪除專案 metadata、版本與專案額度 |
| 9 | `GET /p/:id` | 只播放已發布版本；未發布回 404 |
| 10 | `POST /api/projects/:id/publish` | 驗證並發布指定既有版本，需權杖 |
| 11 | `POST /api/projects/:id/unpublish` | 下線公開簡報、保留草稿與歷史，需權杖 |
| 12 | `GET /api/projects/:id/preview?version=N` | 使用公開播放器預覽指定版本，需權杖；省略版本則預覽最新草稿 |

### 1. 查額度

```bash
curl -sS "$BASE/api/quota"
```

### 2. 建立專案

正式環境的 `turnstileToken` 必須由 Turnstile widget 取得；本機測試設定可使用測試 token。

```bash
curl -sS "$BASE/api/projects" \
  -H 'content-type: application/json' \
  --data '{"brief":"為產品團隊做一份 5 頁 AI 導入簡報","turnstileToken":"<TURNSTILE_TOKEN>"}'

PROJECT_ID=<回應中的-id>
PROJECT_TOKEN=<回應中的-token>
```

`token` 只在建立專案時回傳；專案狀態、讀取原始簡報版本（`/api/projects/:id/deck`）與寫入操作皆必須以 `X-Project-Token` header 傳送。公開讀取資源僅限於 `/p/:id`（分享播放器）與 `/img/<hash8>.jpg`。

### 3. 生成簡報

`-N` 會停用 curl 緩衝，立即顯示 SSE。`style` 可省略，預設為 `consultant-dark`。

```bash
curl -N "$BASE/api/projects/$PROJECT_ID/generate" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"style":"consultant-dark"}'
```

### 4. 生成圖片

相同 `prompt` 與 `ar` 的 hash 命中 R2 時不呼叫 MiniMax，也不扣圖片額度。

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/image" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"prompt":"A clean enterprise AI workflow, editorial photography","ar":"16:9"}'
```

### 5. 修訂簡報

```bash
curl -N "$BASE/api/projects/$PROJECT_ID/revise" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"message":"第 2 頁標題更精簡，保留所有數據"}'
```

### 6. 儲存 HTML deck

請把完整 HTML JSON 放入 `deck.json`，格式為 `{"html":"<!doctype html>...","origin":"imagefill"}`；上限 2 MB，且至少三個 `<section class="slide">`。

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/deck" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data-binary @deck.json
```

### 7. 查專案狀態

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID" \
  -H "X-Project-Token: $PROJECT_TOKEN"
```

### 8. 取得匿名播放頁

須先明確發布一個既有版本，例如發布 v1：

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/publish" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"version":1}'
```

成功回傳 `{"published_version":1,"published_at":<Unix 毫秒時間>}`。只接受同專案、D1 版本紀錄及 R2 HTML 均存在，且通過 HTML 大小、至少三頁、結尾與圖片佔位符檢查的版本。發布不呼叫 MiniMax、不建立新版本、不扣額度。

```bash
curl -sS -o play.html -w '%{http_code}\n' "$BASE/p/$PROJECT_ID"
```

播放頁支援滑鼠點擊、方向鍵、`PageUp`／`PageDown`、`Home`／`End`，以及 `F` 全螢幕。

## 版本存取與安全隔離語意

### 1. 讀取簡報版本（需權杖）

原始簡報 HTML 包含製作過程中的草稿與潛在敏感資料，僅限擁有者存取，必須附帶 `X-Project-Token`：

```bash
# 讀取最新版
curl -sS "$BASE/api/projects/$PROJECT_ID/deck" \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  -o latest.html

# 讀取指定歷史版本（如 v1）
curl -sS "$BASE/api/projects/$PROJECT_ID/deck?version=1" \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  -o v1.html
```

若未附帶權杖或權杖無效，API 一律回傳 `403 Forbidden`（`{"error":"專案權杖無效"}`）。

### 2. 公開分享播放器語意

- **草稿與公開版本分離**：`current_version` 是最新草稿；`published_version` 是公開版本，可為 null。訪客瀏覽 `/p/:id` 只會看到已發布版本。建立專案、generate、revise、deck save 與 rollback 都不會自動發布。
- **版本隔離**：`/p/:id?version=N` 只有 N 等於已發布版本時可匿名播放；其他版本一律需 `X-Project-Token`，包含尚未發布的 current draft。原始 deck API 一律需權杖，包含已發布版本。播放器不包含權杖。
- **回退語意（Rollback）**：將歷史版本複製為新草稿（例如 v1 回退產生 v3）。公開連結仍呈現原先發布的 v2；要改為 v3，必須再次按發布或呼叫 publish。
- **發布與並發**：publish／unpublish 沿用 save／generate／revise／rollback／delete 的 D1 專案鎖；衝突回 `409`，請重新讀取狀態後重試。R2 完整上傳後才提交版本；發布在鎖內驗證 HTML，並用單一含同專案版本存在條件的 UPDATE 原子更新公開版本與時間。
- **下線與快取**：unpublish 清空公開版本與時間，`/p/:id` 回 404，指定版本的匿名請求回 403。所有播放器、預覽、狀態與 mutation 回應均為 `Cache-Control: no-store`。已下載或已開啟在觀眾瀏覽器的副本無法回收。
- **撤回與刪除（Revocation & Deletion）**：使用 `DELETE /api/projects/:id` 刪除專案後，公開播放頁與所有版本 API 立即失效（回傳 `404`），R2 物件同步清除。

### 3. 既有連結遷移與相容性決策

- **公開分享連結**：網址不變；migration 固定既有專案當下的版本。新草稿不再更新公開內容，作者必須明確發布。
- **直接 API 呼叫**：先前未受保護的 `GET /api/projects/:id/deck` 現在一律強制驗證 `X-Project-Token`。任何以腳本或 API 自動抓取簡報 HTML 的使用者，請於請求標頭中加入 `X-Project-Token`。

### 4. 回退版本

將既有版本複製為新的最新版（不呼叫 MiniMax、不扣額度）：

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/rollback" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"version":1}'
```

`POST /api/projects/:id/image` 回傳的 `/img/<hash8>.jpg` 可直接以 `GET` 下載，回應帶一年 immutable cache。

### 5. 刪除專案

刪除專案時需傳送 `X-Project-Token`；若 R2 deck 物件清理失敗，回應會是 503 且 `deleted:false`，D1 metadata 會保留以便重試。共用的 `images/<hash8>.jpg` 圖片快取不會隨單一專案刪除。

```bash
curl -sS -X DELETE "$BASE/api/projects/$PROJECT_ID" \
  -H "X-Project-Token: $PROJECT_TOKEN"
```

### 6. 預覽與下線

UI「發布與分享」會顯示草稿 head、公開 head 與未發布變更數。「發布前預覽」與版本歷史的「預覽」都透過帶權杖的 preview API 載入同一公開播放器；預覽不會改變發布狀態，也不產生可永久公開的預覽網址。「發布 vN」與「下線」需要明確點擊；複製公開連結只在專案已發布時可用。

```bash
# 以實際公開 renderer 預覽草稿 v2；權杖僅放 header，不放網址。
curl -sS "$BASE/api/projects/$PROJECT_ID/preview?version=2" \
  -H "X-Project-Token: $PROJECT_TOKEN" -o preview.html

# 下線（重複呼叫亦安全），保留專案與所有版本。
curl -sS "$BASE/api/projects/$PROJECT_ID/unpublish" \
  -H "X-Project-Token: $PROJECT_TOKEN" -X POST
```

下線 receipt 為 `{"published_version":null,"published_at":null}`；owner 仍可預覽、讀取與重新發布任一有效版本。`GET /api/projects/:id` 額外回傳 `current_version`、`published_version` 與 `published_at`。

## Issue #4 驗收與本機測試

```bash
npm ci
npm run check
npx wrangler deploy --config ./wrangler.toml --dry-run --outdir .wrangler/issue-4-build
```

`npm run check` 保留全部既有測試，另執行 12 項實際本機 workerd／D1／R2 測試與 3 項 UI 狀態回歸。Miniflare 使用已宣告 Wrangler 的鎖定依賴；fixture 與 provider 回應全部在本機隔離，不使用正式資料、Secrets 或付費 AI。

| Issue #4 驗收條件 | 實作與驗證 |
|---|---|
| Schema 分離、legacy 相容政策 | `schema.sql`／`0002`；既有分享固定、空專案與缺少版本維持未發布 |
| 所有草稿寫入不影響公開內容 | 沿用 `saveDeckVersion`；save、generate、revise、rollback 的 runtime 回歸 |
| 匿名只讀公開版本 | `/p/:id` 固定 published head；current draft、歷史版本與 URL token 均驗證拒絕 |
| 發布權杖、同專案版本與 HTML 驗證 | 無效權杖、其他專案、缺少／已刪版本與 R2、無效／過大 HTML 測試 |
| 原子切換與 receipt | 專案鎖＋條件式 UPDATE；version／timestamp receipt 與並發 save/publish 測試 |
| Owner preview 重用 renderer | preview 與公開 HTML 相等測試；current／歷史草稿授權測試 |
| 下線保留版本且不再匿名提供 HTML | 重複下線、匿名 URL／舊快取條件標頭、owner 讀取及重新發布測試 |
| UI 分辨兩個 head 與變更數 | UI 回歸驗證顯示、明確發布／下線，以及新專案生成失敗時清除舊狀態 |
| Rollback 後須再次發布 | v1→v3 草稿不影響已發布 v2；重新發布才切換 |
| DELETE 撤銷並清理全部 deck | 與 publish 競爭、公開／預覽／API 404、D1 versions 與 R2 prefix 清空測試 |
| Legacy／舊版發布／並發／預覽競爭 | runtime 遷移與完整生命週期、UI 過期預覽回應回歸 |

此處驗證的是本機 Worker runtime 與綁定；遠端 Preview、CI 與正式環境 migration／部署須由 driver 另行執行。本專案未設定獨立 lint、typecheck、coverage ratchet、CRAP 或 mutation gate；打包以 Wrangler dry-run 驗證。

## SSE 事件格式

`generate` 與 `revise` 使用相同格式，每個事件以空白行結束：

```text
event: token
data: {"text":"<增量文字>"}

event: done
data: {"version":2,"deckPath":"/api/projects/<id>/deck?version=2"}

event: error
data: {"message":"<繁中文案>","refunded":true}
```

HTTP 層錯誤一律為 `{"error":"<繁中文案>"}`，常見狀態碼為 403、404、413、429 與 502。

## 額度規則

| scope | 上限 | 週期／扣除時機 |
|---|---:|---|
| `ip:<ipHash>:projects` | 3 | UTC 每日；建立專案時 |
| `global:projects` | 50 | UTC 每日；建立專案時 |
| `global:text` | 300 | UTC 每日；generate／revise 成功預留，符合重試條件的失敗會退還 |
| `global:images` | 250 | UTC 每日；新圖片生成前預留，失敗時退還 |
| `proj:<id>:revises` | 6 | 專案終身；revise |
| `proj:<id>:images` | 15 | 專案終身；新圖片生成前預留，失敗時退還 |
| `proj:<id>:retries` | 2 | 專案終身；符合退額條件的文字失敗 |

建立專案同時檢查 IP 與全站額度；第二項失敗時會退還第一項。圖片 hash 快取命中不扣任何額度。所有上限由 `wrangler.toml` 的 `LIMIT_*` 變數控制。

## 擴充風格 preset

先在 `prompts/styles/` 加入一個 `.md`（只描述配色、字體氣質、版面密度與圖表風格）。由於 Worker 採靜態打包，接著在 `src/minimax.js` 匯入該檔並加入 `STYLE_PROMPTS`；若要在網頁選取，再於 `public/index.html` 的 `#style-select` 加入同名選項。重新啟動 Worker 後即可由 `generate` 的 `style` 欄位使用。

PPTX 與 HTML-to-image 前端函式庫已固定存放於 `public/vendor/`，不從 CDN 載入，也不會進入 Worker runtime 依賴。
