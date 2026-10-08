import { checkClaimBoundary } from "./claim-boundary.mjs";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSensitiveClaim(claim) {
  return isObject(claim) &&
    (claim.sensitive === true || claim.sensitive === 1 || claim.sensitive === "true");
}

export function claimTextMap(sourceMap) {
  const map = new Map();
  const seenIds = new Set();
  const duplicateIds = new Set();
  for (const claim of Array.isArray(sourceMap?.claims) ? sourceMap.claims : []) {
    if (!isObject(claim) || typeof claim.claimId !== "string") continue;
    if (seenIds.has(claim.claimId)) {
      duplicateIds.add(claim.claimId);
      map.delete(claim.claimId);
      continue;
    }
    seenIds.add(claim.claimId);
    if (!isSensitiveClaim(claim) && typeof claim.text === "string") {
      map.set(claim.claimId, claim.text);
    }
  }
  for (const claimId of duplicateIds) map.delete(claimId);
  return map;
}

export function claimIntegrityCheck(input) {
  const boundary = isObject(input)
    ? checkClaimBoundary(input.spec, input.sourceMap, [
      input.profile,
      input.title,
      input.brief,
      input.payload,
      input.sources,
    ])
    : { pass: false, reason: "CLAIM_BOUNDARY_BLOCKED" };
  return {
    exitCode: boundary.pass ? 0 : 1,
    output: boundary.pass ? "all claim bindings resolve to non-sensitive source claims" : "claim integrity failed",
  };
}

export async function runWithClaimIntegrityGate(input, operation) {
  if (claimIntegrityCheck(input).exitCode !== 0) {
    return {
      status: "blocked",
      jobId: typeof input?.jobId === "string" ? input.jobId : null,
      error: "CLAIM_INTEGRITY_FAILED",
    };
  }
  return operation();
}

export function shouldRunJudges(result) {
  return Boolean(
    isObject(result) &&
    result.status === "succeeded" &&
    isObject(result.version) &&
    isObject(result.version.audit) &&
    isObject(result.version.audit.deterministic) &&
    result.version.audit.deterministic.claimIntegrity === true
  );
}

export async function runJudgeIfIntegrityPasses(result, operation) {
  if (!shouldRunJudges(result)) return null;
  return operation();
}
