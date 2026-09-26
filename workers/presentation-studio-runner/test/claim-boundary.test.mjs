import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkClaimBoundary, checkJudgeBoundary, redactSensitiveClaims } from "../runner/claim-boundary.mjs";
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
  assert.deepEqual(result, { status: "blocked", jobId: input.jobId, error: "CLAIM_BOUNDARY_BLOCKED" });
  assert.equal(child.stdout.includes(sentinel), false);
  assert.equal(child.stderr.includes(sentinel), false);
  assert.equal(result.artifacts, undefined);
});

test("the same sentinel renders only when its source claim is public", async () => {
  const calls = { prepare: 0, render: 0, upload: 0 };
  const pass = { exitCode: 0, output: "pass" };
  const hooks = {
    async prepare(input, workDir) {
      calls.prepare += 1;
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
      calls.upload += 1;
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
  const blocked = await execute(input, hooks);
  assert.deepEqual(blocked, { status: "blocked", jobId: input.jobId, error: "CLAIM_BOUNDARY_BLOCKED" });
  assert.deepEqual(calls, { prepare: 0, render: 0, upload: 0 });

  const publicInput = {
    ...input,
    sourceMap: { claims: sourceMap.claims.map((claim) => ({ ...claim, sensitive: false })) },
  };
  const rendered = await execute(publicInput, hooks);
  assert.equal(rendered.status, "succeeded");
  assert.equal(rendered.version.audit.deterministic.claimIntegrity, true);
  assert.deepEqual(calls, { prepare: 1, render: 1, upload: 1 });
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
