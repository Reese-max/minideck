// Approval-side mirror of the runner's visual-coverage contract. Kept as a
// separate copy because the MCP Worker must not depend on the runner package;
// test/visual-coverage.mjs pins both implementations to the same verdicts.

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Ordered unique string slide ids extracted from a stored version spec. */
export function specSlideIds(spec) {
  const slides = isObject(spec) && Array.isArray(spec.slides) ? spec.slides : [];
  return uniqueStrings(
    slides.map((slide) => (isObject(slide) ? slide.id : undefined)),
  );
}

/**
 * The recorded coverage receipt must prove the visual judge evaluated exactly
 * the version's slide set: complete flag, matching slide count, and an exact
 * id-set match on evaluatedSlideIds. Missing or partial coverage fails closed.
 */
export function visualCoverageSatisfied(coverage, expectedSlideIds, expectedSlideCount) {
  if (!isObject(coverage) || coverage.complete !== true) return false;
  const expected = uniqueStrings(expectedSlideIds);
  const slideCount = Number.isInteger(expectedSlideCount)
    ? expectedSlideCount
    : expected.length;
  if (expected.length !== slideCount || slideCount === 0) return false;
  if (coverage.slideCount !== slideCount) return false;
  const evaluated = coverage.evaluatedSlideIds;
  if (!Array.isArray(evaluated) || evaluated.length !== slideCount) return false;
  const evaluatedSet = new Set(evaluated.filter((id) => typeof id === "string"));
  if (evaluatedSet.size !== slideCount) return false;
  return expected.every((id) => evaluatedSet.has(id));
}
