const BLOCKED = { pass: false, reason: "CLAIM_BOUNDARY_BLOCKED" };
const ALLOWED = { pass: true, reason: null };

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSensitive(claim) {
  return claim.sensitive === true || claim.sensitive === 1 || claim.sensitive === "true";
}

/** Reject unknown or sensitive claim bindings and literal sensitive claim text. */
export function checkClaimBoundary(spec, sourceMap, extraContent = []) {
  const claims = new Map();
  const sensitiveTexts = [];
  for (const claim of Array.isArray(sourceMap?.claims) ? sourceMap.claims : []) {
    if (!isObject(claim) || typeof claim.claimId !== "string" || claims.has(claim.claimId)) {
      return BLOCKED;
    }
    claims.set(claim.claimId, claim);
    if (isSensitive(claim) && typeof claim.text === "string" && claim.text.length > 0) {
      sensitiveTexts.push(claim.text);
    }
  }

  const seen = new Set();
  function inspect(value) {
    if (typeof value === "string") {
      return sensitiveTexts.some((text) => value.includes(text));
    }
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(inspect);
    for (const [key, member] of Object.entries(value)) {
      if (key === "claims" || key === "sourceClaimIds") {
        if (!Array.isArray(member) || member.some((id) => {
          const claim = typeof id === "string" ? claims.get(id) : null;
          return !claim || isSensitive(claim);
        })) return true;
      } else if (inspect(member)) {
        return true;
      }
    }
    return false;
  }
  return inspect([spec, ...extraContent]) ? BLOCKED : ALLOWED;
}

/** Keep IDs for binding checks without carrying sensitive claim text into Dashi. */
export function redactSensitiveClaims(sourceMap) {
  if (!isObject(sourceMap) || !Array.isArray(sourceMap.claims)) return sourceMap;
  return {
    ...sourceMap,
    claims: sourceMap.claims.map((claim) => isObject(claim) && isSensitive(claim)
      ? { claimId: claim.claimId, sensitive: true }
      : claim),
  };
}

/** Apply the same boundary to authored and rendered specs before either Judge. */
export function checkJudgeBoundary(input, result) {
  if (result?.status !== "succeeded" || !result.version ||
      !isObject(input?.spec) || !isObject(result.version.spec) ||
      result.version.audit?.deterministic?.claimIntegrity !== true) return BLOCKED;
  if (!checkClaimBoundary(input.spec, input.sourceMap, [input.profile, input.title, input.brief, input.payload]).pass) {
    return BLOCKED;
  }
  return checkClaimBoundary(result.version.spec, input.sourceMap);
}
