function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function claimIntegrityCheck(input) {
  const claims = new Map();
  for (const claim of Array.isArray(input?.sourceMap?.claims) ? input.sourceMap.claims : []) {
    if (isObject(claim) && typeof claim.claimId === "string") claims.set(claim.claimId, claim);
  }
  const failures = [];
  for (const slide of Array.isArray(input?.spec?.slides) ? input.spec.slides : []) {
    if (!isObject(slide)) continue;
    const label = typeof slide.id === "string" ? slide.id : "slide";
    for (const bindings of [slide.claims, slide.sourceClaimIds]) {
      if (bindings === undefined) continue;
      if (!Array.isArray(bindings)) {
        failures.push(`${label}: claims must be an array`);
        continue;
      }
      for (const claimId of bindings) {
        const claim = typeof claimId === "string" ? claims.get(claimId) : null;
        if (!claim) {
          failures.push(`${label}: unknown claim ${String(claimId)}`);
        } else if (claim.sensitive === true || claim.sensitive === 1 || claim.sensitive === "true") {
          failures.push(`${label}: sensitive claim ${claimId}`);
        }
      }
    }
  }
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    output: failures.length === 0 ? "all claim bindings resolve to non-sensitive source claims" : failures.join("; "),
  };
}
