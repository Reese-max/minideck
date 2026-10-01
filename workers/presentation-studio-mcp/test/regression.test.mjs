import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Match Workers' UTC clock and resolve the project's extensionless TS imports.
process.env.TZ = "UTC";
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)
      ? specifier + ".ts" : specifier, context);
  },
});
const { registerPresentationTools } = await import("../src/presentation.ts");
const { handleJobApi } = await import("../src/jobs.ts");
const { handleOAuthRequest } = await import("../src/auth.ts");
const { sha256Hex } = await import("../src/crypto.ts");
const { claimJobs, completeFailure } = await import("../../presentation-studio-runner/src/mcp-service.ts");

class D1 {
  database = new DatabaseSync(":memory:");
  onRead = (_sql, row) => row;
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      first() { return db.onRead(sql, db.database.prepare(sql).get(...values) ?? null); },
      all() { return { results: db.database.prepare(sql).all(...values) }; },
      run() { return { meta: { changes: Number(db.database.prepare(sql).run(...values).changes) } }; },
    };
  }
  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(t) {
  const DB = new D1();
  t.after(() => DB.database.close());
  DB.database.exec(`
    CREATE TABLE presentation_system_config (config_key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO presentation_system_config VALUES ('architecture', '{"version":"2.0.0","openDesignEnabled":false,"renderer":"dashi","orchestrator":"cloudflare-workflow"}');
    CREATE TABLE presentation_profiles (id TEXT PRIMARY KEY);
    INSERT INTO presentation_profiles VALUES ('cpu-police-academic-v1');
    CREATE TABLE presentation_idempotency (idempotency_key TEXT PRIMARY KEY, tool_name TEXT, request_hash TEXT, result_json TEXT, expires_at TEXT);
    CREATE TABLE presentation_projects (id TEXT PRIMARY KEY, title TEXT, brief TEXT, profile_id TEXT, renderer TEXT, status TEXT,
      target_score INTEGER, max_rounds INTEGER, source_summary TEXT, current_round INTEGER DEFAULT 0, current_score INTEGER,
      approved_version_id TEXT, updated_at TEXT);
    CREATE TABLE presentation_project_runtime (project_id TEXT PRIMARY KEY, owner_id TEXT, workflow_run_id TEXT, random_seed TEXT,
      requested_formats_json TEXT, last_error TEXT, blocked_reason TEXT, updated_at TEXT);
    CREATE TABLE presentation_versions (id TEXT PRIMARY KEY, project_id TEXT, version_number INTEGER, spec_json TEXT,
      audit_json TEXT, score INTEGER, hard_gates_pass INTEGER DEFAULT 0, origin TEXT, UNIQUE(project_id, version_number));
    CREATE TABLE presentation_version_runtime (version_id TEXT PRIMARY KEY, parent_version_id TEXT, changed_slides_json TEXT,
      r2_prefix TEXT, renderer_report_json TEXT, export_report_json TEXT, is_approved INTEGER DEFAULT 0);
    CREATE TABLE presentation_sources (id TEXT PRIMARY KEY, project_id TEXT, file_name TEXT, mime_type TEXT, r2_key TEXT,
      parsed_text_r2_key TEXT, sha256 TEXT, byte_size INTEGER);
    CREATE TABLE presentation_claims (id TEXT PRIMARY KEY, project_id TEXT, source_id TEXT, claim_text TEXT, source_location TEXT, confidence REAL, sensitive INTEGER);
    CREATE TABLE presentation_artifacts (id TEXT PRIMARY KEY, project_id TEXT, version_id TEXT, kind TEXT, r2_key TEXT,
      mime_type TEXT, byte_size INTEGER, sha256 TEXT, expires_at TEXT);
    CREATE TABLE presentation_events (id TEXT PRIMARY KEY, project_id TEXT, event_type TEXT, payload_json TEXT);
    CREATE TABLE presentation_approvals (id TEXT PRIMARY KEY, project_id TEXT, version_id TEXT, decision TEXT, note TEXT);
    CREATE TABLE presentation_jobs (id TEXT PRIMARY KEY, project_id TEXT, job_type TEXT, status TEXT, payload_json TEXT,
      max_attempts INTEGER, attempt_count INTEGER DEFAULT 0, available_at TEXT DEFAULT (datetime('now')),
      leased_until TEXT, started_at TEXT, finished_at TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
    CREATE TABLE presentation_oauth_tokens (access_token_hash TEXT PRIMARY KEY, refresh_token_hash TEXT UNIQUE, owner_login TEXT,
      scopes_json TEXT, access_expires_at TEXT, refresh_expires_at TEXT, revoked_at TEXT, last_used_at TEXT);
  `);
  const objects = new Map();
  const env = {
    DB, PRESENTATION_RUNNER_TOKEN: "test-runner-token",
    BUCKET: {
      async put(key, bytes) { objects.set(key, bytes); },
      async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
      async head(key) { return objects.has(key) ? { size: objects.get(key).byteLength } : null; },
    },
  };
  env.MCP_SERVICE = { fetch: (request) => handleJobApi(request, env) };
  function tools(owner = "alice") {
    const handlers = {};
    registerPresentationTools({ registerTool(name, _options, handler) { handlers[name] = handler; } }, env, owner, ["presentation:read", "presentation:write"]);
    return async (name, input) => JSON.parse((await handlers[name](input)).content[0].text);
  }
  return { env, objects, tools, row: (sql) => DB.database.prepare(sql).get() };
}

const createInput = { title: "Test deck", brief: "Test brief", slideSpec: { slides: [{ id: "s1", role: "cover" }] } };
const source = (sourceId, contentText = sourceId) => ({ sourceId, fileName: "notes.txt", mimeType: "text/plain", contentText });

test("idempotent create replays for its owner and isolates another owner using the same key", async (t) => {
  const f = fixture(t);
  const input = { ...createInput, idempotencyKey: "shared-test-key" };
  const first = await f.tools("alice")("create_presentation", input);
  assert.deepEqual(await f.tools("alice")("create_presentation", input), first);
  const second = await f.tools("bob")("create_presentation", input);
  assert.notEqual(second.projectId, first.projectId);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_projects").n, 2);
});

test("all idempotent mutations enforce ownership even when another owner has cached the input", async (t) => {
  const f = fixture(t);
  const project = await f.tools()("create_presentation", createInput);
  const audit = { allHardGatesPass: true, judgesComplete: true, visualJudgePass: true, factualJudgePass: true, everySlideScoreMin: 95 };
  f.env.DB.database.prepare("UPDATE presentation_versions SET audit_json = ?, score = 95, hard_gates_pass = 1").run(JSON.stringify(audit));
  for (const [name, input] of [
    ["request_presentation_revision", { projectId: project.projectId, instruction: "Repair title" }],
    ["approve_presentation", { projectId: project.projectId, versionId: project.versionId }],
    ["export_presentation", { projectId: project.projectId, versionId: project.versionId }],
  ]) {
    const keyed = { ...input, idempotencyKey: "owner-key-" + name };
    await f.tools("alice")(name, keyed);
    await assert.rejects(f.tools("bob")(name, keyed), /PROJECT_NOT_FOUND/);
  }
});

test("failed source uploads clean every attempted object, including a put that writes then rejects", async (t) => {
  const f = fixture(t);
  const put = f.env.BUCKET.put;
  let writes = 0;
  f.env.BUCKET.put = async (...args) => { await put(...args); if (++writes === 2) throw new Error("test upload failed"); };
  await assert.rejects(f.tools()("create_presentation", { ...createInput, sources: [source("one"), source("two")] }), /test upload failed/);
  assert.equal(f.objects.size, 0);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_projects").n, 0);
});

test("valid distinct source IDs retain distinct bytes and hashes", async (t) => {
  const f = fixture(t);
  await f.tools()("create_presentation", { ...createInput, sources: [source("a:b", "first"), source("a_b", "second")] });
  const rows = f.env.DB.database.prepare("SELECT r2_key, sha256 FROM presentation_sources ORDER BY id").all();
  assert.notEqual(rows[0].r2_key, rows[1].r2_key);
  for (const row of rows) assert.equal(await sha256Hex(f.objects.get(row.r2_key)), row.sha256);
});

test("revision budget includes queued and running work without partial writes on rejection", async (t) => {
  const f = fixture(t);
  const project = await f.tools()("create_presentation", { ...createInput, maxRounds: 1 });
  const input = { projectId: project.projectId, instruction: "Repair title" };
  await f.tools()("request_presentation_revision", input);
  const before = f.env.DB.database.prepare("SELECT * FROM presentation_events").all();
  await assert.rejects(f.tools()("request_presentation_revision", input), /MAX_ROUNDS_REACHED/);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_jobs WHERE job_type = 'revision'").n, 1);
  assert.deepEqual(f.env.DB.database.prepare("SELECT * FROM presentation_events").all(), before);
});

test("runner and real job API preserve attempts through claim, recovery and stale completion", async (t) => {
  const f = fixture(t);
  await f.tools()("create_presentation", createInput);
  const [oldJob] = await claimJobs(f.env, 1);
  assert.equal(oldJob.attemptCount, 1);
  assert.deepEqual(await claimJobs(f.env, 1), []);
  f.env.DB.database.exec("UPDATE presentation_jobs SET leased_until = datetime('now', '-1 minute')");
  const [current] = await claimJobs(f.env, 1);
  assert.equal(current.attemptCount, 2);
  const stale = await completeFailure(f.env, oldJob, new Error("stale"));
  assert.equal(stale.error, "job_lease_not_current");
  assert.equal(f.row("SELECT status FROM presentation_jobs").status, "running");
  await completeFailure(f.env, current, new Error("current failure"));
  assert.equal(f.row("SELECT last_error FROM presentation_jobs").last_error, "current failure");
});

test("lease expiry during artifact validation aborts the entire completion transaction", async (t) => {
  const f = fixture(t);
  const project = await f.tools()("create_presentation", createInput);
  const [job] = await claimJobs(f.env, 1);
  f.env.BUCKET.head = async () => {
    f.env.DB.database.exec("UPDATE presentation_jobs SET leased_until = datetime('now', '-1 minute')");
    return { size: 3 };
  };
  const before = f.env.DB.database.prepare("SELECT * FROM presentation_events").all();
  const response = await handleJobApi(new Request("https://test/internal/jobs/complete", {
    method: "POST", headers: { authorization: "Bearer test-runner-token" },
    body: JSON.stringify({ jobId: job.id, attemptCount: job.attemptCount, status: "succeeded",
      version: { spec: createInput.slideSpec, audit: {}, score: 0, hardGatesPass: false },
      artifacts: [{ r2Key: `presentation-studio/projects/${project.projectId}/jobs/${job.id}/attempt-1/index.html`, kind: "html", mimeType: "text/html" }],
    }),
  }), f.env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "job_lease_not_current");
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_versions").n, 1);
  assert.equal(f.row("SELECT status FROM presentation_jobs").status, "running");
  assert.equal(f.row("SELECT status FROM presentation_projects").status, "queued");
  assert.deepEqual(f.env.DB.database.prepare("SELECT * FROM presentation_events").all(), before);
});

test("concurrent refresh requests consume one token once and mint only one successor", async (t) => {
  const f = fixture(t);
  f.env.DB.database.prepare("INSERT INTO presentation_oauth_tokens (access_token_hash, refresh_token_hash, owner_login, refresh_expires_at) VALUES (?, ?, 'alice', ?)")
    .run("old-access", await sha256Hex("test-refresh"), new Date(Date.now() + 60_000).toISOString());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  f.env.DB.onRead = async (sql, row) => {
    if (sql.startsWith("SELECT refresh_token_hash")) { if (++reads === 2) release(); await gate; }
    return row;
  };
  const request = () => new Request("https://test/oauth/token", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "test-refresh" }) });
  const responses = await Promise.all([handleOAuthRequest(request(), f.env), handleOAuthRequest(request(), f.env)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_oauth_tokens WHERE revoked_at IS NULL").n, 1);
});

test("unqualified approval leaves all approval state unchanged", async (t) => {
  const f = fixture(t);
  const project = await f.tools()("create_presentation", createInput);
  await assert.rejects(f.tools()("approve_presentation", { projectId: project.projectId, versionId: project.versionId }), /APPROVAL_BLOCKED/);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM presentation_approvals").n, 0);
  assert.equal(f.row("SELECT approved_version_id FROM presentation_projects").approved_version_id, null);
  assert.equal(f.row("SELECT is_approved FROM presentation_version_runtime").is_approved, 0);
});
