import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CLAIM_QUEUED_JOB_SQL,
  JOB_COMPLETION_GUARD_SQL,
  recoverExpiredJobLeases,
  runJobCompletion,
} from "../src/job-lease.mjs";

class SqliteStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(
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
  }

  prepare(sql) {
    return new SqliteStatement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }

  row(sql, ...values) {
    const row = this.database.prepare(sql).get(...values);
    return row ? { ...row } : row;
  }

  seedJob({ id = "job-1", projectId = "project-1", attemptCount, maxAttempts, leasedUntil, projectStatus = "running" }) {
    this.database.prepare("INSERT INTO presentation_projects (id, status) VALUES (?, ?)").run(projectId, projectStatus);
    this.database.prepare("INSERT INTO presentation_project_runtime (project_id) VALUES (?)").run(projectId);
    this.database.prepare(
      "INSERT INTO presentation_jobs (id, project_id, job_type, status, attempt_count, max_attempts, leased_until) " +
        "VALUES (?, ?, 'render', 'running', ?, ?, ?)",
    ).run(id, projectId, attemptCount, maxAttempts, leasedUntil);
    return { id, project_id: projectId, job_type: "render", attempt_count: attemptCount, max_attempts: maxAttempts };
  }
}

function expiredSql(minutes = 61) {
  return "datetime('now', '-" + minutes + " minutes')";
}

test("an expired running job is requeued and its next claim increments attempts", async () => {
  const db = new SqliteD1();
  try {
    db.seedJob({ attemptCount: 1, maxAttempts: 3, leasedUntil: db.row("SELECT " + expiredSql() + " AS value").value });
    db.prepare("UPDATE presentation_jobs SET started_at = '2020-01-01 00:00:00' WHERE id = 'job-1'").run();
    const recovery = await recoverExpiredJobLeases(db, () => "event-recovery-1");
    assert.deepEqual(recovery, { requeued: 1, blocked: 0 });
    assert.deepEqual(db.row("SELECT status, attempt_count, last_error, started_at FROM presentation_jobs WHERE id = 'job-1'"), {
      status: "queued",
      attempt_count: 1,
      last_error: "job_lease_expired_requeued",
      started_at: null,
    });

    const claim = await db.prepare(CLAIM_QUEUED_JOB_SQL).bind("job-1", 1).run();
    assert.equal(claim.meta.changes, 1);
    const row = db.row("SELECT status, attempt_count, leased_until, started_at FROM presentation_jobs WHERE id = 'job-1'");
    assert.equal(row.status, "running");
    assert.equal(row.attempt_count, 2);
    assert.ok(Date.parse(row.leased_until.replace(" ", "T") + "Z") > Date.now());
    assert.ok(row.started_at > "2020-01-01");
  } finally {
    db.close();
  }
});

test("an unexpired running lease cannot be recovered or claimed by another poller", async () => {
  const db = new SqliteD1();
  try {
    db.seedJob({
      attemptCount: 1,
      maxAttempts: 3,
      leasedUntil: db.row("SELECT datetime('now', '+10 minutes') AS value").value,
    });
    assert.deepEqual(await recoverExpiredJobLeases(db, () => "unused"), { requeued: 0, blocked: 0 });
    const claim = await db.prepare(CLAIM_QUEUED_JOB_SQL).bind("job-1", 1).run();
    assert.equal(claim.meta.changes, 0);
    assert.equal(db.row("SELECT status, attempt_count FROM presentation_jobs WHERE id = 'job-1'").status, "running");
    assert.equal(db.row("SELECT COUNT(*) AS count FROM presentation_events").count, 0);
  } finally {
    db.close();
  }
});

test("expired jobs at max attempts become diagnostically blocked once", async () => {
  const db = new SqliteD1();
  try {
    db.seedJob({ attemptCount: 3, maxAttempts: 3, leasedUntil: db.row("SELECT " + expiredSql() + " AS value").value });
    assert.deepEqual(await recoverExpiredJobLeases(db, () => "event-terminal-1"), { requeued: 0, blocked: 1 });
    const job = db.row("SELECT status, attempt_count, last_error FROM presentation_jobs WHERE id = 'job-1'");
    assert.equal(job.status, "blocked");
    assert.equal(job.attempt_count, 3);
    assert.equal(job.last_error, "job_lease_expired_max_attempts_exhausted");
    assert.equal(db.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "blocked");
    const runtime = db.row("SELECT last_error, blocked_reason FROM presentation_project_runtime WHERE project_id = 'project-1'");
    assert.equal(runtime.last_error, "job_lease_expired_max_attempts_exhausted");
    assert.equal(runtime.blocked_reason, "job_lease_expired_max_attempts_exhausted");
    assert.equal(db.row("SELECT COUNT(*) AS count FROM presentation_events").count, 1);
    assert.deepEqual(await recoverExpiredJobLeases(db, () => "event-terminal-2"), { requeued: 0, blocked: 0 });
    assert.equal(db.row("SELECT COUNT(*) AS count FROM presentation_events").count, 1);
  } finally {
    db.close();
  }
});

test("a late completion from the previous attempt cannot mutate the new owner's state", async () => {
  const db = new SqliteD1();
  try {
    const oldJob = db.seedJob({ attemptCount: 1, maxAttempts: 3, leasedUntil: db.row("SELECT " + expiredSql() + " AS value").value, projectStatus: "queued" });
    await recoverExpiredJobLeases(db, () => "event-recovery-1");
    assert.equal((await db.prepare(CLAIM_QUEUED_JOB_SQL).bind(oldJob.id, 1).run()).meta.changes, 1);
    const currentJob = { ...oldJob, attempt_count: 2 };

    const staleSideEffect = db.prepare(
      "UPDATE presentation_projects SET status = 'failed' WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
    ).bind("project-1", oldJob.id, oldJob.attempt_count);
    const staleFinish = db.prepare(
      "UPDATE presentation_jobs SET status = 'failed', leased_until = NULL " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(oldJob.id, oldJob.attempt_count);
    await assert.rejects(
      runJobCompletion(db, oldJob, [staleSideEffect], staleFinish),
      /job_lease_not_current/,
    );
    assert.deepEqual(db.row("SELECT status, attempt_count FROM presentation_jobs WHERE id = 'job-1'"), {
      status: "running",
      attempt_count: 2,
    });
    assert.equal(db.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "queued");

    const currentSideEffect = db.prepare(
      "UPDATE presentation_projects SET status = 'review' WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
    ).bind("project-1", currentJob.id, currentJob.attempt_count);
    const currentFinish = db.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(currentJob.id, currentJob.attempt_count);
    await runJobCompletion(db, currentJob, [currentSideEffect], currentFinish);
    assert.deepEqual(db.row("SELECT status, attempt_count FROM presentation_jobs WHERE id = 'job-1'"), {
      status: "succeeded",
      attempt_count: 2,
    });
    assert.equal(db.row("SELECT status FROM presentation_projects WHERE id = 'project-1'").status, "review");
  } finally {
    db.close();
  }
});

test("claim and every completion path use the fenced lease primitives", async () => {
  const source = await readFile(new URL("../src/jobs.ts", import.meta.url), "utf8");
  assert.match(source, /await recoverExpiredJobLeases\(env\.DB, randomId\)/);
  assert.match(source, /prepare\(CLAIM_QUEUED_JOB_SQL\)/);
  assert.equal([...source.matchAll(/await runJobCompletion\(/g)].length, 4);
  assert.match(source, /const attemptCount = body\?\.attemptCount/);
  assert.match(source, /if \(job\.attempt_count !== attemptCount\)/);
});
