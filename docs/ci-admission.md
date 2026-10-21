# CI 執行途徑診斷與等效驗證（issue #6）

## 2026-09-30 重新查詢結果

依 issue #6 驗收要求重新查當時 Actions 狀態（`gh api repos/Reese-max/minideck/actions/runs`、
`.../actions/runs/<id>/jobs`、`.../check-runs/<job_id>/annotations`）：

| run | 觸發 | SHA | check job | runner_id | steps | conclusion |
|---|---|---|---|---|---|---|
| 34094862999 | push | d302687 | 完成 | 有 | 有 | success |
| 34221657466 | push | 3fb82550 | admission failure | 0 | 0 | failure |
| 34666960074 | push | ed7ffd5f | admission failure | 0 | 0 | failure |
| 36684881306 | pull_request | 3fa884f5 | admission failure | 0 | 0 | failure |

最新 run（36684881306，2026-09-30）的 check-run annotation 與歷史 run
34221657466 完全相同：

> The job was not started because an Actions budget is preventing further use.

## 診斷結論

- `ci.yml` 宣告的 gate 本身有效（checkout → Node 22 → `npm ci` → `npm run check`），
  run 34094862999 曾在 SHA `d302687` 完整執行全部步驟並成功（該 run 的 head SHA 即 d302687）。
- 失敗是 **runner admission failure**：job 從未取得 runner（`runner_id: 0`、`steps: []`），
  check-run annotation 明指帳號 **Actions budget** 阻擋。
- repo 為 private，GitHub-hosted runner 的 private 用量計入帳號付費分鐘數；
  額度耗盡時所有 workflow（CI、Deploy 等）一律 admission 拒絕——目前仍是此狀態。
- 這不是 YAML、依賴或產品程式缺陷；**不能靠改程式修復**。
- 查不到的部分記為未知：帳號額度何時恢復、owner 是否已決策——本文件不猜測。

## 等效驗證途徑（目前可用的 gate）

在 GitHub runner 不可用期間，與 CI `check` job 完全相同的指令在本機執行：

```bash
npm ci
npm run check   # = npm test，依序跑 test/ 下六個檢查檔
```

依 issue #6 更正後的證據規則：綁定 SHA、指令、時間、環境、結果的本機／隔離測試
可證明其實際執行的產品路徑，**但不能單獨證明 GitHub 自動觸發已修好**。

### 本次綁定證據

| 欄位 | 值 |
|---|---|
| base SHA | `31f7131ae24af9d89287000e8048750e598686a1`（origin/main） |
| 指令 | `npm test`（`npm run check` 本體） |
| 環境 | Node.js v22.19.0，Linux x86_64 |
| 時間 | 2026-09-30 |
| base 結果 | **exit 1** — `test/persona-historical-scope.mjs` 的 D1 mock 在 `checkAndIncrement` 拋 `ERR_SQLITE_ERROR` column index out of range（errcode 25） |
| 修正後結果 | **exit 0** — 六個檢查檔全部通過 |

### 本次修正的本地 gate 缺陷

產品 SQL 全面使用 D1 語法的編號佔位符（`?1`/`?2`/`?3`），真實 D1 接受；
但 `persona-historical-scope.mjs` 的 node:sqlite mock 把 bind 參數直接攤開給
`stmt.run()`，Node 22.19 的 node:sqlite 不再對 `?N` 做位置綁定（SQLITE_RANGE）。
mock 改為把 `?N` 正規化為 `?`，並依序號把每次出現（含亂序與重複）映射回
`bound[N-1]`，語意與 D1 一致；同檔新增綁定契約回歸。產品程式碼未改動。

## 恢復 GitHub 自動執行的選項（owner 決策，不在本 PR 代行）

1. **恢復帳號 Actions 額度／付款方式**：自動觸發路徑原樣恢復，`ci.yml` 不需改動。
2. **`workflow_dispatch` 手動觸發**：供額度恢復後免 push 補跑同一條 gate；
   屬外加觸發設定，需 owner 決策（open PR #7 已含同型變更），且 GitHub-hosted
   仍受額度限制——無法繞過 budget block。
3. **self-hosted runner**：private repo 的 self-hosted 不吃 GitHub 付費分鐘數；
   `runs-on` 需改為 `[self-hosted, linux]`，runner 主機與安全隔離由 owner 評估。
4. **禁止事項**：不得把 required check 改成 `continue-on-error`、no-op 步驟，
   也不得自行停用自動路徑——那會讓 gate 形同虛設。

## 證據界線（分開報告）

- **自動觸發／CI 執行**：仍被帳號 budget 阻擋，待 owner 處理；本變更不宣稱已修復。
- **產品測試**：本地 `npm run check` 於修正後 exit 0（上表綁定證據）；
  僅證明本機實際執行的產品路徑健康。
- **部署／provider／UI**：本變更未觸及 wrangler 部署、Turnstile、MiniMax、
  R2/D1 實際 provider，無相關證據，不宣稱覆蓋。
# Current status — 2026-10-08

The admission failures recorded below are historical. Current Actions execute
real steps again: Runner follow-up `cf27e8351e782ffe4756c52212c607f482b63042`
passed run 37744692252, including checks, image build and Dashi render/export.
The SQLite placeholder repair is retained for the Node 22 harness. This does
not prove Preview deployment or authentication; the v2 foundation remains a
draft and shared cloud bindings are not an isolated test environment.
