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
    if (Array.isArray(value)) return value.some((member) => inspect(member));
    if (typeof value.claimId === "string") {
      const claim = claims.get(value.claimId);
      if (value.sensitive === true || value.sensitive === 1 || value.sensitive === "true" ||
          (claim && isSensitive(claim))) return true;
    }
    for (const [key, member] of Object.entries(value)) {
      if (sensitiveTexts.some((text) => key.includes(text))) return true;
      if (key === "sourceClaimIds") {
        if (!Array.isArray(member) || member.some((id) => {
          const claim = typeof id === "string" ? claims.get(id) : null;
          return !claim || isSensitive(claim);
        })) return true;
      } else if (key === "claims") {
        if (!Array.isArray(member)) return true;
        if (member.every((id) => typeof id === "string")) {
          if (member.some((id) => {
            const claim = claims.get(id);
            return !claim || isSensitive(claim);
          })) return true;
        } else if (!member.every(isObject) || member.some((claim) => {
          if (typeof claim.claimId !== "string") return true;
          const sourceClaim = claims.get(claim.claimId);
          return !sourceClaim || isSensitive(sourceClaim) || inspect(claim);
        })) {
          return true;
        }
      } else if (inspect(member, key)) {
        return true;
      }
    }
    return false;
  }
  // The Dashi source-map file keeps public claim records, so scan that exact
  // safe view too. Sensitive claim records are omitted because their text is
  // redacted before the file is written; duplicated sensitive text in a
  // public record or metadata must still block before any egress.
  const safeSourceMap = isObject(sourceMap) && Array.isArray(sourceMap.claims)
    ? { ...sourceMap, claims: sourceMap.claims.filter((claim) => !isObject(claim) || !isSensitive(claim)) }
    : sourceMap;
  return inspect([spec, ...extraContent, safeSourceMap]) ? BLOCKED : ALLOWED;
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
  if (!checkClaimBoundary(input.spec, input.sourceMap, [
    input.profile,
    input.title,
    input.brief,
    input.payload,
    input.sources,
  ]).pass) {
    return BLOCKED;
  }
  return checkClaimBoundary(result.version.spec, input.sourceMap);
}

export async function runWithClaimBoundary(input, operation) {
  const check = checkClaimBoundary(input?.spec, input?.sourceMap, [
    input?.profile,
    input?.title,
    input?.brief,
    input?.payload,
    input?.sources,
  ]);
  if (!check.pass) return { allowed: false, reason: check.reason };
  return { allowed: true, value: await operation() };
}

export async function runWithJudgeBoundary(input, result, operation) {
  const check = checkJudgeBoundary(input, result);
  if (!check.pass) return { allowed: false, reason: check.reason };
  return { allowed: true, value: await operation() };
}
