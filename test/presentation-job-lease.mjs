import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CLAIM_QUEUED_JOB_SQL,
  JOB_COMPLETION_GUARD_SQL,
  recoverExpiredJobLeases,
  runJobCompletion,
} from "../workers/presentation-studio-mcp/src/job-lease.mjs";

// D1 mock over node:sqlite (同 test/persona-historical-scope.mjs 的模式)
function createJobD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE presentation_jobs (" +
      "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_type TEXT NOT NULL, " +
      "status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', " +
      "attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, " +
      "available_at TEXT NOT NULL DEFAULT (datetime('now')), leased_until TEXT, " +
      "started_at TEXT, finished_at TEXT, last_error TEXT, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), " +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now')));" +
      "CREATE TABLE presentation_projects (" +
      "id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT);" +
      "CREATE TABLE presentation_project_runtime (" +
      "project_id TEXT PRIMARY KEY, last_error TEXT, blocked_reason TEXT, updated_at TEXT);" +
      "CREATE TABLE presentation_events (" +
      "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL);",
  );
  return {
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...bound) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...bound) };
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
          return { meta: { changes: Number(info.changes) } };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    row(sql, ...values) {
      return db.prepare(sql).get(...values);
    },
    seedJob({ id = "job-1", projectId = "project-1", attemptCount, maxAttempts, leasedUntil }) {
      db.prepare("INSERT INTO presentation_projects (id, status) VALUES (?, 'running')").run(projectId);
      db.prepare("INSERT INTO presentation_project_runtime (project_id) VALUES (?)").run(projectId);
      db.prepare(
        "INSERT INTO presentation_jobs (id, project_id, job_type, status, attempt_count, max_attempts, leased_until) " +
          "VALUES (?, ?, 'render', 'running', ?, ?, ?)",
      ).run(id, projectId, attemptCount, maxAttempts, leasedUntil);
      return { id, project_id: projectId, job_type: "render", attempt_count: attemptCount };
    },
  };
}

const expired = (d1) => d1.row("SELECT datetime('now', '-61 minutes') AS value").value;

// AC1: workflow create 失敗後未 complete — lease 到期可重新 claim 且 attempt_count 遞增
{
  const d1 = createJobD1();
  d1.seedJob({ attemptCount: 1, maxAttempts: 3, leasedUntil: expired(d1) });
  const recovery = await recoverExpiredJobLeases(d1, () => "evt-1");
  assert.deepEqual(recovery, { requeued: 1, blocked: 0 });
  assert.equal(d1.row("SELECT status FROM presentation_jobs WHERE id = 'job-1'").status, "queued");
  assert.equal(
    d1.row("SELECT last_error FROM presentation_jobs WHERE id = 'job-1'").last_error,
    "job_lease_expired_requeued",
  );
  const claim = await d1.prepare(CLAIM_QUEUED_JOB_SQL).bind("job-1", 1).run();
  assert.equal(claim.meta.changes, 1);
  const row = d1.row("SELECT status, attempt_count FROM presentation_jobs WHERE id = 'job-1'");
  assert.equal(row.status, "running");
  assert.equal(row.attempt_count, 2);
  console.log("PASS 過期 running job 重新排隊且再次 claim 時 attempt_count 遞增");
}

// AC2: 未到期的 running job 不得被第二個 poller 搶走
{
  const d1 = createJobD1();
  d1.seedJob({
    attemptCount: 1,
    maxAttempts: 3,
    leasedUntil: d1.row("SELECT datetime('now', '+10 minutes') AS value").value,
  });
  assert.deepEqual(await recoverExpiredJobLeases(d1, () => "unused"), { requeued: 0, blocked: 0 });
  const claim = await d1.prepare(CLAIM_QUEUED_JOB_SQL).bind("job-1", 1).run();
  assert.equal(claim.meta.changes, 0);
  assert.equal(d1.row("SELECT status FROM presentation_jobs WHERE id = 'job-1'").status, "running");
  console.log("PASS 未到期 running job 不會被重複 claim 或回收");
}

// AC3: 已達 max_attempts 的過期 job 進入 blocked 終態並留下可診斷原因
{
  const d1 = createJobD1();
  d1.seedJob({ attemptCount: 3, maxAttempts: 3, leasedUntil: expired(d1) });
  assert.deepEqual(await recoverExpiredJobLeases(d1, () => "evt-terminal"), { requeued: 0, blocked: 1 });
  assert.equal(d1.row("SELECT status FROM presentation_jobs WHERE id = 'job-1'").status, "blocked");
  assert.equal(
    d1.row("SELECT last_error FROM presentation_jobs WHERE id = 'job-1'").last_error,
    "job_lease_expired_max_attempts_exhausted",
  );
  assert.equal(d1.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "blocked");
  assert.equal(
    d1.row("SELECT blocked_reason FROM presentation_project_runtime WHERE project_id = 'project-1'").blocked_reason,
    "job_lease_expired_max_attempts_exhausted",
  );
  assert.equal(d1.row("SELECT COUNT(*) AS count FROM presentation_events").count, 1);
  assert.deepEqual(await recoverExpiredJobLeases(d1, () => "evt-again"), { requeued: 0, blocked: 0 });
  console.log("PASS 達 max_attempts 的過期 job 進入 blocked 並留下診斷原因且不重複處理");
}

// AC4: 舊 claimant 遲到回報不得覆寫新 owner 的結果
{
  const d1 = createJobD1();
  const oldJob = d1.seedJob({ attemptCount: 1, maxAttempts: 3, leasedUntil: expired(d1) });
  await recoverExpiredJobLeases(d1, () => "evt-recovery");
  assert.equal((await d1.prepare(CLAIM_QUEUED_JOB_SQL).bind("job-1", 1).run()).meta.changes, 1);

  const staleSideEffect = d1.prepare(
    "UPDATE presentation_projects SET status = 'failed' WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
  ).bind("project-1", oldJob.id, oldJob.attempt_count);
  const staleFinish = d1.prepare(
    "UPDATE presentation_jobs SET status = 'failed', leased_until = NULL " +
      "WHERE id = ? AND status = 'running' AND attempt_count = ?",
  ).bind(oldJob.id, oldJob.attempt_count);
  await assert.rejects(runJobCompletion(d1, oldJob, [staleSideEffect], staleFinish), /job_lease_not_current/);
  assert.equal(d1.row("SELECT status FROM presentation_jobs WHERE id = 'job-1'").status, "running");
  assert.equal(d1.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "running");

  const currentJob = { ...oldJob, attempt_count: 2 };
  const currentSideEffect = d1.prepare(
    "UPDATE presentation_projects SET status = 'review' WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
  ).bind("project-1", currentJob.id, currentJob.attempt_count);
  const currentFinish = d1.prepare(
    "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL " +
      "WHERE id = ? AND status = 'running' AND attempt_count = ?",
  ).bind(currentJob.id, currentJob.attempt_count);
  await runJobCompletion(d1, currentJob, [currentSideEffect], currentFinish);
  assert.equal(d1.row("SELECT status FROM presentation_jobs WHERE id = 'job-1'").status, "succeeded");
  assert.equal(d1.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "review");
  console.log("PASS 舊 claimant 遲到回報被拒且新 owner 結果不被覆寫");
}
