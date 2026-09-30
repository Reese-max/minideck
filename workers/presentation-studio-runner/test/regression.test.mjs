import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const containerStub = `export class Container {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async start() { this.ctx.container.running = true; this.renewActivityTimeout(); }
  renewActivityTimeout() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.ctx.container.destroy(), parseFloat(this.sleepAfter) * 60000);
  }
}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cloudflare/containers") return { url: "data:text/javascript," + encodeURIComponent(containerStub), shortCircuit: true };
    return next(specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) ? specifier + ".ts" : specifier, context);
  },
});
const { applyRevisionPatch, runRevisionPlanner } = await import("../src/reviser.ts");
const { runJudges } = await import("../src/judges.ts");
const { DashiContainer } = await import("../src/container.ts");

function input() {
  return {
    jobId: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002",
    attemptCount: 1, type: "revision", title: "Fixture", brief: "Fixture brief",
    profile: { id: "fixture", rendererBinding: {}, qualityPolicy: {} },
    spec: { slides: [{ id: "s1", keyMessage: "First" }, { id: "s2", keyMessage: "Second" }] },
    sourceMap: { claims: [] }, changedSlides: ["s1"], payload: { instruction: "Repair s1" },
  };
}

test("supplied patches obey the same target and claim validation as planner patches", () => {
  const job = input();
  for (const slides of [
    [{ id: "s2", keyMessage: "Wrong target" }], [{ id: "missing", keyMessage: "Unknown" }],
    [{ id: "s1", claims: ["unknown"] }],
    [{ id: "s1", claims: [], sourceClaimIds: ["unknown"] }], [{ id: "s1" }, { id: "s1" }],
  ]) assert.equal(applyRevisionPatch(job, { slides }), null, JSON.stringify(slides));
  const changed = applyRevisionPatch({ ...job, changedSlides: [] }, { slides: [{ id: "s1", keyMessage: "Repaired" }] });
  assert.equal(changed.spec.slides[0].keyMessage, "Repaired");
  assert.deepEqual(changed.changedSlides, ["s1"]);
  assert.equal(job.spec.slides[0].keyMessage, "First");
});

test("supplied patches retain supported Dashi title and variants fields", () => {
  const variants = [{ id: "default", html: "<h1>Repaired</h1>" }];
  const patched = applyRevisionPatch(input(), { slides: [{ id: "s1", title: "Repaired", variants }] });
  assert.ok(patched);
  assert.equal(patched.spec.slides[0].title, "Repaired");
  assert.deepEqual(patched.spec.slides[0].variants, variants);
  assert.deepEqual(patched.changedSlides, ["s1"]);
});

function sensitiveInput() {
  const job = input();
  job.sourceMap.claims = [{ claimId: "private", sensitive: true, text: "synthetic confidential fact" }];
  job.spec.slides[0].claims = ["private"];
  job.spec.slides[0].keyMessage = "synthetic confidential fact";
  return job;
}

test("neither judge nor revision planner sends a sensitive-bound spec outside the worker", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ score: 95, everySlideScoreMin: 95, pass: true, issues: [], slides: [{ id: "s1", keyMessage: "Repaired" }] }) } }] });
  });
  const env = { CF_AI_ROUTER_URL: "https://test.invalid", CF_AI_ROUTER_API_KEY: "test-only",
    BUCKET: { get: async () => ({ size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }), put: async () => {} } };
  const job = sensitiveInput();
  const result = { status: "succeeded", jobId: job.jobId, version: { spec: job.spec, audit: { deterministic: { claimIntegrity: false } } },
    artifacts: [{ kind: "preview", r2Key: "preview" }] };
  const judged = await runJudges(env, job, result);
  assert.equal(calls, 0, "judges must fail closed before sending spec/preview");
  assert.equal(judged.version.audit.judgesComplete, false);
  const revised = await runRevisionPlanner(env, job);
  assert.equal(calls, 0, "the revision planner must also protect its currentSpec");
  assert.equal(revised.status, "blocked");
});

test("the revision planner blocks sensitive currentSpec before its own router call", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ slides: [{ id: "s1", keyMessage: "Repaired" }] }) } }] });
  });
  const revised = await runRevisionPlanner({ CF_AI_ROUTER_URL: "https://test.invalid", CF_AI_ROUTER_API_KEY: "test-only" }, sensitiveInput());
  assert.equal(calls, 0);
  assert.equal(revised.status, "blocked");
});

test("a reused container stays active for a valid twenty-minute raw exec", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveOutput, rejectOutput;
  const output = new Promise((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
  const job = input();
  const container = new DashiContainer({ container: {
    running: true,
    destroy: () => rejectOutput(new Error("idle timeout")),
    exec: async () => ({ output: () => output, exitCode: Promise.resolve(0), kill: async () => rejectOutput(new Error("exec timeout")) }),
  } }, {});
  container.renewActivityTimeout();
  const result = container.runJob(job);
  result.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  setTimeout(() => resolveOutput({ stdout: JSON.stringify({ status: "succeeded", jobId: job.jobId }) }), 20 * 60_000);
  t.mock.timers.tick(20 * 60_000);
  assert.equal((await result).status, "succeeded");
});

async function runCli(t, failStage, job) {
  const directory = await mkdtemp(join(tmpdir(), "minideck-runner-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, "uploads.jsonl");
  const child = spawn(process.execPath, ["--import", new URL("fixtures/runner-runtime.mjs", import.meta.url).href,
    fileURLToPath(new URL("../runner/execute-job.mjs", import.meta.url))], {
    env: { ...process.env, DASHI_ROOT: directory, TEST_FAIL_STAGE: failStage || "", TEST_UPLOAD_TRACE: trace },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(job));
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, stderr + stdout);
  const uploads = await readFile(trace, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  return { result: JSON.parse(stdout.trim().split("\n").at(-1)), uploads };
}

function exportInput() {
  const job = input();
  return { ...job, type: "export", requestedFormats: ["pptx"], spec: { schemaVersion: 2,
    slides: job.spec.slides.map((slide) => ({ ...slide, variants: [{}, {}, {}, {}] })) } };
}

test("the actual stdin runner exports valid artifacts using the attempt-scoped storage route", async (t) => {
  const { result, uploads } = await runCli(t, null, exportInput());
  assert.equal(result.status, "succeeded");
  assert.ok(result.artifacts.some((artifact) => artifact.kind === "pptx"));
  assert.match(uploads, /\/attempt-1\//);
});

for (const failStage of ["validate:swiss", "export:pptx"]) {
  test(`the actual stdin runner blocks export after ${failStage} fails even if files exist`, async (t) => {
    const { result, uploads } = await runCli(t, failStage, exportInput());
    assert.equal(result.status, "blocked");
    assert.equal(uploads, "", "failed exports must not publish artifacts");
  });
}

test("the actual stdin runner blocks sensitive claim bindings before rendering or uploading", async (t) => {
  const job = sensitiveInput();
  job.spec = { schemaVersion: 2, slides: job.spec.slides.map((slide) => ({ ...slide, variants: [{}, {}, {}, {}] })) };
  const { result, uploads } = await runCli(t, null, job);
  assert.equal(result.status, "blocked");
  assert.equal(uploads, "");
});
