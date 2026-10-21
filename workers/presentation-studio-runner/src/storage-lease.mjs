export const CURRENT_STORAGE_ATTEMPT_SQL =
  "SELECT project_id FROM presentation_jobs " +
  "WHERE id = ? AND status = 'running' " +
  "AND leased_until > datetime('now') AND attempt_count = ?";

export function buildAttemptScopedArtifactKey(projectPrefix, jobId, attemptCount, fileName) {
  return `${projectPrefix}jobs/${jobId}/attempt-${attemptCount}/${fileName}`;
}
