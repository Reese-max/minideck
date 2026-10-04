import assert from "node:assert/strict";
import { htmlToPlainText, parseJudgeJson } from "../src/judge-core.js";
import { runWithJudgeQuota } from "../src/judge-quota.js";

const lensResult = {
  typography: { score: 6, issues: ["縮短標題"] },
  dataviz: { score: 5, issues: ["補上單位"] },
  narrative: { score: 7, issues: [] },
  executive: { score: 8, issues: ["明確標示決策"] },
};

assert.deepEqual(parseJudgeJson(JSON.stringify(lensResult)), lensResult);
console.log("PASS judge 合併四鏡頭 JSON 驗證");

const plain = htmlToPlainText(
  `<style>不可見</style><section class="slide"><h1>標題</h1><script>不可見</script><p>${"甲".repeat(9000)}</p></section>`,
);
assert.equal([...plain].length, 8000);
assert.doesNotMatch(plain, /不可見/);
assert.match(plain, /^標題/);
console.log("PASS judge HTML 純文字化並截斷為 8000 字");

const exhaustedDb = {
  prepare(sql) {
    assert.match(sql, /INSERT INTO quotas/);
    return {
      bind() {
        return this;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
  },
};
let minimaxCalls = 0;
const reservation = await runWithJudgeQuota(
  exhaustedDb,
  "20260731",
  300,
  async () => {
    minimaxCalls += 1;
    return lensResult;
  },
);
assert.equal(reservation.accepted, false);
assert.equal(minimaxCalls, 0);
const endpointStatus = reservation.accepted ? 200 : 429;
assert.equal(endpointStatus, 429);
console.log("PASS judge 額度不足回 429 且 MiniMax 呼叫數為 0");

// 連帶執行 supplied specPatch 目標範圍回歸測試（同一 revision pipeline 主題）
await import("./presentation-revision-scope.mjs");
await import("./visual-coverage.mjs");
