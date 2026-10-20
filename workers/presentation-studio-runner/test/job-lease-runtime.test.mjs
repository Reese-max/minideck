import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { test } from "node:test";

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  let source;
  if (specifier === "cloudflare:workers") source = "export class WorkflowEntrypoint { constructor(_ctx,env) { this.env=env; } }";
  if (specifier === "@cloudflare/containers") source = "export class Container {} export const getContainer=()=>globalThis.__leaseRuntime.container;";
  if (context.parentURL?.endsWith("/workflow.ts")) {
    if (specifier === "./input") source = "export const loadJobInput=async()=>globalThis.__leaseRuntime.work('load');";
    if (specifier === "./planner") source = "export const runPlanner=async()=>globalThis.__leaseRuntime.work('plan');";
    if (specifier === "./reviser") source = "export const applyRevisionPatch=(input)=>input; export const runRevisionPlanner=async()=>globalThis.__leaseRuntime.work('revision');";
    if (specifier === "./judges") source = "export const runJudges=async()=>globalThis.__leaseRuntime.work('judge');";
  }
  if (source) return { url: dataModule(source), shortCircuit: true };
  return next(specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) ? specifier + ".ts" : specifier, context);
} });
const { handleJobApi } = await import("../../presentation-studio-mcp/src/jobs.ts");
const service = await import("../src/mcp-service.ts");
const { PresentationWorkflow } = await import("../src/workflow.ts");
hooks.deregister();

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => { db.close(); delete globalThis.__leaseRuntime; });
  // Only SQL time and work effects are simulated; API, service and Workflow are real.
  let clock = Date.parse("2099-01-01T00:00:00Z");
  db.function("test_now", () => new Date(clock).toISOString());
  const sql = (text) => text.replaceAll("'now'", "test_now()");
  db.exec(`CREATE TABLE presentation_jobs (id TEXT PRIMARY KEY, project_id TEXT, job_type TEXT,
    status TEXT, payload_json TEXT DEFAULT '{}', attempt_count INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
    available_at TEXT, leased_until TEXT, started_at TEXT, finished_at TEXT, last_error TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE presentation_projects (id TEXT PRIMARY KEY, profile_id TEXT, renderer TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE presentation_project_runtime (project_id TEXT PRIMARY KEY, last_error TEXT, blocked_reason TEXT, updated_at TEXT);
    CREATE TABLE presentation_events (id TEXT PRIMARY KEY, project_id TEXT, event_type TEXT, payload_json TEXT);
    INSERT INTO presentation_projects (id,status) VALUES ('project','queued');
    INSERT INTO presentation_project_runtime (project_id) VALUES ('project');
    INSERT INTO presentation_jobs (id,project_id,job_type,status,available_at,created_at)
      VALUES ('00000000-0000-4000-8000-000000000009','project','render','queued','2098-01-01','2098-01-01');`);
  const DB = {
    prepare(text) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        first() { return db.prepare(sql(text)).get(...values) ?? null; },
        all() { return { results: db.prepare(sql(text)).all(...values) }; },
        run() { return { meta: { changes: Number(db.prepare(sql(text)).run(...values).changes) } }; },
      };
    },
    batch(statements) {
      db.exec("BEGIN");
      try { const results = statements.map((s) => s.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const events = [];
  const env = { DB, PRESENTATION_RUNNER_TOKEN: "synthetic-runner" };
  env.MCP_SERVICE = { async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.clone().json();
    events.push(path.endsWith("renew") ? "renew" : path.endsWith("complete") ? `complete:${body.status}` : "claim");
    return handleJobApi(request, env);
  } };
  const call = (body, token = "synthetic-runner") => handleJobApi(new Request("https://test/internal/jobs/renew", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), env);
  const row = () => ({ ...db.prepare("SELECT * FROM presentation_jobs").get() });
  const update = (text) => db.exec(sql(`UPDATE presentation_jobs SET ${text}`));
  const advance = (minutes) => { clock += minutes * 60_000; };
  return { env, db, call, row, update, advance, events };
}

test("renewal uses runner auth, validates input, and preserves the claim attempt and start", async (t) => {
  const f = fixture(t);
  const [job] = await service.claimJobs(f.env, 1);
  const body = { jobId: job.id, attemptCount: job.attemptCount };
  assert.equal((await f.call(body, "wrong")).status, 401);
  for (const invalid of [null, {}, { ...body, jobId: "bad" }, ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((attemptCount) => ({ ...body, attemptCount }))]) {
    assert.equal((await f.call(invalid)).status, 400);
  }
  const before = f.row();
  f.advance(40);
  const response = await f.call(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).leasedUntil, "2099-01-01 01:40:00");
  assert.equal(f.row().attempt_count, before.attempt_count);
  assert.equal(f.row().started_at, before.started_at);
  assert.deepEqual(await service.claimJobs(f.env, 1), []);
});

test("expired, replaced, terminal and malformed leases cannot be renewed or resurrected", async (t) => {
  const f = fixture(t);
  const [job] = await service.claimJobs(f.env, 1);
  const body = { jobId: job.id, attemptCount: job.attemptCount };
  for (const change of ["leased_until = datetime('now')", "leased_until = NULL", "leased_until = 'invalid'",
    "attempt_count = 2", "status = 'blocked'", "status = 'failed'", "status = 'succeeded'", "started_at = NULL", "started_at = 'invalid'",
    "started_at = datetime('now', '+1 minute')"]) {
    f.update("status = 'running', attempt_count = 1, started_at = '2099-01-01 00:00:00', leased_until = '2099-01-01 01:00:00'");
    f.update(change);
    const before = f.row();
    assert.equal((await f.call(body)).status, 409, change);
    assert.deepEqual(f.row(), before);
  }
  f.update("status = 'running', attempt_count = 1, started_at = '2099-01-01 00:00:00', leased_until = '2099-01-01 01:00:00'");
  f.advance(61); // Simulates Workflow.create failing without completing the claim.
  const [next] = await service.claimJobs(f.env, 1);
  assert.equal(next.id, job.id);
  assert.equal(next.attemptCount, 2);
  await assert.rejects(service.renewJobLease(f.env, job), /job_lease_not_current/);
  assert.equal((await service.completeFailure(f.env, job, new Error("stale"))).error, "job_lease_not_current");
  assert.equal(f.row().attempt_count, 2);
  f.update("attempt_count = max_attempts, leased_until = datetime('now', '-1 minute')");
  assert.deepEqual(await service.claimJobs(f.env, 1), []);
  assert.equal(f.row().status, "blocked");
  assert.equal(f.row().last_error, "job_lease_expired_max_attempts_exhausted");
});

test("renewal has a finite horizon measured from the unchanged attempt start", async (t) => {
  const f = fixture(t);
  const [job] = await service.claimJobs(f.env, 1);
  for (let i = 0; i < 7; i++) { f.advance(40); await service.renewJobLease(f.env, job); }
  assert.equal(f.row().leased_until, "2099-01-01 05:17:00");
  f.advance(37);
  // The horizon also rejects a still-live lease, independently of lease expiry.
  f.update("leased_until = datetime('now', '+60 minutes')");
  const before = f.row();
  await assert.rejects(service.renewJobLease(f.env, job), /job_lease_not_current/);
  assert.deepEqual(f.row(), before);
  assert.equal(f.row().attempt_count, 1);
  assert.equal(f.row().started_at, "2099-01-01 00:00:00");
});

async function runWorkflow(t, type, { rejectAt, expire = false, completionFailures = false } = {}) {
  const f = fixture(t);
  f.update(`job_type = '${type}'`);
  const [job] = await service.claimJobs(f.env, 1);
  const input = { jobId: job.id, type, spec: { slides: [{ id: "s1" }] }, sourceMap: { claims: [] }, payload: {}, sources: [] };
  let renders = 0;
  const state = {
    async work(name) {
      f.events.push(name);
      if (name === "load") { f.advance(5); return input; }
      if (name === "revision") { f.advance(10); return { status: "succeeded", specPatch: {} }; }
      if (name === "render") {
        f.advance(35);
        if (++renders < 3) throw new Error("synthetic render retry");
        return { status: "succeeded", jobId: job.id, version: { spec: input.spec, audit: { deterministic: { claimIntegrity: true } } } };
      }
      f.advance(10);
      return { status: "blocked", jobId: job.id, error: "synthetic result" };
    },
    container: { runJob: () => state.work("render") },
  };
  globalThis.__leaseRuntime = state;
  const fetch = f.env.MCP_SERVICE.fetch;
  f.env.MCP_SERVICE.fetch = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("renew") && f.events.filter((e) => e === "renew").length === rejectAt) {
      f.update(expire ? "leased_until = datetime('now')" : "attempt_count = 2");
    }
    if (completionFailures && path.endsWith("complete") && (await request.clone().json()).status !== "failed") {
      f.events.push("complete:unavailable");
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    return fetch(request);
  };
  const step = { async do(_name, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    for (let retry = 0; ; retry++) {
      try { return await callback(); }
      catch (error) {
        if (retry >= (options.retries?.limit ?? 0)) throw error;
        f.advance(parseFloat(options.retries.delay) / 60 * 2 ** retry);
      }
    }
  } };
  let result, error;
  try { result = await new PresentationWorkflow({}, f.env).run({ payload: { job } }, step); }
  catch (caught) { error = caught; }
  return { ...f, result, error };
}

for (const type of ["plan", "render", "revision", "export"]) {
  test(`Workflow renews before every ${type} callback and retry, including completion`, async (t) => {
    const f = await runWorkflow(t, type);
    assert.ifError(f.error);
    const effects = f.events.filter((event) => event !== "claim");
    for (let i = 1; i < effects.length; i += 2) assert.equal(effects[i - 1], "renew", effects.join(","));
    assert.equal(effects.at(-1), "complete:blocked");
    assert.equal(f.row().attempt_count, 1);
    assert.equal(f.row().started_at, "2099-01-01 00:00:00");
    assert.equal(f.row().status, "blocked");
    if (type !== "plan") assert.equal(effects.filter((e) => e === "render").length, 3);
  });
}

for (const expire of [false, true]) test(`Workflow stops before work when its attempt is ${expire ? "expired" : "taken over"}`, async (t) => {
  const f = await runWorkflow(t, "render", { rejectAt: 1, expire });
  assert.match(f.error.message, /job_lease_not_current/);
  assert.equal(f.events.includes("render"), false);
  assert.equal(f.events.some((e) => e.startsWith("complete:")), false);
  assert.equal(f.row().attempt_count, expire ? 1 : 2);
});

for (const type of ["plan", "render"]) {
  test(`exhausted ${type} completion retries enter renewed failure reporting without repeating work`, async (t) => {
    const f = await runWorkflow(t, type, { completionFailures: true });
    assert.ifError(f.error);
    assert.equal(f.row().status, "failed");
    assert.equal(f.events.filter((e) => e === "complete:unavailable").length, 6);
    assert.deepEqual(f.events.slice(-2), ["renew", "complete:failed"]);
    assert.equal(f.events.filter((e) => e === "plan").length, type === "plan" ? 1 : 0);
    assert.equal(f.events.filter((e) => e === "render").length, type === "plan" ? 0 : 3);
    assert.equal(f.events.filter((e) => e === "judge").length, type === "plan" ? 0 : 1);
  });
}
