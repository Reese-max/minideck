import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { planVisualCoverage } from "../runner/visual-coverage.mjs";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) specifier += ".ts";
  return nextResolve(specifier, context);
} });
const { runJudges } = await import("../src/judges.ts");
hooks.deregister();

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
function fixture(count = 21, blocker = false) {
  const ids = Array.from({ length: count }, (_, i) => `s${i + 1}`);
  const spec = { slides: ids.map((id) => ({ id, keyMessage: `Synthetic ${id}` })) };
  const coverage = planVisualCoverage(ids, ids.map((_, i) => `slide-${i + 1}.png`));
  const prefix = "presentation-studio/projects/runtime-project/jobs/runtime-job/attempt-1/";
  const calls = { router: [], gets: [], puts: [] };
  const artifacts = coverage.sheets.map((sheet) => ({ kind: sheet.kind, r2Key: `${prefix}${sheet.kind}.png` }));
  const input = { projectId: "runtime-project", jobId: "runtime-job", attemptCount: 1, spec, sourceMap: { claims: [] }, profile: {}, payload: {} };
  const result = { status: "succeeded", jobId: input.jobId, artifacts, version: { spec,
    audit: { deterministic: { claimIntegrity: true, render: true }, visualCoverage: coverage } } };
  const env = { CF_AI_ROUTER_URL: "https://synthetic-judge.invalid/", CF_AI_ROUTER_API_KEY: "synthetic-test-value",
    BUCKET: { async get(key) { calls.gets.push(key); return { size: png.length, async arrayBuffer() { return png.slice().buffer; } }; },
      async put(key) { calls.puts.push(key); } } };
  const fetchDouble = async (url, options) => {
    assert.equal(String(url), env.CF_AI_ROUTER_URL, "no real provider transport permitted");
    const body = JSON.parse(options.body); calls.router.push(body);
    const content = body.messages[1].content;
    const text = Array.isArray(content) ? content[0].text : content;
    const match = text.match(/covered slide ids (\[[^\n]*\]):/);
    const covered = body.model === "free-vision" ? match ? JSON.parse(match[1]) : ids.slice(0,20) : [];
    const blocked = blocker && covered.includes("s21");
    const report = { score: blocked ? 55 : 95, everySlideScoreMin: blocked ? 55 : 95, pass: !blocked,
      issues: blocked ? [{ severity: "blocker", message: "Synthetic slide 21 is unreadable" }] : [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(report) } }] });
  };
  return { ids, input, result, env, calls, fetchDouble };
}
async function judge(f) {
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchDouble;
  try { return await runJudges(f.env, f.input, f.result); } finally { globalThis.fetch = original; }
}

test("actual Judge dispatch covers 21 slides and propagates the second-sheet blocker", async () => {
  const f = fixture(21, true); const result = await judge(f); const audit = result.version.audit;
  assert.equal(audit.judgesComplete, true); assert.equal(audit.allHardGatesPass, false);
  assert.equal(audit.everySlideScoreMin, 55); assert.equal(audit.blockerCount, 1);
  assert.equal(audit.visualJudgePass, false); assert.equal(audit.factualJudgePass, true);
  assert.deepEqual(audit.visualCoverage.evaluatedSlideIds, f.ids);
  const visual = f.calls.router.filter((call) => call.model === "free-vision");
  assert.equal(visual.length, 2); assert.equal(f.calls.router.length, 3);
  assert.match(visual[1].messages[1].content[0].text, /covered slide ids \["s21"\]/);
  assert.equal(f.calls.gets.length, 2);
});

test("actual Judge rejects the uncovered 21st slide before preview or provider calls", async () => {
  const f = fixture(); f.result.version.audit.visualCoverage = planVisualCoverage(f.ids, f.ids.slice(0, 20).map((_, i) => `slide-${i + 1}.png`));
  const result = await judge(f); assert.equal(result.version.audit.blockedReason, "VISUAL_COVERAGE_INCOMPLETE");
  assert.equal(result.version.audit.judgesComplete, false); assert.equal(result.version.audit.allHardGatesPass, false);
  assert.equal(f.calls.router.length, 0); assert.equal(f.calls.gets.length, 0);
});

test("claimed full coverage with only one preview cannot call the Judge", async () => {
  const f = fixture(); f.result.artifacts.pop(); const result = await judge(f);
  assert.equal(result.version.audit.blockedReason, "VISUAL_PREVIEW_SHEETS_MISSING");
  assert.equal(f.calls.router.length, 0); assert.equal(f.calls.gets.length, 0);
});

test("actual Judge rejects a substituted job object before any provider call", async () => {
  const f = fixture(); f.result.artifacts[1].r2Key = "another-job/preview-2.png";
  const result = await judge(f); assert.equal(result.version.audit.blockedReason, "PREVIEW_ARTIFACT_UNAVAILABLE");
  assert.equal(f.calls.router.length, 0);
});

test("the reconciled sensitive boundary blocks before image retrieval and Judge dispatch", async () => {
  const f = fixture(); f.input.sourceMap.claims = [{ claimId: "secret", text: "SYNTHETIC_PRIVATE_RUNTIME_SENTINEL", sensitive: true }];
  f.input.spec.slides[0].claims = ["secret"];
  const result = await judge(f); assert.equal(result.status, "blocked");
  assert.equal(f.calls.router.length, 0); assert.equal(f.calls.gets.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_RUNTIME_SENTINEL/);
});

test("20-slide control dispatches one visual and one factual Judge and remains usable", async () => {
  const f = fixture(20); const result = await judge(f);
  assert.equal(result.version.audit.allHardGatesPass, true); assert.equal(result.version.audit.judgesComplete, true);
  assert.deepEqual(result.version.audit.visualCoverage.evaluatedSlideIds, f.ids);
  assert.equal(f.calls.router.length, 2); assert.equal(f.calls.gets.length, 1);
});

test("actual Judge rejects a previous attempt's preview before retrieving bytes", async () => {
  for (const legacyUnfenced of [false, true]) {
    const f = fixture(); f.input.attemptCount = 2;
    if (legacyUnfenced) f.result.artifacts.forEach((artifact) => { artifact.r2Key = artifact.r2Key.replace("attempt-1/", ""); });
    const result = await judge(f);
    assert.equal(result.version.audit.blockedReason, "PREVIEW_ARTIFACT_UNAVAILABLE");
    assert.equal(result.version.audit.judgesComplete, false);
    assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.router.length, 0);
  }
});

test("actual Judge requires a valid claim attempt before retrieving previews", async () => {
  for (const attemptCount of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.input.attemptCount = attemptCount;
    const result = await judge(f);
    assert.equal(result.version.audit.blockedReason, "PREVIEW_ARTIFACT_UNAVAILABLE");
    assert.equal(result.version.audit.judgesComplete, false);
    assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.router.length, 0);
  }
});
