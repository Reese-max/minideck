import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CURRENT_STORAGE_ATTEMPT_SQL,
  buildAttemptScopedArtifactKey,
} from "../src/storage-lease.mjs";

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
  assert.match(source, /buildAttemptScopedArtifactKey\(/);
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


test("completion and workflow-failure reports carry the claim attempt fence", async () => {
  const source = await read("src/mcp-service.ts");
  assert.equal([...source.matchAll(/attemptCount: job\.attemptCount/g)].length, 2);
  assert.match(source, /typeof value\.attemptCount === "number"/);
});

test("a stale attempt cannot overwrite the current attempt's R2 artifact", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE presentation_jobs (" +
        "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, " +
        "attempt_count INTEGER NOT NULL, leased_until TEXT NOT NULL);" +
      "INSERT INTO presentation_jobs " +
        "(id, project_id, status, attempt_count, leased_until) " +
        "VALUES ('job-1', 'project-1', 'running', 2, datetime('now', '+10 minutes'))",
    );

    assert.equal(
      database.prepare(CURRENT_STORAGE_ATTEMPT_SQL).get("job-1", 1),
      undefined,
      "the previous attempt must fail the current lease check",
    );
    assert.equal(
      database.prepare(CURRENT_STORAGE_ATTEMPT_SQL).get("job-1", 2).project_id,
      "project-1",
    );

    const previousAttemptKey = buildAttemptScopedArtifactKey(
      "presentation-studio/projects/project-1/",
      "job-1",
      1,
      "index.html",
    );
    const currentAttemptKey = buildAttemptScopedArtifactKey(
      "presentation-studio/projects/project-1/",
      "job-1",
      2,
      "index.html",
    );
    assert.notEqual(previousAttemptKey, currentAttemptKey);
    assert.equal(
      currentAttemptKey,
      "presentation-studio/projects/project-1/jobs/job-1/attempt-2/index.html",
    );

    const storage = await read("src/storage.ts");
    const input = await read("src/input.ts");
    const runner = await read("runner/execute-job.mjs");
    assert.match(storage, /CURRENT_STORAGE_ATTEMPT_SQL/);
    assert.match(storage, /buildAttemptScopedArtifactKey\(/);
    assert.match(input, /attemptCount:\s*job\.attemptCount/);
    assert.match(runner, /storage\/\$\{input\.jobId\}\/\$\{input\.attemptCount\}\/\$\{kind\}/);
  } finally {
    database.close();
  }
});
