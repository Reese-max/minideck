# Deployment Rules

1. 不得直接修改 production 分支。所有變更必須透過 Pull Request。
2. 修改前先執行現有測試（若有）。
3. 修改後必須執行 `npm run check`（若專案有此指令）。
4. 不得讀取、輸出或寫入正式 Secrets 值。
5. 不得刪除 D1 database、KV namespace、R2 bucket、DNS record 或 Worker/Pages project。
6. 資料庫結構變更必須使用 migrations（不得直接 ALTER TABLE）。
7. 不得在同一版本中移除舊欄位並切換新程式。
8. Preview 部署通過驗證後，才可建議合併。
9. Production 部署必須由使用者核准。
10. Commit message 使用 Conventional Commits 格式。

## Branch Strategy

- `feature/*` — 功能開發分支
- `main` — 整合/測試環境
- `production` — 正式環境（觸發 Cloudflare 正式部署）

## Testing

- PR 前必須確保 lint + typecheck + test + build 全部通過。
- 不得跳過或刪除現有測試。新增功能應附帶對應測試。

## Security

- Secrets 只能透過 `wrangler secret put` 或 Cloudflare Dashboard 設定。
- 不得在程式碼、commit、PR description 或 log 中暴露 secret 值。
- 第三方 API Key 只記錄名稱，不記錄值。
