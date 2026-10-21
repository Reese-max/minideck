export interface ClaimIntegrityCheck {
  exitCode: 0 | 1;
  output: string;
}

export interface IntegrityBlockedResult {
  status: "blocked";
  jobId: string | null;
  error: "CLAIM_INTEGRITY_FAILED";
}

export function isSensitiveClaim(claim: unknown): boolean;
export function claimTextMap(sourceMap: unknown): Map<string, string>;
export function claimIntegrityCheck(input: unknown): ClaimIntegrityCheck;
export function runWithClaimIntegrityGate<T>(
  input: unknown,
  operation: () => T | Promise<T>,
): Promise<T | IntegrityBlockedResult>;
export function shouldRunJudges(result: unknown): boolean;
export function runJudgeIfIntegrityPasses<T>(
  result: unknown,
  operation: () => T | Promise<T>,
): Promise<T | null>;
