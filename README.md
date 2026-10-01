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

既有 D1 升級到草稿／發佈分離模型時，再執行一次：

```powershell
npx wrangler d1 execute minideck --remote --file migrations/0002_published_head.sql
```

此 migration 會把 `current_version > 0` 的既有專案承接為 `published_version`（`publish_origin = 'migration'`），既有分享連結不中斷；`current_version = 0` 的專案維持未發佈。`0002` 未執行前，`GET /api/quota` 會直接回報缺少此 migration（`D1 schema 尚未初始化：請先套用 migrations/0002_published_head.sql`），請在部署前完成；本機 `npm run dev` 需對本機 D1 執行同一份檔案。

本機測試（`npm test`）需要 Node.js ≥ 24：測試以 `node:sqlite` 模擬 D1，Node 22 的 `node:sqlite` 不支援位置參數繫結到 `?N` 形式欄位，會拋 `column index out of range`。`.nvmrc` 與 `package.json` 的 `engines` 同時鎖定此下限，CI 亦以 `node-version-file: .nvmrc` 對齊。

`npm test` 只跑無需網路與 Worker 的測試（`test/security.mjs`、`token-client.mjs`、`storage-cleanup.mjs`、`frontend.mjs`、`judge-mock.mjs`、`persona-historical-scope.mjs`、`publish-lifecycle.mjs`）。`test/integration.mjs` 與 `test/smoke-e2e.mjs` 需要 `npm run dev`（wrangler dev）與真實 D1／R2，屬人工驗證用途，不在 CI 測試鏈中。

下列範例以 Git Bash／WSL 的 `curl` 語法表示：

```bash
BASE=http://127.0.0.1:8787
```

## 十一個主要端點

| # | 方法與路徑 | 用途 |
|---:|---|---|
| 1 | `GET /api/quota` | 查詢 IP 與全站今日剩餘額度 |
| 2 | `POST /api/projects` | Turnstile 驗證後建立專案 |
| 3 | `POST /api/projects/:id/generate` | 生成簡報；回應為 SSE |
| 4 | `POST /api/projects/:id/image` | 生成或命中快取圖片 |
| 5 | `POST /api/projects/:id/revise` | 依指令修訂；回應為 SSE |
| 6 | `POST /api/projects/:id/deck` | 儲存完整 HTML 為新版本 |
| 7 | `GET /api/projects/:id` | 讀取狀態、版本、草稿／發佈 head 與對話紀錄 |
| 8 | `DELETE /api/projects/:id` | 刪除專案 metadata、版本與專案額度 |
| 9 | `POST /api/projects/:id/publish` | 將既有版本發佈為公開 head |
| 10 | `POST /api/projects/:id/unpublish` | 下線公開分享，保留專案與草稿 |
| 11 | `GET /p/:id` | 讀取已發佈版匿名播放頁 |

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

### 9. 發佈公開版本

把同專案中已存在的版本切換為公開 head；不呼叫 MiniMax、不扣額度。回應帶發佈 receipt：

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/publish" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"version":2}'

# → {"published":true,"version":2,"published_at":1759190400000}
```

版本不存在、或該版本的 R2 物件已不存在時回 `404`（公開 head 不會指向打不開的簡報，publish 也不會為此簽發 receipt）；權杖無效回 `403`。

### 10. 下線公開分享

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/unpublish" \
  -H "X-Project-Token: $PROJECT_TOKEN" -X POST

# → {"published":false}
```

下線後 `/p/:id` 回 `404`，但專案、草稿與歷史版本全部保留。

### 11. 取得匿名播放頁

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

- **發佈版本公開**：訪客瀏覽 `/p/:id` 時，播放器只呈現 `published_version`。`generate`／`revise`／`deck save`／`rollback` 只推進草稿 head（`current_version`），不會改變公開內容；唯有 `POST /api/projects/:id/publish` 才切換公開 head。播放頁不包含、亦不洩露 `X-Project-Token`。
- **草稿與歷史版本隔離**：訪客在播放頁附帶 `?version=N` 讀取非發佈版本時回傳 `403`；專案不存在、未發佈或公開 head 已失效時回傳 `404`，且所有匿名 `404` 內容完全相同（`{"error":"找不到可播放的簡報"}`），無法藉回應差異反推專案或草稿是否存在。
- **Owner 預覽**：帶 `X-Project-Token` 的 `/p/:id?version=N` 重用同一條公開 render path 預覽任一版本，預覽不產生新的公開網址。未發佈專案的分享連結對 owner 也回 `404`（該連結確實沒有公開內容），preview 請走 `?version=N`。
- **回退語意（Rollback）**：將既有歷史版本複製為新的草稿版（例如 v1 回退產生 v3），公開連結不受影響；要公開回退版需再次 `publish`。
- **撤回與刪除（Revocation & Deletion）**：`unpublish` 只下線公開存取；`DELETE /api/projects/:id` 刪除專案後，公開播放頁與所有版本 API 立即失效（回傳 `404`），R2 物件同步清除。

### 3. 既有連結遷移與相容性決策

- **公開分享連結**：`migrations/0002_published_head.sql` 將既有專案的 `current_version` 承接為 `published_version`（`publish_origin = 'migration'`），升級前已發出的 `/p/:id` 連結持續有效，外部受眾無需更新網址。
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
