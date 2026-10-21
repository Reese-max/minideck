import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { runIdempotent } from "../src/idempotency.mjs";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) {
      specifier += ".ts";
    }
    return nextResolve(specifier, context);
  },
});
const { registerPresentationTools } = await import("../src/presentation.ts");
hooks.deregister();

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("exposes exactly the v2 high-level presentation tools", async () => {
  const source = await read("src/presentation.ts");
  const expected = [
    "list_presentation_profiles",
    "create_presentation",
    "get_presentation",
    "request_presentation_revision",
    "compare_presentation_versions",
    "approve_presentation",
    "export_presentation",
    "delete_presentation",
  ];
  for (const tool of expected) {
    assert.match(source, new RegExp('"' + tool + '"'));
  }
  for (const forbidden of [
    "run_shell",
    "execute_any_command",
    "write_any_file",
    "arbitrary_sql",
    "arbitrary_r2_key",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden));
  }
});

test("keeps the renderer contract Dashi-only", async () => {
  const source = await read("src/index.ts");
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.match(source, /openDesignEnabled:\s*false/);
  assert.match(source, /renderer:\s*"dashi"/);
  assert.equal(config.name, "presentation-studio-mcp");
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.d1_databases[0].database_name, "presentation-studio");
  assert.equal(config.r2_buckets[0].bucket_name, "minideck");
});

test("requires confirmation before project deletion", async () => {
  const source = await read("src/presentation.ts");
  assert.match(source, /requiresConfirmation:\s*true/);
  assert.match(source, /DELETE_CONFIRMATION_INVALID_OR_EXPIRED/);
  assert.match(source, /DELETE_CONFIRMATION_OWNER_MISMATCH/);
});

test("keeps the D1 job API outside the public MCP tool contract", async () => {
  const index = await read("src/index.ts");
  const jobs = await read("src/jobs.ts");
  assert.match(index, /handleJobApi/);
  assert.match(jobs, /\/internal\/jobs\/claim/);
  assert.match(jobs, /\/internal\/jobs\/complete/);
  assert.match(jobs, /PRESENTATION_RUNNER_TOKEN/);
});

test("does not approve a version before both independent judges complete", async () => {
  const source = await read("src/presentation.ts");
  assert.match(source, /visual_and_factual_judges_incomplete/);
  assert.match(source, /audit\.visualJudgePass !== true/);
  assert.match(source, /audit\.factualJudgePass !== true/);
});

function sourceHarness({ failUpload = false } = {}) {
  const objects = new Map();
  let writes = 0;
  let create;
  registerPresentationTools({
    registerTool(name, _schema, callback) {
      if (name === "create_presentation") create = callback;
    },
  }, {
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("presentation_system_config")) {
              return { value_json: JSON.stringify({ version: "2.0.0", openDesignEnabled: false, renderer: "dashi", orchestrator: "cloudflare-workflow" }) };
            }
            assert.match(sql, /FROM presentation_profiles/);
            return { id: "test-profile" };
          },
        };
      },
      async batch() { writes += 1; return []; },
    },
    BUCKET: {
      async put(key, bytes) {
        objects.set(key, new TextDecoder().decode(bytes));
        if (failUpload && objects.size === 2) throw new Error("R2_UPLOAD_FAILED");
      },
      async delete(keys) { for (const key of keys) objects.delete(key); },
    },
  }, "test-owner", ["presentation:write"]);
  return { create, objects, writes: () => writes };
}

const source = (sourceId, contentText) => ({ sourceId, contentText, fileName: "same.txt", mimeType: "text/plain" });

test("distinct source IDs cannot overwrite each other's R2 content", async () => {
  const { create, objects } = sourceHarness();
  await create({ title: "Sources", brief: "Keep each source", sources: [source("src:1", "first"), source("src_1", "second"), source(".", "dot"), source("..", "double-dot")] });
  const stored = [...objects].filter(([key]) => key.includes("/sources/"));
  assert.equal(stored.length, 4);
  assert.deepEqual(stored.map(([, bytes]) => bytes), ["first", "second", "dot", "double-dot"]);
  for (const [key] of stored) assert.doesNotMatch(key, /\/\.{1,2}\//);
  assert.equal(JSON.parse([...objects].find(([key]) => key.endsWith("source-map.json"))[1]).sources.length, 4);
});

test("a later invalid source or failed upload cleans up earlier R2 writes", async () => {
  for (const failUpload of [false, true]) {
    const harness = sourceHarness({ failUpload });
    const second = { ...source("s2", "second"), mimeType: failUpload ? "text/plain" : "application/x-invalid" };
    await assert.rejects(harness.create({ title: "Sources", brief: "Fail safely", sources: [source("s1", "first"), second] }), /SOURCE_MIME_UNSUPPORTED|R2_UPLOAD_FAILED/);
    assert.equal(harness.objects.size, 0);
    assert.equal(harness.writes(), 0);
  }
});

test("approval fails closed when the visual coverage receipt misses slides", async () => {
  const source = await read("src/presentation.ts");
  const coverage = await read("src/visual-coverage.mjs");
  assert.match(source, /visual_coverage_incomplete/);
  assert.match(source, /visualCoverageSatisfied/);
  assert.match(source, /specSlideIds/);
  assert.match(coverage, /evaluatedSlideIds/);
});

class IdempotencyD1 {
  rows = new Map();

  prepare(sql) {
    const thisDb = this;
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        const row = thisDb.rows.get(values[0]);
        return row ? { ...row } : null;
      },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE")) {
          const [key, toolName, requestHash, expiresAt] = values;
          if (thisDb.rows.has(key)) return { meta: { changes: 0 } };
          thisDb.rows.set(key, {
            idempotency_key: key,
            tool_name: toolName,
            request_hash: requestHash,
            result_json: "__pending__",
            expires_at: expiresAt,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE presentation_idempotency")) {
          const [resultJson, key, requestHash] = values;
          const row = thisDb.rows.get(key);
          if (row?.request_hash === requestHash) row.result_json = resultJson;
          return { meta: { changes: row?.request_hash === requestHash ? 1 : 0 } };
        }
        if (sql.startsWith("DELETE FROM presentation_idempotency")) {
          const [key, second] = values;
          const row = thisDb.rows.get(key);
          const shouldDelete =
            row &&
            (sql.includes("expires_at = ?")
              ? row.expires_at === second
              : row.request_hash === second && row.result_json === "__pending__");
          if (shouldDelete) thisDb.rows.delete(key);
          return { meta: { changes: shouldDelete ? 1 : 0 } };
        }
        throw new Error("Unexpected D1 statement: " + sql);
      },
    };
  }
}

test("idempotency keys are owner-scoped while same-owner create replays are cached", async () => {
  const db = new IdempotencyD1();
  const input = { brief: "Quarterly review", profileId: "board" };
  const effects = [];
  const create = (ownerId) =>
    runIdempotent(
      db,
      ownerId,
      "create_presentation",
      "same-create-key-01",
      input,
      async () => ownerId,
      async (authenticatedOwner) => {
        effects.push(authenticatedOwner);
        return {
          ownerId: authenticatedOwner,
          projectId: "project-" + authenticatedOwner,
          jobId: "job-" + authenticatedOwner,
        };
      },
    );

  const ownerA = await create("owner-a");
  const ownerB = await create("owner-b");
  assert.equal(ownerA.projectId, "project-owner-a");
  assert.equal(ownerB.projectId, "project-owner-b");
  assert.notEqual(ownerA.projectId, ownerB.projectId);
  assert.deepEqual(effects, ["owner-a", "owner-b"]);

  assert.deepEqual(await create("owner-a"), ownerA);
  assert.deepEqual(await create("owner-b"), ownerB);
  assert.deepEqual(effects, ["owner-a", "owner-b"]);
});

test("same-owner changed input is rejected without repeating the cached effect", async () => {
  const db = new IdempotencyD1();
  let effects = 0;
  const call = (input) =>
    runIdempotent(
      db,
      "owner-a",
      "create_presentation",
      "same-input-key-01",
      input,
      async () => undefined,
      async () => ({ projectId: "project-a", sequence: ++effects }),
    );

  const first = await call({ brief: "Original" });
  assert.deepEqual(await call({ brief: "Original" }), first);
  await assert.rejects(call({ brief: "Changed" }), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(effects, 1);
});

test("project write tools perform owner preflight before entering cached actions", async () => {
  const source = await read("src/presentation.ts");
  const revision = source.match(/async function requestRevision\([\s\S]*?\n}\n\nfunction slideArray/);
  const approval = source.match(/async function approvePresentation\([\s\S]*?\n}\n\nasync function exportPresentation/);
  const exportRequest = source.match(/async function exportPresentation\([\s\S]*?\n}\n\nasync function/);

  assert.ok(revision, "revision handler source is present");
  assert.ok(approval, "approval handler source is present");
  assert.ok(exportRequest, "export handler source is present");
  assert.match(
    revision[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(project\) =>/,
  );
  assert.match(
    approval[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(\{ project, version, runtime \}\) =>/,
  );
  assert.match(
    exportRequest[0],
    /async \(\) => \{[\s\S]*getProjectForOwner\([\s\S]*EXPORT_REQUIRES_APPROVED_VERSION[\s\S]*getVersionForOwner\([\s\S]*\},\s*async \(\{ project, versionId \}\) =>/,
  );
});

test("revision, approval, and export replay authorize the owner before returning cache", async () => {
  for (const toolName of [
    "request_presentation_revision",
    "approve_presentation",
    "export_presentation",
  ]) {
    const db = new IdempotencyD1();
    const input = { projectId: "owner-a-project", versionId: "version-1" };
    let effects = 0;
    await runIdempotent(
      db,
      "owner-a",
      toolName,
      "shared-resource-key-01",
      input,
      async () => ({ projectId: input.projectId }),
      async () => ({ effectId: ++effects, ownerId: "owner-a" }),
    );

    let revokedAuthorizationChecks = 0;
    let revokedActions = 0;
    await assert.rejects(
      runIdempotent(
        db,
        "owner-a",
        toolName,
        "shared-resource-key-01",
        input,
        async () => {
          revokedAuthorizationChecks += 1;
          throw new Error("OWNER_ACCESS_REVOKED");
        },
        async () => {
          revokedActions += 1;
          return { effectId: ++effects, ownerId: "owner-a" };
        },
      ),
      /OWNER_ACCESS_REVOKED/,
    );
    assert.equal(revokedAuthorizationChecks, 1, toolName + " reauthorize before cache");
    assert.equal(revokedActions, 0, toolName + " must stop after revoked authorization");

    let authorizationChecks = 0;
    let actions = 0;
    await assert.rejects(
      runIdempotent(
        db,
        "owner-b",
        toolName,
        "shared-resource-key-01",
        input,
        async () => {
          authorizationChecks += 1;
          throw new Error("PROJECT_NOT_FOUND_OR_NOT_OWNED");
        },
        async () => {
          actions += 1;
          return { effectId: ++effects, ownerId: "owner-b" };
        },
      ),
      /PROJECT_NOT_FOUND_OR_NOT_OWNED/,
    );
    assert.equal(authorizationChecks, 1, toolName + " owner preflight");
    assert.equal(actions, 0, toolName + " must not return or repeat cached effect");
    assert.equal(effects, 1, toolName + " cached effect belongs to owner A");
  }
});

test("accepts valid +60 min lease completion in non-UTC timezone (Asia/Taipei) and UTC control", async () => {
  const jobsUrl = new URL("../src/jobs.ts", import.meta.url).href;

  function runLeaseCompletionHarness(tz) {
    const script = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier)
        ? specifier + ".ts"
        : specifier,
      context,
    );
  },
});

const { handleJobApi } = await import(${JSON.stringify(jobsUrl)});

class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) {
    const database = this.database;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return database.prepare(sql).get(...values) ?? null; },
      async run() {
        const info = database.prepare(sql).run(...values);
        return { meta: { changes: Number(info.changes) } };
      },
    };
  }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createEnv(db) {
  return {
    DB: new D1(db),
    PRESENTATION_RUNNER_TOKEN: "test-runner-token",
    BUCKET: {
      async head() { return { size: 10 }; },
      async put() {},
      async delete() {},
    },
  };
}

function initDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(\`
    CREATE TABLE presentation_projects (id TEXT PRIMARY KEY, title TEXT, brief TEXT, profile_id TEXT, renderer TEXT, status TEXT, target_score INTEGER, max_rounds INTEGER, source_summary TEXT, current_round INTEGER DEFAULT 0, current_score INTEGER, approved_version_id TEXT, updated_at TEXT);
    CREATE TABLE presentation_project_runtime (project_id TEXT PRIMARY KEY, last_error TEXT, blocked_reason TEXT, updated_at TEXT);
    CREATE TABLE presentation_events (id TEXT PRIMARY KEY, project_id TEXT, event_type TEXT, payload_json TEXT);
    CREATE TABLE presentation_versions (id TEXT PRIMARY KEY, project_id TEXT, version_number INTEGER, spec_json TEXT, audit_json TEXT, score INTEGER, hard_gates_pass INTEGER DEFAULT 0, origin TEXT, UNIQUE(project_id, version_number));
    CREATE TABLE presentation_version_runtime (version_id TEXT PRIMARY KEY, parent_version_id TEXT, changed_slides_json TEXT, renderer_report_json TEXT, export_report_json TEXT, r2_prefix TEXT, is_approved INTEGER DEFAULT 0);
    CREATE TABLE presentation_artifacts (id TEXT PRIMARY KEY, project_id TEXT, version_id TEXT, kind TEXT, r2_key TEXT, mime_type TEXT, byte_size INTEGER, sha256 TEXT, expires_at TEXT);
    CREATE TABLE presentation_jobs (
      id TEXT PRIMARY KEY, project_id TEXT, job_type TEXT, status TEXT, payload_json TEXT,
      attempt_count INTEGER, max_attempts INTEGER, leased_until TEXT, last_error TEXT,
      finished_at TEXT, updated_at TEXT
    );
  \`);
  return db;
}

// Case 1: complete failed job with +60 min lease
const dbFailed = initDb();
dbFailed.exec(\`
  INSERT INTO presentation_projects (id, status, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'queued', datetime('now'));
  INSERT INTO presentation_project_runtime (project_id) VALUES ('11111111-1111-1111-1111-111111111111');
  INSERT INTO presentation_jobs (id, project_id, job_type, status, payload_json, attempt_count, max_attempts, leased_until)
  VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','render','running','{}',1,3,datetime('now','+60 minutes'));
\`);
const resFailed = await handleJobApi(new Request("https://mcp.test/internal/jobs/complete", {
  method: "POST",
  headers: { authorization: "Bearer test-runner-token" },
  body: JSON.stringify({
    jobId: "22222222-2222-2222-2222-222222222222",
    attemptCount: 1,
    status: "failed",
    error: "repro",
  }),
}), createEnv(dbFailed));
const failedBody = await resFailed.json();
const failedJob = dbFailed.prepare("SELECT status, last_error FROM presentation_jobs WHERE id = ?").get("22222222-2222-2222-2222-222222222222");

// Case 2: complete succeeded job with +60 min lease
const dbSucceeded = initDb();
dbSucceeded.exec(\`
  INSERT INTO presentation_projects (id, status, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'queued', datetime('now'));
  INSERT INTO presentation_project_runtime (project_id) VALUES ('11111111-1111-1111-1111-111111111111');
  INSERT INTO presentation_jobs (id, project_id, job_type, status, payload_json, attempt_count, max_attempts, leased_until)
  VALUES ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','render','running','{}',1,3,datetime('now','+60 minutes'));
\`);
const resSucceeded = await handleJobApi(new Request("https://mcp.test/internal/jobs/complete", {
  method: "POST",
  headers: { authorization: "Bearer test-runner-token" },
  body: JSON.stringify({
    jobId: "33333333-3333-3333-3333-333333333333",
    attemptCount: 1,
    status: "succeeded",
    version: {
      spec: { slides: [] },
      audit: {},
      score: 90,
      hardGatesPass: true,
      changedSlides: [],
    },
    artifacts: [],
  }),
}), createEnv(dbSucceeded));
const succeededBody = await resSucceeded.json();
const succeededJob = dbSucceeded.prepare("SELECT status, last_error FROM presentation_jobs WHERE id = ?").get("33333333-3333-3333-3333-333333333333");

// Case 3: complete genuinely expired job (-1 min)
const dbExpired = initDb();
dbExpired.exec(\`
  INSERT INTO presentation_projects (id, status, updated_at) VALUES ('11111111-1111-1111-1111-111111111111', 'queued', datetime('now'));
  INSERT INTO presentation_project_runtime (project_id) VALUES ('11111111-1111-1111-1111-111111111111');
  INSERT INTO presentation_jobs (id, project_id, job_type, status, payload_json, attempt_count, max_attempts, leased_until)
  VALUES ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','render','running','{}',1,3,datetime('now','-1 minute'));
\`);
const resExpired = await handleJobApi(new Request("https://mcp.test/internal/jobs/complete", {
  method: "POST",
  headers: { authorization: "Bearer test-runner-token" },
  body: JSON.stringify({
    jobId: "44444444-4444-4444-4444-444444444444",
    attemptCount: 1,
    status: "failed",
    error: "should_expire",
  }),
}), createEnv(dbExpired));
const expiredBody = await resExpired.json();
const expiredJob = dbExpired.prepare("SELECT status, last_error FROM presentation_jobs WHERE id = ?").get("44444444-4444-4444-4444-444444444444");

console.log(JSON.stringify({
  failedStatus: resFailed.status,
  failedBody,
  failedJob,
  succeededStatus: resSucceeded.status,
  succeededBody,
  succeededJob,
  expiredStatus: resExpired.status,
  expiredBody,
  expiredJob,
}));
`;

    const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: script,
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, `Subprocess with TZ=${tz} failed: ${child.stderr || child.stdout}`);
    return JSON.parse(child.stdout);
  }

  for (const tz of ["Asia/Taipei", "UTC"]) {
    const result = runLeaseCompletionHarness(tz);
    assert.equal(result.failedStatus, 200, `failed completion in ${tz} must return HTTP 200`);
    assert.equal(result.failedBody.status, "failed");
    assert.equal(result.failedJob.status, "failed");
    assert.equal(result.failedJob.last_error, "repro");

    assert.equal(result.succeededStatus, 200, `succeeded completion in ${tz} must return HTTP 200`);
    assert.equal(result.succeededBody.status, "succeeded");
    assert.equal(result.succeededJob.status, "succeeded");

    assert.equal(result.expiredStatus, 409, `expired lease in ${tz} must return HTTP 409`);
    assert.equal(result.expiredBody.error, "job_lease_expired");
    assert.equal(result.expiredJob.status, "running");
  }
});
