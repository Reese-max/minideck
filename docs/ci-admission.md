# CI 執行途徑診斷與等效驗證（issue #6）

## 2026-10-17 狀態查核

重新以 Actions runs／jobs API 查核，以下兩筆 run 的第 2 次執行已於
2026-10-05 成功完成；原 budget admission 阻擋已不再適用於這兩次執行：

| 路徑 | run（attempt 2） | head SHA | runner_id | conclusion |
|---|---|---|---|---|
| default-branch push（main） | [34690640060](https://github.com/Reese-max/minideck/actions/runs/34690640060/attempts/2) | `31f7131ae24af9d89287000e8048750e598686a1` | 1000015244 | success |
| PR #20 原始 head | [36695770634](https://github.com/Reese-max/minideck/actions/runs/36695770634/attempts/2) | `1eb700f5b28fd0493d5bc0bfbaf1da737fd79766` | 1000015082 | success |

兩者皆實際執行 checkout、setup-node、`npm ci`、`npm run check` 並成功，
不是零步驟 admission failure。這些紀錄只驗證表列 SHA，不能當成後續
審查修正提交的 CI 證據，也不涵蓋部署、provider 或 UI 驗收。

## 2026-09-30 歷史查詢結果

依 issue #6 驗收要求重新查當時 Actions 狀態（`gh api repos/Reese-max/minideck/actions/runs`、
`.../actions/runs/<id>/jobs`、`.../check-runs/<job_id>/annotations`）：

| run | 觸發 | SHA | check job | runner_id | steps | conclusion |
|---|---|---|---|---|---|---|
| 34094862999 | push | d302687 | 完成 | 有 | 有 | success |
| 34221657466 | push | 3fb82550 | admission failure | 0 | 0 | failure |
| 34666960074 | push | ed7ffd5f | admission failure | 0 | 0 | failure |
| 36684881306 | pull_request | 3fa884f5 | admission failure | 0 | 0 | failure |

當時最新 run（36684881306，2026-09-30）的 check-run annotation 與歷史 run
34221657466 完全相同：

> The job was not started because an Actions budget is preventing further use.

## 歷史診斷結論

- `ci.yml` 宣告的 gate 本身有效（checkout → Node 22 → `npm ci` → `npm run check`），
  run 34094862999 曾在 SHA `d302687` 完整執行全部步驟並成功（該 run 的 head SHA 即 d302687）。
- 失敗是 **runner admission failure**：job 從未取得 runner（`runner_id: 0`、`steps: []`），
  check-run annotation 明指帳號 **Actions budget** 阻擋。
- repo 為 private，GitHub-hosted runner 的 private 用量計入帳號付費分鐘數；
  當時觀察到 CI、Deploy 等 run 都在 admission 階段被拒絕。
- 這不是 YAML、依賴或產品程式缺陷；**不能靠改程式修復**。
- 當時查不到帳號額度恢復時間與 owner 決策；後續只能確認上表 run 已成功，
  無法由此推測帳單或設定如何改變。

## 等效本機驗證途徑

與 CI `check` job 完全相同的指令可在本機執行：

```bash
npm ci
npm run check   # = npm test，目前依序跑 test/ 下七個檢查檔
```

依 issue #6 更正後的證據規則：綁定 SHA、指令、時間、環境、結果的本機／隔離測試
可證明其實際執行的產品路徑，**但不能單獨證明 GitHub 自動觸發已修好**。

### 2026-09-30 本機綁定證據（原 PR）

| 欄位 | 值 |
|---|---|
| base SHA | `31f7131ae24af9d89287000e8048750e598686a1`（origin/main） |
| candidate SHA | `1eb700f5b28fd0493d5bc0bfbaf1da737fd79766`（原 PR 修正版） |
| 指令 | `npm test`（`npm run check` 本體） |
| 環境 | Node.js v22.19.0，Linux x86_64 |
| 時間 | 2026-09-30 |
| base 結果 | **exit 1** — `test/persona-historical-scope.mjs` 的 D1 mock 在 `checkAndIncrement` 拋 `ERR_SQLITE_ERROR` column index out of range（errcode 25） |
| 修正後結果 | **exit 0** — 六個檢查檔全部通過 |

### 本機 gate 缺陷與審查修正

產品 SQL 同時使用匿名佔位符 `?` 與編號佔位符（`?1`/`?2`/`?3`），真實 D1 接受；
但 `persona-historical-scope.mjs` 的 node:sqlite mock 把 bind 參數直接攤開給
`stmt.run()`，Node 22.19 的 node:sqlite 對 `?N` 需要名稱綁定（位置綁定會 SQLITE_RANGE）。
原 PR 把 `?N` 正規化為 `?`，依序號把每次出現（含亂序與重複）映射回
`bound[N-1]`。2026-10-17 審查補強為只轉換真正的 SQL 參數，保留字串、
識別字與註解；混用匿名參數時依 SQLite 的最大索引規則配置，並拒絕錯誤
參數數量。綁定契約回歸涵蓋 `first`／`all`／`run`；產品程式碼未改動。

## 歷史恢復選項（同類故障再次發生時由 owner 評估）

1. **恢復帳號 Actions 額度／付款方式**：自動觸發路徑原樣恢復，`ci.yml` 不需改動。
2. **`workflow_dispatch` 手動觸發**：供額度恢復後免 push 補跑同一條 gate；
   屬外加觸發設定，需 owner 決策（PR #7 含同型變更），且 GitHub-hosted
   仍受額度限制——無法繞過 budget block。
3. **self-hosted runner**：private repo 的 self-hosted 不吃 GitHub 付費分鐘數；
   `runs-on` 需改為 `[self-hosted, linux]`，runner 主機與安全隔離由 owner 評估。
4. **禁止事項**：不得把 required check 改成 `continue-on-error`、no-op 步驟，
   也不得自行停用自動路徑——那會讓 gate 形同虛設。

## 證據界線（分開報告）

- **自動觸發／CI 執行**：已確認表列 main push 與原 PR head run 的實際 check 步驟成功；
  後續審查修正仍須自己的 CI 證據。
- **產品測試**：原 PR 本機 `npm run check` exit 0 的證據綁定於上表 candidate SHA；
  本機結果只證明該次實際執行的產品路徑。
- **部署／provider／UI**：本變更未觸及 wrangler 部署、Turnstile、MiniMax、
  R2/D1 實際 provider，無相關證據，不宣稱覆蓋。
