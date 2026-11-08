import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = fileURLToPath(new URL("../", import.meta.url));
const script = String.raw`import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";

const source = path.resolve(process.argv[2]);
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) ? specifier + '.ts' : specifier, context);
} });
const { handleJobApi } = await import(pathToFileURL(path.join(source, 'src/jobs.ts')).href);
class D1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) {
    const sqlite = this.sqlite; let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const project = '11111111-1111-1111-1111-111111111111';
const job = '22222222-2222-2222-2222-222222222222';
const token = 'minideck32-owned-runner';
const cases = [];
function init(lease) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(path.join(source, 'migrations/0001_init.sql'), 'utf8'));
  sqlite.prepare("INSERT INTO presentation_projects (id,status,updated_at) VALUES (?,'queued',datetime('now'))").run(project);
  sqlite.prepare('INSERT INTO presentation_project_runtime (project_id) VALUES (?)').run(project);
  if (lease === 'future' || lease === 'expired') {
    sqlite.prepare("INSERT INTO presentation_jobs (id,project_id,job_type,status,payload_json,attempt_count,max_attempts,leased_until) VALUES (?,?,'render','running','{}',1,3,datetime('now',?))").run(job, project, lease === 'future' ? '+60 minutes' : '-1 minute');
  } else {
    sqlite.prepare("INSERT INTO presentation_jobs (id,project_id,job_type,status,payload_json,attempt_count,max_attempts,leased_until) VALUES (?,?,'render','running','{}',1,3,?)").run(job, project, lease);
  }
  return sqlite;
}
async function complete(sqlite, status, options = {}) {
  const body = { jobId: job, attemptCount: options.attemptCount ?? 1, status,
    ...(status === 'succeeded' ? { version: { spec: { slides: [] }, audit: {}, score: 90, hardGatesPass: true, changedSlides: [] }, artifacts: [] } : { error: 'owned timezone control' }) };
  let bucketCalls = 0;
  const response = await handleJobApi(new Request('https://owned.invalid/internal/jobs/complete', { method: 'POST', headers: { Authorization: 'Bearer ' + (options.token ?? token) }, body: JSON.stringify(body) }),
    { DB: new D1(sqlite), PRESENTATION_RUNNER_TOKEN: token, BUCKET: { async head() { bucketCalls++; return { size: 10 }; }, async put() { bucketCalls++; }, async delete() { bucketCalls++; } } });
  return { http: response.status, body: await response.json(), bucket_calls: bucketCalls };
}
function state(sqlite) {
  return { job: sqlite.prepare('SELECT status,last_error,leased_until FROM presentation_jobs WHERE id=?').get(job), project: sqlite.prepare('SELECT status FROM presentation_projects WHERE id=?').get(project), versions: sqlite.prepare('SELECT COUNT(*) AS n FROM presentation_versions').get().n, events: sqlite.prepare('SELECT COUNT(*) AS n FROM presentation_events').get().n };
}
for (const status of ['failed', 'succeeded']) {
  const sqlite = init('future');
  const sqlValid = sqlite.prepare("SELECT leased_until > datetime('now') AS valid FROM presentation_jobs WHERE id=?").get(job).valid;
  const lease = sqlite.prepare('SELECT leased_until FROM presentation_jobs WHERE id=?').get(job).leased_until;
  const first = await complete(sqlite, status); const firstState = state(sqlite); const repeat = await complete(sqlite, status); const repeatState = state(sqlite);
  cases.push({ name: 'valid-' + status, tz: process.env.TZ, offset_minutes: new Date().getTimezoneOffset(), sql_lease_valid: sqlValid, legacy_local_parse_expired: new Date(lease).getTime() <= Date.now(), first, first_state: firstState, repeat, repeated_state_identical: JSON.stringify(firstState) === JSON.stringify(repeatState) });
  sqlite.close();
}
for (const [name, lease, options] of [
  ['expired', 'expired', {}], ['wrong-attempt', 'future', { attemptCount: 2 }], ['wrong-runner', 'future', { token: 'other-owned-runner' }],
  ['calendar-rollover', '2099-02-30 00:00:00', {}], ['invalid-month', '2099-13-01 00:00:00', {}],
  ['invalid-text', 'unknown', {}], ['missing-lease', null, {}], ['noncanonical-iso', '2099-01-01T00:00:00Z', {}],
]) {
  const sqlite = init(lease); const before = state(sqlite); const result = await complete(sqlite, 'failed', options); const after = state(sqlite);
  cases.push({ name, result, unchanged: JSON.stringify(before) === JSON.stringify(after), before, after }); sqlite.close();
}
console.log(JSON.stringify({ source, tz: process.env.TZ, source_clock_override: false, actual_sqlite_actual_handleJobApi: true, real_runner_or_provider_launched: false, cases }));
`;

for (const timezone of ["Asia/Taipei", "UTC"]) {
  test("actual SQLite completion preserves UTC leases and fences in " + timezone, () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-", source], {
      input: script, env: { ...process.env, TZ: timezone }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.tz, timezone);
    assert.equal(receipt.actual_sqlite_actual_handleJobApi, true);
    assert.equal(receipt.real_runner_or_provider_launched, false);
    assert.equal(receipt.cases.length, 10);
    for (const control of receipt.cases) {
      if (control.name.startsWith("valid-")) {
        const status = control.name.slice("valid-".length);
        assert.equal(control.sql_lease_valid, 1);
        assert.equal(control.first.http, 200, control.name + " " + timezone);
        assert.equal(control.first.body.status, status);
        assert.equal(control.first_state.job.status, status);
        assert.equal(control.first.bucket_calls, 0);
        assert.equal(control.repeat.http, 409);
        assert.equal(control.repeat.body.error, "job_not_running");
        assert.equal(control.repeated_state_identical, true);
        assert.equal(control.first_state.versions, status === "succeeded" ? 1 : 0);
      } else {
        assert.equal(control.result.http, control.name === "wrong-runner" ? 401 : 409, control.name + " " + timezone);
        assert.equal(control.result.body.error, control.name === "wrong-runner" ? "runner_unauthorized" : control.name === "wrong-attempt" ? "job_lease_not_current" : "job_lease_expired");
        assert.equal(control.unchanged, true, control.name + " must not mutate durable state");
        assert.equal(control.result.bucket_calls, 0);
      }
    }
  });
}
