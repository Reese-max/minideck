import { DatabaseSync } from "node:sqlite";
import { CURRENT_STORAGE_ATTEMPT_SQL, buildAttemptScopedArtifactKey } from "../src/storage-lease.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  applyRevisionPatch,
  normalizeRevisionPatch,
} from "../src/revision-patch.mjs";
import { fileURLToPath } from "node:url";
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
  assert.match(source, /buildAttemptScopedArtifactKey\(/);
  const lease = await read("src/storage-lease.mjs");
  assert.match(lease, /jobs\/\$\{jobId\}/);
  assert.match(lease, /status = 'running'/);
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

test("supplied and planner spec patches share the same scope validation", async () => {
  const workflow = await read("src/workflow.ts");
  const reviser = await read("src/reviser.ts");
  assert.match(workflow, /applyRevisionPatch\(input, suppliedPatch\)/);
  assert.match(reviser, /revision-patch\.mjs/);
  assert.match(reviser, /normalizeRevisionPatch/);

  const input = {
    spec: {
      slides: [
        { id: "s1", keyMessage: "one" },
        { id: "s2", keyMessage: "two" },
      ],
    },
    sourceMap: { claims: [] },
    payload: {},
    changedSlides: ["s1"],
  };
  const outOfScope = { slides: [{ id: "s2", keyMessage: "tampered" }] };
  assert.equal(normalizeRevisionPatch(outOfScope, input), null);
  assert.equal(applyRevisionPatch(input, outOfScope), null);

  const inScope = { slides: [{ id: "s1", keyMessage: "revised" }] };
  const applied = applyRevisionPatch(input, inScope);
  assert.ok(applied);
  assert.equal(applied.spec.slides[0].keyMessage, "revised");
  assert.equal(applied.spec.slides[1].keyMessage, "two");
  assert.deepEqual(applied.changedSlides, ["s1"]);
  assert.equal(applied.payload.specPatch, null);
});

test("claim fields are each validated against verified non-sensitive ids", async () => {
  const input = {
    spec: { slides: [{ id: "s1", keyMessage: "one" }] },
    sourceMap: {
      claims: [
        { claimId: "c1", sensitive: false },
        { claimId: "c2", sensitive: true },
      ],
    },
    payload: {},
    changedSlides: ["s1"],
  };
  const smuggled = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c2"] }] };
  assert.equal(normalizeRevisionPatch(smuggled, input), null);
  const clean = { slides: [{ id: "s1", claims: ["c1"], sourceClaimIds: ["c1"] }] };
  assert.ok(normalizeRevisionPatch(clean, input));
});

test("runner refuses residual caller specPatch instead of merging it", async () => {
  const source = await read("runner/execute-job.mjs");
  assert.match(source, /SPEC_PATCH_REQUIRES_WORKFLOW_VALIDATION/);
  assert.doesNotMatch(source, /patchSpec/);
});

test("changedSlides includes only slides whose JSON values actually change", () => {
  const input = {
    spec: {
      slides: [
        { id: "s1", keyMessage: "one", content: { title: "One", items: ["a"] } },
        { id: "s2", keyMessage: "two" },
        { id: "s3", keyMessage: "three" },
      ],
    },
    sourceMap: { claims: [] },
    payload: {},
    changedSlides: ["s1", "s2", "s3"],
  };
  const original = structuredClone(input);
  for (const slide of [
    { id: "s1" },
    { id: "s1", keyMessage: "one" },
    { id: "s1", content: { items: ["a"], title: "One" } },
  ]) {
    const result = applyRevisionPatch(input, { slides: [slide] });
    assert.ok(result);
    assert.deepEqual(result.spec, input.spec);
    assert.deepEqual(result.changedSlides, []);
  }

  const result = applyRevisionPatch(input, {
    slides: [
      { id: "s3", keyMessage: "revised-three" },
      { id: "s1", content: { items: ["b"], title: "One" } },
      { id: "s2", keyMessage: "two" },
    ],
  });
  assert.deepEqual(result.changedSlides, ["s1", "s3"]);
  assert.equal(result.spec.slides[0].content.items[0], "b");
  assert.equal(result.spec.slides[2].keyMessage, "revised-three");
  assert.deepEqual(input, original);
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

test("runner process blocks sensitive claim bindings before any side effect", () => {
  const sentinel = "SENSITIVE_SENTINEL_E2E_EGRESS";
  const runnerPath = fileURLToPath(new URL("../runner/execute-job.mjs", import.meta.url));
  const run = (input) =>
    spawnSync(process.execPath, [runnerPath], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 30_000,
    });
  const assertBlocked = (proc) => {
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.signal, null);
    const result = JSON.parse(proc.stdout.trim());
    assert.equal(result.status, "blocked");
    assert.equal(result.error, "CLAIM_INTEGRITY_FAILED");
    assert.doesNotMatch(proc.stdout, new RegExp(sentinel));
  };

  assertBlocked(
    run({
      jobId: "e2e-sensitive",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-secret"] }] },
      sourceMap: {
        claims: [{ claimId: "c-secret", text: sentinel, sensitive: true }],
      },
    }),
  );

  assertBlocked(
    run({
      jobId: "e2e-unknown",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-missing"] }] },
      sourceMap: { claims: [] },
    }),
  );

  // A revision specPatch that binds a sensitive claim is gated on the
  // patched spec before render, not on the pre-patch spec.
  assertBlocked(
    run({
      jobId: "e2e-revision-patch",
      type: "revision",
      spec: { slides: [{ id: "s1", claims: ["c-pub"] }] },
      sourceMap: {
        claims: [
          { claimId: "c-pub", text: "public fact" },
          { claimId: "c-secret", text: sentinel, sensitive: true },
        ],
      },
      payload: { specPatch: { slides: [{ id: "s1", claims: ["c-secret"] }] } },
    }),
  );

  // specPatch is applied for every job type in prepareGoal, so a render job
  // smuggling a sensitive binding through specPatch must fail closed too.
  assertBlocked(
    run({
      jobId: "e2e-render-patch",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-pub"] }] },
      sourceMap: {
        claims: [
          { claimId: "c-pub", text: "public fact" },
          { claimId: "c-secret", text: sentinel, sensitive: true },
        ],
      },
      payload: { specPatch: { slides: [{ id: "s1", claims: ["c-secret"] }] } },
    }),
  );
});

test("wires integrity preflight before render, revision planning, and Judges", async () => {
  const execution = await read("runner/execute-job.mjs");
  const workflow = await read("src/workflow.ts");
  const judges = await read("src/judges.ts");
  const planner = await read("src/planner.ts");
  const reviser = await read("src/reviser.ts");

  assert.doesNotMatch(execution, /patchSpec/);
  assert.match(execution, /SPEC_PATCH_REQUIRES_WORKFLOW_VALIDATION/);
  assert.ok(
    execution.indexOf("return runWithClaimIntegrityGate(integrityInput, async () => {") <
      execution.indexOf("await writeSources(input, workDir)"),
  );
  assert.ok(
    workflow.indexOf("const initialBoundary = checkClaimBoundary") <
      workflow.indexOf("return runRevisionPlanner(this.env, input)"),
  );
  assert.ok(workflow.indexOf("const initialBoundary = checkClaimBoundary") >= 0);
  assert.ok(workflow.indexOf("return runRevisionPlanner(this.env, input)") >= 0);
  assert.match(workflow, /await renewJob\(this\.env, job, 600\);\s*return runRevisionPlanner\(this\.env, input\)/);
  assert.ok(workflow.indexOf("const boundary = checkClaimBoundary") < workflow.indexOf("container.runJob(executionInput)"));
  assert.ok(planner.indexOf("runWithClaimBoundary") < planner.indexOf("fetch(endpoint"));
  assert.ok(reviser.indexOf("runWithClaimBoundary(input") < reviser.indexOf("fetch(endpoint"));
  assert.match(workflow, /runJudgeIfIntegrityPasses/);
  assert.match(judges, /shouldRunJudges\(result\)/);
  assert.ok(judges.indexOf("shouldRunJudges(result)") < judges.indexOf("env.BUCKET.get(sheet.r2Key)"));
  assert.ok(judges.indexOf("runWithJudgeBoundary(input, result") < judges.indexOf('callRouter(env, "free-vision"'));
});

test("visual judge must cover every slide before approval can pass", async () => {
  const execution = await read("runner/execute-job.mjs");
  const judges = await read("src/judges.ts");
  const storage = await read("src/storage.ts");
  const coverage = await read("runner/visual-coverage.mjs");
  assert.doesNotMatch(execution, /\.slice\(0,\s*20\)/);
  assert.match(execution, /planVisualCoverage/);
  assert.match(judges, /VISUAL_COVERAGE_INCOMPLETE/);
  assert.match(judges, /VISUAL_PREVIEW_SHEETS_MISSING/);
  assert.match(judges, /aggregateVisualReports/);
  assert.match(judges, /visualCoverageSatisfied/);
  assert.match(storage, /preview-\[2-5\]/);
  assert.match(coverage, /PREVIEW_TILES_PER_SHEET\s*=\s*20/);
  assert.match(coverage, /MAX_PREVIEW_SHEETS/);
});
test("runner process blocks sensitive claim bindings before any side effect", () => {
  const sentinel = "SENSITIVE_SENTINEL_E2E_EGRESS";
  const runnerPath = fileURLToPath(new URL("../runner/execute-job.mjs", import.meta.url));
  const run = (input) =>
    spawnSync(process.execPath, [runnerPath], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 30_000,
    });
  const assertBlocked = (proc) => {
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.signal, null);
    const result = JSON.parse(proc.stdout.trim());
    assert.equal(result.status, "blocked");
    assert.equal(result.error, "CLAIM_INTEGRITY_FAILED");
    assert.doesNotMatch(proc.stdout, new RegExp(sentinel));
  };

  assertBlocked(
    run({
      jobId: "e2e-sensitive",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-secret"] }] },
      sourceMap: {
        claims: [{ claimId: "c-secret", text: sentinel, sensitive: true }],
      },
    }),
  );

  assertBlocked(
    run({
      jobId: "e2e-unknown",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-missing"] }] },
      sourceMap: { claims: [] },
    }),
  );

  // A revision specPatch that binds a sensitive claim is gated on the
  // patched spec before render, not on the pre-patch spec.
  assertBlocked(
    run({
      jobId: "e2e-revision-patch",
      type: "revision",
      spec: { slides: [{ id: "s1", claims: ["c-pub"] }] },
      sourceMap: {
        claims: [
          { claimId: "c-pub", text: "public fact" },
          { claimId: "c-secret", text: sentinel, sensitive: true },
        ],
      },
      payload: { specPatch: { slides: [{ id: "s1", claims: ["c-secret"] }] } },
    }),
  );

  // specPatch is applied for every job type in prepareGoal, so a render job
  // smuggling a sensitive binding through specPatch must fail closed too.
  assertBlocked(
    run({
      jobId: "e2e-render-patch",
      type: "render",
      spec: { slides: [{ id: "s1", claims: ["c-pub"] }] },
      sourceMap: {
        claims: [
          { claimId: "c-pub", text: "public fact" },
          { claimId: "c-secret", text: sentinel, sensitive: true },
        ],
      },
      payload: { specPatch: { slides: [{ id: "s1", claims: ["c-secret"] }] } },
    }),
  );
});

test("completion and workflow-failure reports carry the claim attempt fence", async () => {
  const source = await read("src/mcp-service.ts");
  const reports = source.slice(source.indexOf("export async function completeJob("));
  assert.equal([...reports.matchAll(/attemptCount: job\.attemptCount/g)].length, 2);
  assert.equal([...source.matchAll(/attemptCount: job\.attemptCount/g)].length, 3);
  assert.match(source, /"\/internal\/jobs\/renew",\s*\{\s*jobId: job\.id,\s*attemptCount: job\.attemptCount/);
  assert.match(source, /typeof value\.attemptCount === "number"/);
  const workflow = await read("src/workflow.ts");
  assert.match(workflow, /presentation-job-\$\{job\.id\}-attempt-\$\{job\.attemptCount\}/);
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
