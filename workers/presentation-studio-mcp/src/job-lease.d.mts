import type { JobRow } from "./types";

export declare const JOB_LEASE_NOT_CURRENT: string;
export declare const JOB_ATTEMPT_HORIZONS_SECONDS: Readonly<Record<"plan" | "render" | "revision" | "export", number>>;
export declare const RENEW_JOB_LEASE_SQL: string;
export declare const CLAIM_QUEUED_JOB_SQL: string;
export declare const BEGIN_JOB_COMPLETION_SQL: string;
export declare const JOB_COMPLETION_GUARD_SQL: string;

export declare function recoverExpiredJobLeases(
  db: D1Database,
  createId: () => string,
): Promise<{ requeued: number; blocked: number }>;

export declare function runJobCompletion(
  db: D1Database,
  job: JobRow,
  statements: D1PreparedStatement[],
  finishStatement: D1PreparedStatement,
): Promise<void>;
