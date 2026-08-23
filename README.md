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

下列範例以 Git Bash／WSL 的 `curl` 語法表示：

```bash
BASE=http://127.0.0.1:8787
```

## 九個主要端點

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
| 9 | `GET /p/:id` | 讀取最新版匿名播放頁 |

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

`token` 只在建立專案時回傳；專案狀態與寫入操作都要以 `X-Project-Token` header 傳送。`/api/projects/:id/deck`、`/img/<hash8>.jpg` 與 `/p/:id` 是公開讀取資源。

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

```bash
curl -sS -o play.html -w '%{http_code}\n' "$BASE/p/$PROJECT_ID"
```

播放頁支援滑鼠點擊、方向鍵、`PageUp`／`PageDown`、`Home`／`End`，以及 `F` 全螢幕。

## 增補版本操作

讀最新版或指定版本 HTML：

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/deck" -o latest.html
curl -sS "$BASE/api/projects/$PROJECT_ID/deck?version=1" -o v1.html
```

將既有版本複製為新的最新版（不呼叫 MiniMax、不扣額度）：

```bash
curl -sS "$BASE/api/projects/$PROJECT_ID/rollback" \
  -H 'content-type: application/json' \
  -H "X-Project-Token: $PROJECT_TOKEN" \
  --data '{"version":1}'
```

`POST /api/projects/:id/image` 回傳的 `/img/<hash8>.jpg` 可直接以 `GET` 下載，回應帶一年 immutable cache。

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
