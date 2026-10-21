export declare const CURRENT_STORAGE_ATTEMPT_SQL: string;

export declare function buildAttemptScopedArtifactKey(
  projectPrefix: string,
  jobId: string,
  attemptCount: number,
  fileName: string,
): string;
