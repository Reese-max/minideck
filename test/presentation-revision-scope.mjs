import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyRevisionPatch,
  applySlideSpecPatch,
  normalizeRevisionPatch,
} from "../workers/presentation-studio-runner/src/revision-patch.mjs";

// 與 planner 產生的 patch 共用同一組 deterministic validation（#13）：
// caller-supplied specPatch 不得修改 requested slideIds 以外的既有 slide，
// 而完成版本的 changedSlides 必須來自實際套用的 patch，不能只信 caller 宣告。

const SPEC = {
  schemaVersion: 1,
  slides: [
    { id: "s1", role: "intro", keyMessage: "original-one", claims: ["c1"] },
    { id: "s2", role: "body", keyMessage: "original-two", claims: ["c2"] },
    { id: "s3", role: "close", keyMessage: "original-three" },
  ],
};

const SOURCE_MAP = {
  claims: [
    { claimId: "c1", sourceId: "src1", text: "verified public claim", sensitive: false },
    { claimId: "c2", sourceId: "src2", text: "sensitive claim", sensitive: true },
  ],
};

function makeInput(overrides = {}) {
  return {
    jobId: "job-13",
    projectId: "project-13",
    type: "revision",
    spec: JSON.parse(JSON.stringify(SPEC)),
    sourceMap: JSON.parse(JSON.stringify(SOURCE_MAP)),
    sources: [],
    payload: { specPatch: { slides: [{ id: "s1", keyMessage: "placeholder" }] } },
    parentVersionId: "v1",
    changedSlides: ["s1"],
    ...overrides,
  };
}

// 1. slideIds=["s1"] 但 supplied patch 改 s2 → 必須在 render 前被拒絕
{
  const input = makeInput();
  const hostilePatch = { slides: [{ id: "s2", keyMessage: "tampered" }] };
  assert.equal(normalizeRevisionPatch(hostilePatch, input), null);
  assert.equal(applyRevisionPatch(input, hostilePatch), null);
  console.log("PASS supplied specPatch 修改範圍外既有 slide 被拒絕 (slideIds=[s1], patch→s2)");
}

// 2. supplied patch 混雜合法與越界 slide 也不得部分套用
{
  const input = makeInput();
  const mixedPatch = {
    slides: [
      { id: "s1", keyMessage: "fixed" },
      { id: "s2", keyMessage: "tampered" },
    ],
  };
  assert.equal(applyRevisionPatch(input, mixedPatch), null);
  console.log("PASS supplied specPatch 不得部分套用（s1 合法 + s2 越界 → 整個拒絕）");
}

// 3. 合法只改 s1 的 supplied patch 正常套用，changedSlides 由 patch 推導
{
  const input = makeInput();
  const legalPatch = { slides: [{ id: "s1", keyMessage: "revised-one" }] };
  const result = applyRevisionPatch(input, legalPatch);
  assert.ok(result);
  const s1 = result.spec.slides.find((slide) => slide.id === "s1");
  const s2 = result.spec.slides.find((slide) => slide.id === "s2");
  assert.equal(s1.keyMessage, "revised-one");
  assert.equal(s2.keyMessage, "original-two");
  assert.deepEqual(result.changedSlides, ["s1"]);
  assert.equal(result.payload.specPatch, null);
  console.log("PASS 合法 targeted supplied patch 只套用 s1，changedSlides=[s1] 與實際 diff 一致");
}

// 4. caller 宣告 [s1,s2] 但 patch 只改 s2 → changedSlides 反映實際套用而非宣告
{
  const input = makeInput({ changedSlides: ["s1", "s2"] });
  const patch = { slides: [{ id: "s2", keyMessage: "revised-two" }] };
  const result = applyRevisionPatch(input, patch);
  assert.ok(result);
  assert.deepEqual(result.changedSlides, ["s2"]);
  console.log("PASS changedSlides 由實際套用 patch 推導，不回声 caller 宣告的較大範圍");
}

// 5. 未宣告 slideIds（空集合）時不限縮範圍，但 receipt 仍如實列出套用 slide
{
  const input = makeInput({ changedSlides: [] });
  const patch = { slides: [{ id: "s2", keyMessage: "revised-two" }] };
  const result = applyRevisionPatch(input, patch);
  assert.ok(result);
  assert.deepEqual(result.changedSlides, ["s2"]);
  console.log("PASS 無 requested scope 時 patch 可套用，receipt 列出實際 changedSlides=[s2]");
}

// 6. 與 planner 相同的 known-slide 規則：不存在的 slide id 被拒
{
  const input = makeInput();
  assert.equal(
    applyRevisionPatch(input, { slides: [{ id: "s9", keyMessage: "ghost" }] }),
    null,
  );
  console.log("PASS supplied specPatch 參考不存在 slide 被拒絕");
}

// 7. 與 planner 相同的 allowed-fields 規則：非允許欄位被拒
{
  const input = makeInput();
  assert.equal(
    applyRevisionPatch(input, { slides: [{ id: "s1", variants: [{}] }] }),
    null,
  );
  console.log("PASS supplied specPatch 含非允許欄位被拒絕");
}

// 8. 與 planner 相同的 claim 規則：敏感/未驗證 claim id 被拒，合法 claim 通過
{
  const input = makeInput();
  assert.equal(
    applyRevisionPatch(input, { slides: [{ id: "s1", claims: ["c2"] }] }),
    null,
  );
  assert.ok(applyRevisionPatch(input, { slides: [{ id: "s1", claims: ["c1"] }] }));
  console.log("PASS supplied specPatch 引用敏感 claim 被拒，驗證過的 claim 可套用");
}

// 9. 重複 slide id 的 patch 被拒（與 planner normalizePatch 行為一致）
{
  const input = makeInput();
  assert.equal(
    applyRevisionPatch(input, {
      slides: [
        { id: "s1", keyMessage: "a" },
        { id: "s1", keyMessage: "b" },
      ],
    }),
    null,
  );
  console.log("PASS supplied specPatch 重複 slide id 被拒絕");
}

// 10. 原始 input 不被突變（reject 路徑不殘留半套用狀態）
{
  const input = makeInput();
  const hostilePatch = { slides: [{ id: "s2", keyMessage: "tampered" }] };
  applyRevisionPatch(input, hostilePatch);
  assert.equal(input.spec.slides[1].keyMessage, "original-two");
  assert.deepEqual(input.changedSlides, ["s1"]);
  console.log("PASS 拒絕路徑不突變原始 spec 或 changedSlides");
}

// 11. 空 slides patch 與非物件 patch 走同一條 deterministic 拒絕路徑
{
  const input = makeInput();
  assert.equal(applyRevisionPatch(input, { slides: [] }), null);
  assert.equal(applyRevisionPatch(input, { notSlides: true }), null);
  console.log("PASS 空或非 slides 形狀的 supplied patch 被拒絕");
}

// 12. claims 與 sourceClaimIds 各自獨立驗證：不能借合法 claims 夾帶敏感 sourceClaimIds
{
  const input = makeInput();
  const smuggled = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c2"] }] };
  assert.equal(applyRevisionPatch(input, smuggled), null);
  const clean = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c1"] }] };
  assert.ok(applyRevisionPatch(input, clean));
  console.log("PASS sourceClaimIds 獨立驗證，合法 claims 不得夾帶敏感 sourceClaimIds");
}

// 13. applySlideSpecPatch 保持既有 merge 語義（只覆寫 patch 內欄位）
{
  const merged = applySlideSpecPatch(
    JSON.parse(JSON.stringify(SPEC)),
    { slides: [{ id: "s1", keyMessage: "merged" }] },
  );
  assert.equal(merged.slides[0].keyMessage, "merged");
  assert.equal(merged.slides[0].role, "intro");
  console.log("PASS slide merge 僅覆寫 patch 提供的欄位");
}

// 14. 容器端第二道防線：execute-job 不得套用未經 Workflow 驗證的殘留 specPatch
{
  const runnerPath = fileURLToPath(
    new URL("../workers/presentation-studio-runner/runner/execute-job.mjs", import.meta.url),
  );
  const runExecuteJob = (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").pop()));
        } catch {
          reject(new Error(`execute-job produced no JSON result: ${err || out}`));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });

  const bypassAttempt = await runExecuteJob({
    jobId: "job-13-container-guard",
    type: "revision",
    spec: { schemaVersion: 1, slides: [{ id: "s1", keyMessage: "orig" }] },
    sourceMap: { claims: [] },
    sources: [],
    payload: { specPatch: { slides: [{ id: "s1", keyMessage: "tampered" }] } },
    changedSlides: ["s1"],
  });
  assert.equal(bypassAttempt.status, "blocked");
  assert.equal(bypassAttempt.error, "SPEC_PATCH_REQUIRES_WORKFLOW_VALIDATION");

  const consumedPatch = await runExecuteJob({
    jobId: "job-13-container-ok",
    type: "revision",
    spec: { schemaVersion: 1, slides: [{ id: "s1", keyMessage: "revised" }] },
    sourceMap: { claims: [] },
    sources: [],
    payload: { specPatch: null },
    changedSlides: ["s1"],
  });
  assert.notEqual(consumedPatch.error, "SPEC_PATCH_REQUIRES_WORKFLOW_VALIDATION");
  console.log("PASS 容器端拒絕未經 Workflow 驗證的殘留 specPatch（已消費的 patch 不受影響）");
}

console.log("ALL PRESENTATION REVISION SCOPE ACCEPTANCE CRITERIA PASSED");
