import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  claimIntegrityCheck,
  claimTextMap,
  runJudgeIfIntegrityPasses,
  runWithClaimIntegrityGate,
} from "../runner/claim-integrity.mjs";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("declares a Workflow and a Dashi Container binding", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.equal(config.name, "presentation-studio-runner");
  assert.equal(config.workflows[0].binding, "PRESENTATION_WORKFLOW");
  assert.equal(config.workflows[0].class_name, "PresentationWorkflow");
  assert.equal(config.containers[0].class_name, "DashiContainer");
  assert.equal(config.durable_objects.bindings[0].name, "DASHI_CONTAINER");
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["DashiContainer"]);
});

test("uses a fixed Dashi command and rejects shell execution", async () => {
  const source = await read("runner/execute-job.mjs");
  const container = await read("src/container.ts");
  assert.match(source, /spawn\(file, args, \{/);
  assert.match(source, /shell:\s*false/);
  assert.match(container, /\["node", "\/app\/runner\/execute-job\.mjs"\]/);
  assert.doesNotMatch(source, /exec\(.*input\.(command|cmd|shell)/s);
  assert.doesNotMatch(source, /eval\s*\(/);
  const normalizer = await read("runner/deck-normalizer.mjs");
  assert.match(normalizer, /data-presentation-studio-decoration-overflow-policy/);
  assert.match(normalizer, /data-bespoke-theme-source/);
  assert.match(normalizer, /data-editable-skip/);
  assert.match(normalizer, /overflow: visible !important/);
  assert.match(normalizer, /clip-path: inset\(0\) !important/);
  assert.match(normalizer, /setProperty\("overflow", "visible", "important"\)/);
});

test("allows only fixed artifact kinds and derives R2 keys", async () => {
  const source = await read("src/storage.ts");
  for (const kind of ["goal", "html", "audit", "quality", "preview", "pptx", "pdf"]) {
    assert.match(source, new RegExp(`${kind}:`));
  }
  assert.match(source, /jobs\/\$\{jobId\}/);
  assert.match(source, /status = 'running'/);
  assert.doesNotMatch(source, /artifact\.r2Key/);
});

test("does not expose a public runner job endpoint", async () => {
  const source = await read("src/index.ts");
  assert.match(source, /runner_internal_only/);
  assert.match(source, /scheduled\(/);
  assert.match(source, /POLLING_ENABLED/);
});

test("runs independent judges after Dashi and redacts sensitive claims", async () => {
  const workflow = await read("src/workflow.ts");
  const judges = await read("src/judges.ts");
  assert.match(workflow, /runJudges/);
  assert.match(workflow, /judge dashi job/);
  assert.match(judges, /claim\.sensitive !== true/);
  assert.match(judges, /score >= 80/);
  assert.match(judges, /everySlideScoreMin >= 80/);
  assert.match(judges, /JUDGES_NOT_CONFIGURED/);
  assert.match(await read("runner/execute-job.mjs"), /claimIntegrityCheck/);
  assert.match(await read("src/reviser.ts"), /REVISION_OUTPUT_INVALID_SPEC_PATCH/);
  assert.match(await read("src/workflow.ts"), /plan revision for job/);
});

test("blocks sensitive claim effects before rendering and Judge egress", async () => {
  const sentinel = "SENSITIVE_SENTINEL_MINIDECK_SECURITY_TEST";
  const input = {
    jobId: "sensitive-claim-test",
    spec: { slides: [{ id: "s1", claims: ["claim-private"] }] },
    sourceMap: {
      claims: [{ claimId: "claim-private", text: sentinel, sensitive: true }],
    },
  };
  let renderCalls = 0;
  let uploadCalls = 0;
  let judgeRouterCalls = 0;

  const blocked = await runWithClaimIntegrityGate(input, async () => {
    renderCalls += 1;
    uploadCalls += 1;
    return { status: "succeeded", html: sentinel, preview: sentinel };
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error, "CLAIM_INTEGRITY_FAILED");
  assert.doesNotMatch(JSON.stringify(blocked), /SENSITIVE_SENTINEL_MINIDECK_SECURITY_TEST/);
  assert.equal(claimIntegrityCheck(input).exitCode, 1);
  assert.equal(claimTextMap(input.sourceMap).has("claim-private"), false);

  const judgeResult = await runJudgeIfIntegrityPasses(
    {
      status: "succeeded",
      version: { audit: { deterministic: { claimIntegrity: false } } },
    },
    async () => {
      judgeRouterCalls += 1;
      return sentinel;
    },
  );
  assert.equal(judgeResult, null);
  assert.equal(renderCalls, 0);
  assert.equal(uploadCalls, 0);
  assert.equal(judgeRouterCalls, 0);

  const safeInput = {
    ...input,
    sourceMap: {
      claims: [{ claimId: "claim-private", text: sentinel, sensitive: false }],
    },
  };
  const rendered = await runWithClaimIntegrityGate(safeInput, async () => {
    renderCalls += 1;
    return { status: "succeeded" };
  });
  assert.equal(rendered.status, "succeeded");
  assert.equal(claimIntegrityCheck(safeInput).exitCode, 0);
  assert.equal(claimTextMap(safeInput.sourceMap).get("claim-private"), sentinel);
  assert.equal(renderCalls, 1);
});

test("wires integrity preflight before render, revision planning, and Judges", async () => {
  const execution = await read("runner/execute-job.mjs");
  const workflow = await read("src/workflow.ts");
  const judges = await read("src/judges.ts");

  assert.ok(execution.includes("spec: patchSpec(input.spec, input.payload.specPatch)"));
  assert.ok(
    execution.indexOf("return runWithClaimIntegrityGate(integrityInput, async () => {") <
      execution.indexOf("await writeSources(input, workDir)"),
  );
  assert.ok(
    workflow.indexOf("claimIntegrityCheck(input).exitCode") <
      workflow.indexOf("async () => runRevisionPlanner(this.env, input)"),
  );
  assert.match(workflow, /runJudgeIfIntegrityPasses/);
  assert.match(judges, /shouldRunJudges\(result\)/);
});
