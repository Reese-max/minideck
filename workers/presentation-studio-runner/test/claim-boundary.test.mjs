import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkClaimBoundary,
  checkJudgeBoundary,
  redactSensitiveClaims,
  runWithClaimBoundary,
  runWithJudgeBoundary,
} from "../runner/claim-boundary.mjs";
import { claimTextMap } from "../runner/claim-integrity.mjs";
import { execute } from "../runner/execute-job.mjs";

const sentinel = "CONFIDENTIAL_CLAIM_SENTINEL_DO_NOT_EGRESS";
const sourceMap = {
  claims: [
    { claimId: "public-1", text: "A verified public fact", sensitive: false },
    { claimId: "private-1", text: sentinel, sensitive: true },
  ],
};
const safeSpec = { slides: [{ id: "s1", claims: ["public-1"], keyMessage: "A verified public fact" }] };

test("public claim binding remains renderable and sensitive source text is redacted", () => {
  assert.equal(checkClaimBoundary(safeSpec, sourceMap).pass, true);
  assert.equal(JSON.stringify(redactSensitiveClaims(sourceMap)).includes(sentinel), false);
  assert.equal(claimTextMap(sourceMap).has("private-1"), false);
  assert.equal(claimTextMap(sourceMap).has("public-1"), true);
});

test("sensitive, unknown, and alternate claim bindings are blocked", () => {
  for (const slide of [
    { id: "s1", claims: ["private-1"] },
    { id: "s1", claims: ["public-1"], sourceClaimIds: ["private-1"] },
    { id: "s1", claims: ["unknown-1"] },
    { id: "s1", claims: "public-1" },
  ]) {
    const outcome = checkClaimBoundary({ slides: [slide] }, sourceMap);
    assert.deepEqual(outcome, { pass: false, reason: "CLAIM_BOUNDARY_BLOCKED" });
  }
});

test("literal sensitive text cannot bypass a public claim binding", () => {
  const spec = { slides: [{ id: "s1", claims: ["public-1"], keyMessage: sentinel }] };
  assert.equal(checkClaimBoundary(spec, sourceMap).pass, false);
  assert.equal(checkClaimBoundary(safeSpec, sourceMap, [{ instruction: sentinel }]).pass, false);
  assert.equal(checkClaimBoundary(safeSpec, sourceMap, [{ claims: [{ claimId: "private-1", text: sentinel }] }]).pass, false);
  assert.equal(checkClaimBoundary(safeSpec, sourceMap, [{ [sentinel]: "provider-visible object key" }]).pass, false);

  const duplicatedSourceMap = {
    claims: [
      { claimId: "public-1", text: `A verified public fact ${sentinel}`, sensitive: false },
      sourceMap.claims[1],
    ],
  };
  assert.equal(checkClaimBoundary(safeSpec, duplicatedSourceMap).pass, false);
});

test("Judges require a passing deterministic claim gate and two safe specs", () => {
  const input = { spec: safeSpec, sourceMap, profile: {}, payload: {} };
  const result = {
    status: "succeeded",
    version: { spec: safeSpec, audit: { deterministic: { claimIntegrity: true } } },
  };
  assert.equal(checkJudgeBoundary(input, result).pass, true);
  assert.equal(checkJudgeBoundary(input, {
    ...result,
    version: { ...result.version, audit: { deterministic: { claimIntegrity: false } } },
  }).pass, false);
  assert.equal(checkJudgeBoundary(input, {
    ...result,
    version: { ...result.version, spec: { slides: [{ id: "s1", claims: ["private-1"] }] } },
  }).pass, false);
  assert.equal(checkJudgeBoundary({ ...input, spec: { slides: [{ id: "s1", claims: ["missing"] }] } }, result).pass, false);
});

test("runner blocks sensitive input before Dashi or artifact upload", () => {
  const input = {
    jobId: "boundary-fixture",
    type: "render",
    sourceMap,
    spec: { slides: [{ id: "s1", claims: ["private-1"] }] },
    profile: {},
    payload: {},
    title: "Fixture",
    brief: "Fixture",
  };
  const runner = new URL("../runner/execute-job.mjs", import.meta.url);
  const child = spawnSync(process.execPath, [fileURLToPath(runner)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, DASHI_ROOT: "unavailable-dashi-fixture", DASHI_STORAGE_HOST: "invalid.invalid" },
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, { status: "blocked", jobId: input.jobId, error: "CLAIM_INTEGRITY_FAILED" });
  assert.equal(child.stdout.includes(sentinel), false);
  assert.equal(child.stderr.includes(sentinel), false);
  assert.equal(result.artifacts, undefined);
});

test("sensitive claims produce zero egress calls and a public control remains renderable", async () => {
  const calls = { provider: 0, render: 0, preview: 0, artifactUpload: 0, judgeRouter: 0 };
  const pass = { exitCode: 0, output: "pass" };
  const hooks = {
    async prepare(input, workDir) {
      const goalPath = join(workDir, "goal.json");
      await writeFile(goalPath, JSON.stringify(input.spec));
      return { goalPath, mode: "fixture" };
    },
    async render(goalPath, workDir) {
      calls.render += 1;
      const deckDir = join(workDir, "deck");
      await mkdir(deckDir);
      await writeFile(join(deckDir, "index.html"), await readFile(goalPath));
      return {
        deckDir,
        quality: {},
        commands: { goalSpec: pass, safeProps: pass, render: pass, swiss: pass, copy: pass, variantQuality: pass },
      };
    },
    async collect() {
      calls.preview += 1;
      calls.artifactUpload += 1;
      return [];
    },
  };
  const input = {
    jobId: "same-sentinel-fixture",
    type: "render",
    sourceMap,
    spec: { slides: [{ id: "s1", claims: ["private-1"], keyMessage: sentinel }] },
    profile: {},
    payload: {},
    title: "Fixture",
    brief: "Fixture",
  };
  const invalidJudgeResult = {
    status: "succeeded",
    version: { spec: input.spec, audit: { deterministic: { claimIntegrity: false } } },
  };
  const providerBlocked = await runWithClaimBoundary(input, async () => {
    calls.provider += 1;
    return "provider called";
  });
  const judgeBlocked = await runWithJudgeBoundary(input, invalidJudgeResult, async () => {
    calls.judgeRouter += 1;
    return "judge called";
  });
  assert.equal(providerBlocked.allowed, false);
  assert.equal(judgeBlocked.allowed, false);
  const blocked = await execute(input, hooks);
  assert.deepEqual(blocked, { status: "blocked", jobId: input.jobId, error: "CLAIM_INTEGRITY_FAILED" });
  assert.equal(JSON.stringify(blocked).includes(sentinel), false);
  assert.deepEqual(calls, { provider: 0, render: 0, preview: 0, artifactUpload: 0, judgeRouter: 0 });

  const publicInput = {
    ...input,
    sourceMap: { claims: sourceMap.claims.map((claim) => ({ ...claim, sensitive: false })) },
  };
  const rendered = await execute(publicInput, hooks);
  assert.equal(rendered.status, "succeeded");
  assert.equal(rendered.version.audit.deterministic.claimIntegrity, true);
  const publicJudgeResult = {
    status: "succeeded",
    version: { spec: publicInput.spec, audit: { deterministic: { claimIntegrity: true } } },
  };
  const providerAllowed = await runWithClaimBoundary(publicInput, async () => {
    calls.provider += 1;
    return "provider called";
  });
  const judgeAllowed = await runWithJudgeBoundary(publicInput, publicJudgeResult, async () => {
    calls.judgeRouter += 1;
    return "judge called";
  });
  assert.equal(providerAllowed.allowed, true);
  assert.equal(judgeAllowed.allowed, true);
  assert.deepEqual(calls, { provider: 1, render: 1, preview: 1, artifactUpload: 1, judgeRouter: 1 });
  assert.equal(JSON.stringify(rendered).includes(sentinel), true);

  const beforeDuplicate = { ...calls };
  const duplicatedSecretInput = {
    ...publicInput,
    spec: safeSpec,
    sourceMap: {
      claims: [
        { claimId: "public-1", text: `A verified public fact ${sentinel}`, sensitive: false },
        ...sourceMap.claims.filter((claim) => claim.claimId === "private-1"),
      ],
    },
  };
  const duplicateProvider = await runWithClaimBoundary(duplicatedSecretInput, async () => {
    calls.provider += 1;
    return "provider called";
  });
  const duplicateJudge = await runWithJudgeBoundary(duplicatedSecretInput, publicJudgeResult, async () => {
    calls.judgeRouter += 1;
    return "judge called";
  });
  const duplicateBlocked = await execute(duplicatedSecretInput, hooks);
  assert.equal(duplicateProvider.allowed, false);
  assert.equal(duplicateJudge.allowed, false);
  assert.equal(duplicateBlocked.status, "blocked");
  assert.equal(JSON.stringify(duplicateBlocked).includes(sentinel), false);
  assert.deepEqual(calls, beforeDuplicate);
});

test("unbound sensitive source text is absent from the Dashi source map", async () => {
  let inspected = false;
  const input = {
    jobId: "redacted-source-fixture",
    type: "render",
    sourceMap,
    spec: safeSpec,
    profile: {},
    payload: {},
    title: "Fixture",
    brief: "Fixture",
  };
  await execute(input, {
    async prepare(_input, workDir) {
      const copied = await readFile(join(workDir, "source-map.json"), "utf8");
      assert.equal(copied.includes(sentinel), false);
      inspected = true;
      return { blocked: "FIXTURE_DONE" };
    },
  });
  assert.equal(inspected, true);
});


test("renderer output containing a sensitive sentinel is blocked before artifact collection", async () => {
  let renderCalls = 0;
  let collectCalls = 0;
  const input = {
    jobId: "renderer-sensitive-leak",
    type: "render",
    sourceMap,
    spec: safeSpec,
    profile: {},
    payload: {},
    title: "Fixture",
    brief: "Fixture",
  };
  const blocked = await execute(input, {
    async prepare(_input, workDir) {
      const goalPath = join(workDir, "goal.json");
      await writeFile(goalPath, JSON.stringify(safeSpec));
      return { goalPath, mode: "fixture" };
    },
    async render(_goalPath, workDir) {
      renderCalls += 1;
      const deckDir = join(workDir, "deck");
      await mkdir(deckDir);
      await writeFile(join(deckDir, "index.html"), "<html>" + sentinel + "</html>");
      return { deckDir, quality: {}, commands: {} };
    },
    async collect() {
      collectCalls += 1;
      return [];
    },
  });

  assert.deepEqual(blocked, {
    status: "blocked",
    jobId: input.jobId,
    error: "CLAIM_BOUNDARY_BLOCKED",
  });
  assert.equal(JSON.stringify(blocked).includes(sentinel), false);
  assert.equal(renderCalls, 1);
  assert.equal(collectCalls, 0);
});
