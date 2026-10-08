import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Native disposable SQLite + actual API/service/Workflow. Only planner, renderer
// and Judge effects are mocked. Logical DB time advances across bounded retries;
// this is not a physical two-hour/cloud Workflow or provider acceptance test.
const root = process.env.MINIDECK9_BASELINE_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const mcp = path.join(root, "presentation-studio-mcp");
const runner = path.join(root, "presentation-studio-runner");
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  let source;
  if (specifier === "cloudflare:workers") source = "export class WorkflowEntrypoint { constructor(_ctx,env) { this.env=env; } }";
  if (specifier === "@cloudflare/containers") source = "export class Container {} export const getContainer=()=>globalThis.__renewalRuntime.container;";
  if (context.parentURL?.endsWith("/workflow.ts")) {
    if (specifier === "./input") source = "export const loadJobInput=async()=>globalThis.__renewalRuntime.effect('load',globalThis.__renewalRuntime.input);";
    if (specifier === "./planner") source = "export const runPlanner=async()=>globalThis.__renewalRuntime.effect('plan',{status:'succeeded',slideSpec:{slides:[{id:'s1',keyMessage:'Owned synthetic plan'}]}});";
    if (specifier === "./judges") source = "export const runJudges=async(_env,_input,result)=>globalThis.__renewalRuntime.effect('judge',result);";
  }
  if (source) return { url: data(source), shortCircuit: true };
  if (specifier.startsWith(".") && !path.extname(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { handleJobApi } = await import(pathToFileURL(path.join(mcp, "src/jobs.ts")));
const { PresentationWorkflow } = await import(pathToFileURL(path.join(runner, "src/workflow.ts")));
hooks.deregister();
const JOB = "22222222-2222-2222-2222-222222222222";
const PROJECT = "11111111-1111-1111-1111-111111111111";
const TOKEN = "owned-runtime-runner";

function fixture({ type = "render", expireBefore, takeoverBefore, retries = false, badAck = false, oldAge = 0, failPlan = false, exhaustCompletion = false, completionLeaseLost = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(path.join(mcp, "migrations/0001_init.sql"), "utf8"));
  let now = Math.floor(Date.now() / 1000);
  const stamp = () => new Date(now * 1000).toISOString().slice(0, 19).replace("T", " ");
  // Only the clock input is controlled. All date arithmetic, UPDATE predicates,
  // transactions and result writes still execute in native SQLite.
  const sqlClock = (sql) => sql.replaceAll("'now'", `'${stamp()}'`);
  const db = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sqlClock(sql)).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sqlClock(sql)).all(...args) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sqlClock(sql)).run(...args).changes) } }; },
    };
  }, async batch(statements) {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  sqlite.prepare("INSERT INTO presentation_projects(id,status) VALUES(?,'running')").run(PROJECT);
  sqlite.prepare("INSERT INTO presentation_project_runtime(project_id) VALUES(?)").run(PROJECT);
  sqlite.prepare("INSERT INTO presentation_jobs(id,project_id,job_type,status,payload_json,attempt_count,max_attempts,leased_until,started_at) VALUES(?,?,?,'running','{}',1,3,datetime(?,'+60 minutes'),datetime(?,?))")
    .run(JOB, PROJECT, type, stamp(), stamp(), `-${oldAge} seconds`);
  const job = { id: JOB, projectId: PROJECT, type, attemptCount: 1, payload: {} };
  const trace = [];
  const input = { type, jobId: JOB, projectId: PROJECT, attemptCount: 1,
    spec: { slides: [{ id: "s1", keyMessage: "Owned synthetic slide" }] },
    sourceMap: { claims: [] }, sources: [], profile: {}, payload: {}, changedSlides: [], parentVersionId: null };
  let renders = 0;
  const state = { sqlite, trace, input, job, counters: { load: 0, plan: 0, execute: 0, judge: 0, complete: 0 },
    effect(name, value) {
      const previous = trace.at(-1);
      trace.push({ kind: name, at: now }); this.counters[name]++;
      const row = sqlite.prepare("SELECT * FROM presentation_jobs").get();
      assert.equal(row.attempt_count, 1, "every effect belongs to the same attempt");
      assert.equal(row.status, "running");
      assert.ok(row.leased_until > stamp(), "every effect starts with a current native-SQL lease");
      assert.equal(previous?.kind, "renewed", "renewal precedes the effect");
      if (name === "plan" && failPlan) throw new Error("owned_planner_failure");
      return structuredClone(value);
    }, container: { async runJob() {
      state.effect("execute", {}); renders++;
      if (retries && renders < 3) throw new Error("owned_transient_render");
      return { status: "succeeded", jobId: JOB, version: { spec: input.spec,
        audit: { deterministic: { claimIntegrity: true } }, score: 90, hardGatesPass: true,
        changedSlides: [], parentVersionId: null, origin: "runner" } };
    } }, close() { sqlite.close(); }, getNow() { return now; } };
  const env = { DB: db, PRESENTATION_RUNNER_TOKEN: TOKEN, DASHI_CONTAINER: {}, BUCKET: { async head() { throw new Error("No owned test may access R2"); } } };
  env.MCP_SERVICE = { async fetch(request) {
    const endpoint = new URL(request.url).pathname.split("/").at(-1);
    const body = await request.clone().json();
    assert.equal(body.jobId, JOB); assert.equal(body.attemptCount, 1);
    if (endpoint === "complete") { trace.push({ kind: "complete", at: now }); state.counters.complete++; }
    if (endpoint === "complete" && completionLeaseLost) sqlite.prepare("UPDATE presentation_jobs SET attempt_count=2,leased_until=datetime(?,'+60 minutes')").run(stamp());
    if (exhaustCompletion && endpoint === "complete" && body.status === "succeeded") return Response.json({ error: "owned_transient_commit" }, { status: 503 });
    const response = await handleJobApi(request, env);
    if (endpoint === "renew") {
      const ack = await response.clone().json();
      trace.push({ kind: ack.status === "renewed" ? "renewed" : "rejected", at: now, ack });
      if (badAck) return Response.json({ ...ack, jobId: PROJECT });
    }
    return response;
  } };
  const step = { async do(name, ...args) {
    const callback = args.at(-1), options = args.length === 2 ? args[0] : null;
    const stage = name.startsWith("load") ? "load" : name.startsWith("execute") ? "execute" :
      name.startsWith("judge") ? "judge" : name.startsWith("plan") ? "plan" : name.startsWith("complete") ? "complete" : "failure";
    if (stage === expireBefore) sqlite.prepare("UPDATE presentation_jobs SET leased_until=?").run(stamp());
    if (stage === takeoverBefore) sqlite.prepare("UPDATE presentation_jobs SET attempt_count=2,leased_until=datetime(?,'+60 minutes')").run(stamp());
    if (stage === "complete" && exhaustCompletion) {
      assert.equal(options, null, "default completion options remain unchanged");
      for (let i = 0; i < 6; i++) {
        try { return await callback(); }
        catch (e) {
          assert.equal(e.message, "MCP_SERVICE_ERROR:503");
          now += 600;
          if (i === 5) throw e;
          now += 10 * (2 ** i);
        }
      }
    }
    if (stage === "execute" && retries) {
      assert.deepEqual(options, { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "35 minutes" });
      for (let i = 0; i < 3; i++) {
        try { const result = await callback(); now += 2100; return result; }
        catch (e) { assert.equal(e.message, "owned_transient_render"); now += 2100 + 30 * (2 ** i); if (i === 2) throw e; }
      }
    }
    const result = await callback();
    if (retries && stage === "load") now += 300;
    if (retries && stage === "judge") now += 600;
    return result;
  } };
  state.run = async () => {
    globalThis.__renewalRuntime = state;
    try { return await new PresentationWorkflow({}, env).run({ payload: { job } }, step); }
    finally { delete globalThis.__renewalRuntime; }
  };
  return state;
}

test("actual API/service/Workflow renew each retry and complete a healthy same attempt beyond60 logical minutes", async () => {
  const f = fixture({ retries: true }); try {
    const start = f.getNow(), result = await f.run();
    assert.equal(result.status, "succeeded"); assert.ok(f.getNow() - start > 3600);
    assert.deepEqual(f.counters, { load: 1, plan: 0, execute: 3, judge: 1, complete: 1 });
    assert.equal(f.trace.filter(t => t.kind === "renewed").length, 6);
    const job = f.sqlite.prepare("SELECT * FROM presentation_jobs").get();
    assert.equal(job.status, "succeeded"); assert.equal(job.attempt_count, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM presentation_versions").get().n, 1);
  } finally { f.close(); }
});

for (const stage of ["load", "execute", "judge", "complete"]) test(`expired lease before ${stage} stops later effects and completion writes`, async () => {
  const f = fixture({ expireBefore: stage }); try {
    const result = await f.run(); assert.equal(result.error, "job_lease_not_current");
    assert.equal(f.counters[stage], 0); assert.equal(f.counters.complete, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM presentation_versions").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT status FROM presentation_jobs").get().status, "running");
  } finally { f.close(); }
});

test("same server fence preserves a newer attempt before old renderer work", async () => {
  const f = fixture({ takeoverBefore: "execute" }); try {
    const result = await f.run(); assert.equal(result.error, "job_lease_not_current");
    assert.equal(f.counters.execute, 0); assert.equal(f.counters.complete, 0);
    assert.equal(f.sqlite.prepare("SELECT attempt_count FROM presentation_jobs").get().attempt_count, 2);
  } finally { f.close(); }
});

test("finite total horizon with insufficient callback time cannot start renderer", async () => {
  const f = fixture({ oldAge: 20010 }); try {
    const result = await f.run(); assert.equal(result.error, "job_lease_not_current");
    assert.equal(f.counters.load, 1); assert.equal(f.counters.execute, 0); assert.equal(f.counters.complete, 0);
    assert.equal(f.sqlite.prepare("SELECT attempt_count FROM presentation_jobs").get().attempt_count, 1);
  } finally { f.close(); }
});

test("malformed renewal acknowledgement stops all planner/renderer effects", async () => {
  const f = fixture({ type: "plan", badAck: true }); try {
    await assert.rejects(f.run(), /MCP_SERVICE_INVALID_RENEWAL/);
    assert.deepEqual(f.counters, { load: 0, plan: 0, execute: 0, judge: 0, complete: 0 });
  } finally { f.close(); }
});

test("owned planner error renews again before actual fenced terminal completion", async () => {
  const f = fixture({ type: "plan", failPlan: true }); try {
    const result = await f.run(); assert.equal(result.status, "failed");
    assert.equal(f.counters.plan, 1); assert.equal(f.counters.complete, 1);
    assert.equal(f.trace.filter(t => t.kind === "renewed").length, 2);
    assert.equal(f.sqlite.prepare("SELECT status FROM presentation_jobs").get().status, "failed");
  } finally { f.close(); }
});

test("six default completion failures then fenced failure recording fit the final finite horizon without repeating render/Judge", async () => {
  const f = fixture({ oldAge: 16000, exhaustCompletion: true }); try {
    const result = await f.run(); assert.equal(result.status, "failed");
    assert.deepEqual(f.counters, { load: 1, plan: 0, execute: 1, judge: 1, complete: 7 });
    assert.equal(f.trace.filter(t => t.kind === "renewed").length, 10);
    assert.equal(f.sqlite.prepare("SELECT status FROM presentation_jobs").get().status, "failed");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM presentation_versions").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE event_type='job.failed'").get().n, 1);
  } finally { f.close(); }
});

test("original successful plan completion stays compatible with pre-call renewal", async () => {
  const f = fixture({ type: "plan" }); try {
    const result = await f.run(); assert.equal(result.status, "succeeded");
    assert.deepEqual(f.counters, { load: 0, plan: 1, execute: 0, judge: 0, complete: 1 });
    assert.equal(f.trace.filter(t => t.kind === "renewed").length, 2);
    assert.equal(f.sqlite.prepare("SELECT status FROM presentation_jobs WHERE id=?").get(JOB).status, "succeeded");
  } finally { f.close(); }
});

test("original terminal completion409 returns terminally without failure retries or new renderer work", async () => {
  const f = fixture({ completionLeaseLost: true }); try {
    const result = await f.run(); assert.equal(result.error, "job_lease_not_current");
    assert.deepEqual(f.counters, { load: 1, plan: 0, execute: 1, judge: 1, complete: 1 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM presentation_versions").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT attempt_count FROM presentation_jobs WHERE id=?").get(JOB).attempt_count, 2);
  } finally { f.close(); }
});
