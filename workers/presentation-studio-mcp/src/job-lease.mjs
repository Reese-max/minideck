export const JOB_LEASE_NOT_CURRENT = "job_lease_not_current";

export const CLAIM_QUEUED_JOB_SQL =
  "UPDATE presentation_jobs SET status = 'running', attempt_count = attempt_count + 1, " +
    "leased_until = datetime('now', '+60 minutes'), started_at = COALESCE(started_at, datetime('now')), " +
    "updated_at = datetime('now'), last_error = NULL " +
    "WHERE id = ? AND status = 'queued' AND attempt_count = ? AND attempt_count < max_attempts " +
    "AND available_at <= datetime('now') " +
    "AND (leased_until IS NULL OR leased_until <= datetime('now'))";

export const BEGIN_JOB_COMPLETION_SQL =
  "SELECT CASE WHEN EXISTS (SELECT 1 FROM presentation_jobs " +
    "WHERE id = ? AND status = 'running' AND attempt_count = ? " +
    "AND leased_until IS NOT NULL AND leased_until > datetime('now')) " +
    "THEN 1 ELSE json('job_lease_not_current') END";

export const JOB_COMPLETION_GUARD_SQL =
  "EXISTS (SELECT 1 FROM presentation_jobs AS lease_guard " +
    "WHERE lease_guard.id = ? AND lease_guard.status = 'running' " +
    "AND lease_guard.attempt_count = ?)";

const EXPIRED_MAX_ATTEMPT_GUARD_SQL =
  "EXISTS (SELECT 1 FROM presentation_jobs AS expired_guard " +
    "WHERE expired_guard.id = ? AND expired_guard.status = 'running' " +
    "AND expired_guard.attempt_count = ? " +
    "AND expired_guard.attempt_count >= expired_guard.max_attempts " +
    "AND expired_guard.leased_until IS NOT NULL " +
    "AND expired_guard.leased_until <= datetime('now'))";

export async function recoverExpiredJobLeases(db, createId) {
  // Bounded per claim: a large expired backlog drains across successive polls
  // instead of delaying this claim past the Worker time limit.
  const expired = await db.prepare(
    "SELECT id, project_id, job_type, attempt_count, max_attempts " +
      "FROM presentation_jobs WHERE status = 'running' " +
      "AND leased_until IS NOT NULL AND leased_until <= datetime('now') " +
      "ORDER BY created_at ASC LIMIT 100",
  ).all();

  let requeued = 0;
  let blocked = 0;
  for (const job of expired.results) {
    if (job.attempt_count >= job.max_attempts) {
      const reason = "job_lease_expired_max_attempts_exhausted";
      const eventPayload = JSON.stringify({
        jobId: job.id,
        jobType: job.job_type,
        status: "blocked",
        reason,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
      });
      const results = await db.batch([
        db.prepare(
          "UPDATE presentation_projects SET status = 'blocked', updated_at = datetime('now') " +
            "WHERE id = ? AND " + EXPIRED_MAX_ATTEMPT_GUARD_SQL,
        ).bind(job.project_id, job.id, job.attempt_count),
        db.prepare(
          "UPDATE presentation_project_runtime SET last_error = ?, blocked_reason = ?, " +
            "updated_at = datetime('now') WHERE project_id = ? AND " + EXPIRED_MAX_ATTEMPT_GUARD_SQL,
        ).bind(reason, reason, job.project_id, job.id, job.attempt_count),
        db.prepare(
          "INSERT INTO presentation_events (id, project_id, event_type, payload_json) " +
            "SELECT ?, ?, 'job.failed', ? WHERE " + EXPIRED_MAX_ATTEMPT_GUARD_SQL,
        ).bind(createId(), job.project_id, eventPayload, job.id, job.attempt_count),
        db.prepare(
          "UPDATE presentation_jobs SET status = 'blocked', leased_until = NULL, " +
            "finished_at = datetime('now'), updated_at = datetime('now'), last_error = ? " +
            "WHERE id = ? AND status = 'running' AND attempt_count = ? " +
            "AND attempt_count >= max_attempts AND leased_until IS NOT NULL " +
            "AND leased_until <= datetime('now')",
        ).bind(reason, job.id, job.attempt_count),
      ]);
      if (results.at(-1)?.meta?.changes === 1) blocked += 1;
      continue;
    }

    const result = await db.prepare(
      "UPDATE presentation_jobs SET status = 'queued', leased_until = NULL, " +
        "last_error = 'job_lease_expired_requeued', updated_at = datetime('now') " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ? " +
        "AND attempt_count < max_attempts AND leased_until IS NOT NULL " +
        "AND leased_until <= datetime('now')",
    ).bind(job.id, job.attempt_count).run();
    if (result.meta?.changes === 1) requeued += 1;
  }

  return { requeued, blocked };
}

export async function runJobCompletion(db, job, statements, finishStatement) {
  // A zero-row UPDATE does not abort a D1 batch. SQLite's JSON error makes
  // failed admission roll back the whole transaction before any result writes.
  // Check time once at admission; a lease ticking over inside the batch must
  // not allow only some result statements to commit.
  let results;
  try {
    results = await db.batch([
      db.prepare(BEGIN_JOB_COMPLETION_SQL).bind(job.id, job.attempt_count),
      ...statements,
      finishStatement,
    ]);
  } catch (error) {
    if (/malformed JSON/i.test([error?.message, error?.cause?.message].join(" "))) {
      throw new Error(JOB_LEASE_NOT_CURRENT, { cause: error });
    }
    throw error;
  }
  if (results.at(-1)?.meta?.changes !== 1) {
    throw new Error(JOB_LEASE_NOT_CURRENT);
  }
}
