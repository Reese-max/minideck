import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
