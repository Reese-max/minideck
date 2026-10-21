export function checkClaimBoundary(
  spec: unknown,
  sourceMap: unknown,
  extraContent?: unknown[],
): { pass: boolean; reason: string | null };

export function redactSensitiveClaims(sourceMap: unknown): unknown;

export function checkJudgeBoundary(
  input: { spec: unknown; sourceMap: unknown; profile?: unknown; title?: unknown; brief?: unknown; payload?: unknown; sources?: unknown },
  result: unknown,
): { pass: boolean; reason: string | null };

export function runWithClaimBoundary<T>(
  input: { spec?: unknown; sourceMap?: unknown; profile?: unknown; title?: unknown; brief?: unknown; payload?: unknown; sources?: unknown },
  operation: () => T | Promise<T>,
): Promise<{ allowed: true; value: T } | { allowed: false; reason: string | null }>;

export function runWithJudgeBoundary<T>(
  input: { spec: unknown; sourceMap: unknown; profile?: unknown; title?: unknown; brief?: unknown; payload?: unknown; sources?: unknown },
  result: unknown,
  operation: () => T | Promise<T>,
): Promise<{ allowed: true; value: T } | { allowed: false; reason: string | null }>;
