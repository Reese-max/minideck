# CI 執行途徑診斷與等效驗證（issue #6）

## 診斷結論（2026-09-16）

`ci.yml` 宣告的 gate 本身是有效的（checkout → Node 22 → `npm ci` → `npm run check`）。
失敗不是產品測試或 YAML 問題：連續多次 run 的 `check` job 取得 **runner=null、steps=0**
的 admission failure——job 從未取得 runner，即被平台拒絕排程。

證據（`gh run view`）：

| run | SHA | jobs.steps | runner | conclusion |
|---|---|---|---|---|
| 34094862999 | d302687 | 有 | 有 | success |
| 34221657466 | 3fb82550 | 0 | null | failure |
| 34666960074 | ed7ffd5f | 0 | null | failure |
| 34690640060 | 31f7131a | 0 | null | failure |

repo 為 **private**，GitHub-hosted runner 的 private 用量計入帳號付費分鐘數；
admission failure 的指紋（零步驟、runner_id=0/null）與帳號用量額度耗盡一致。
這不是程式碼缺陷，不能靠改 YAML 或測試「修好」。

## 等效驗證途徑（本機 gate）

在 GitHub runner 不可用期間，與 CI 完全相同的指令可在本機執行作為 gate：

```bash
npm ci
npm run check   # 即 CI 的 check job 本體
```

驗證證據要求：綁定 SHA、指令、時間與結果。本機證據證明產品路徑本身健康，
但不冒充「GitHub 自動觸發已修好」。

## 恢復自動執行的選項（owner 決策）

1. **帳號額度恢復後**：push 或對 main 手動 `workflow_dispatch` 即可原路執行
   （本 PR 已為 ci.yml 加上 `workflow_dispatch` 觸發）。
2. **self-hosted runner**：若預算限制是常態，可註冊 self-hosted runner 並把
   `runs-on` 改為 `[self-hosted, linux]`；self-hosted 不吃 GitHub 付費分鐘數。
   此變更需 owner 評估 runner 主機與安全隔離，不由本 PR 代行。
3. **不要**把 required check 改成 `continue-on-error` 或 no-op——那會讓 gate
   形同虛設，比暫時用本機驗證更糟。

## 本機驗證證據（本 PR）

- SHA：`git rev-parse HEAD`（見 PR 描述）
- `npm run check`：全部通過（security / token-client / storage-cleanup /
  frontend / judge-mock / persona-historical-scope / publish-boundary）
