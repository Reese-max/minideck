export function checkClaimBoundary(
  spec: unknown,
  sourceMap: unknown,
  extraContent?: unknown[],
): { pass: boolean; reason: string | null };

export function redactSensitiveClaims(sourceMap: unknown): unknown;

export function checkJudgeBoundary(
  input: { spec: unknown; sourceMap: unknown; profile?: unknown; title?: unknown; brief?: unknown; payload?: unknown },
  result: unknown,
): { pass: boolean; reason: string | null };
