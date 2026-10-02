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
  const claims = new Map();
  const duplicateIds = new Set();
  for (const claim of Array.isArray(input?.sourceMap?.claims) ? input.sourceMap.claims : []) {
    if (!isObject(claim) || typeof claim.claimId !== "string") continue;
    if (claims.has(claim.claimId)) duplicateIds.add(claim.claimId);
    else claims.set(claim.claimId, claim);
  }
  let failed = !isObject(input);
  for (const slide of Array.isArray(input?.spec?.slides) ? input.spec.slides : []) {
    if (!isObject(slide)) continue;
    const slideClaims = slide.claims === undefined ? slide.sourceClaimIds : slide.claims;
    if (slideClaims === undefined) continue;
    if (!Array.isArray(slideClaims)) {
      failed = true;
      continue;
    }
    for (const claimId of slideClaims) {
      const claim = typeof claimId === "string" ? claims.get(claimId) : null;
      if (!claim || duplicateIds.has(claimId) || isSensitiveClaim(claim)) failed = true;
    }
  }
  return {
    exitCode: failed ? 1 : 0,
    output: failed ? "claim integrity failed" : "all claim bindings resolve to non-sensitive source claims",
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
