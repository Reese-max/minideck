import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertOwnerScopedIdempotency } from "./mcp-idempotency-owner-scope.mjs";

await import("./runner-wrangler-env.mjs");

const player = await readFile(new URL("../public/play.html", import.meta.url), "utf8");
const frame = player.match(/<iframe\b[^>]*id="play-deck"[^>]*>/i)?.[0] ?? "";

assert.match(frame, /\bsandbox="allow-same-origin"/i);
assert.doesNotMatch(frame, /allow-scripts/i);
console.log("PASS 分享播放器 iframe 禁止 deck 腳本執行");

// Issue #12: claims marked sensitive must fail closed before any render,
// artifact upload, or judge-router egress — not only at final approval.
const claimIntegrity = await import(
  "../workers/presentation-studio-runner/runner/claim-integrity.mjs"
).catch((error) =>
  assert.fail(`claim-integrity gate module must exist: ${error.message}`),
);
const {
  claimIntegrityCheck,
  claimTextMap,
  runJudgeIfIntegrityPasses,
  runWithClaimIntegrityGate,
  shouldRunJudges,
} = claimIntegrity;

const SENTINEL = "SENSITIVE_SENTINEL_ISSUE12_EGRESS";
const sensitiveInput = {
  jobId: "job-sensitive",
  spec: { slides: [{ id: "s1", claims: ["c-secret"] }] },
  sourceMap: {
    claims: [{ claimId: "c-secret", text: SENTINEL, sensitive: true }],
  },
};

assert.equal(claimIntegrityCheck(sensitiveInput).exitCode, 1);
assert.equal(claimTextMap(sensitiveInput.sourceMap).has("c-secret"), false);

let sideEffects = 0;
const blocked = await runWithClaimIntegrityGate(sensitiveInput, async () => {
  sideEffects += 1;
  return { status: "succeeded", html: SENTINEL, preview: SENTINEL };
});
assert.equal(sideEffects, 0);
assert.equal(blocked.status, "blocked");
assert.equal(blocked.error, "CLAIM_INTEGRITY_FAILED");
assert.equal(JSON.stringify(blocked).includes(SENTINEL), false);
console.log("PASS sensitive claim binding 在 render/upload 前 fail closed");

const unknownInput = {
  jobId: "job-unknown",
  spec: { slides: [{ id: "s1", claims: ["c-missing"] }] },
  sourceMap: { claims: [] },
};
assert.equal(claimIntegrityCheck(unknownInput).exitCode, 1);

const duplicateInput = {
  jobId: "job-dup",
  spec: { slides: [{ id: "s1", claims: ["c1"] }] },
  sourceMap: {
    claims: [
      { claimId: "c1", text: "public" },
      { claimId: "c1", text: SENTINEL, sensitive: true },
    ],
  },
};
assert.equal(claimIntegrityCheck(duplicateInput).exitCode, 1);
assert.equal(claimTextMap(duplicateInput.sourceMap).has("c1"), false);
console.log("PASS unknown/duplicate claim binding 一律 fail closed");

const unboundSensitiveInput = {
  jobId: "job-mixed",
  spec: { slides: [{ id: "s1", claims: ["c-pub"] }] },
  sourceMap: {
    claims: [
      { claimId: "c-pub", text: "public fact" },
      { claimId: "c-secret", text: SENTINEL, sensitive: true },
    ],
  },
};
assert.equal(claimIntegrityCheck(unboundSensitiveInput).exitCode, 0);
assert.equal(claimTextMap(unboundSensitiveInput.sourceMap).has("c-secret"), false);
assert.equal(claimTextMap(unboundSensitiveInput.sourceMap).get("c-pub"), "public fact");
const passed = await runWithClaimIntegrityGate(unboundSensitiveInput, async () => {
  sideEffects += 1;
  return { status: "succeeded" };
});
assert.equal(passed.status, "succeeded");
assert.equal(sideEffects, 1);
console.log("PASS 未綁定的 sensitive claim 保留但不物化，非敏感流程照常渲染");

const failedIntegrityResult = {
  status: "succeeded",
  version: { audit: { deterministic: { claimIntegrity: false } } },
};
assert.equal(shouldRunJudges(failedIntegrityResult), false);
let judgeCalls = 0;
const judged = await runJudgeIfIntegrityPasses(failedIntegrityResult, async () => {
  judgeCalls += 1;
  return { judged: true };
});
assert.equal(judged, null);
assert.equal(judgeCalls, 0);
const cleanIntegrityResult = {
  status: "succeeded",
  version: { audit: { deterministic: { claimIntegrity: true } } },
};
assert.equal(shouldRunJudges(cleanIntegrityResult), true);
await runJudgeIfIntegrityPasses(cleanIntegrityResult, async () => {
  judgeCalls += 1;
});
assert.equal(judgeCalls, 1);
console.log("PASS claim-integrity 未過時不得呼叫 judge router");
await assertOwnerScopedIdempotency();
console.log("PASS MCP 冪等紀錄依 OAuth owner 隔離，cached result 不跨租用戶重放");
