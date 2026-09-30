// Shared deterministic validation + application for revision spec patches.
// Planner-generated and caller-supplied patches both flow through
// applyRevisionPatch() so neither path can bypass scope, field or claim rules.

const MAX_PATCH_BYTES = 200_000;

const ALLOWED_SLIDE_KEYS = new Set([
  "id",
  "role",
  "purpose",
  "keyMessage",
  "visualIntent",
  "requiredItems",
  "priority",
  "claims",
  "sourceClaimIds",
  "content",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeClaims(sourceMap) {
  if (!isObject(sourceMap) || !Array.isArray(sourceMap.claims)) return [];
  return sourceMap.claims
    .filter((claim) => {
      if (!isObject(claim)) return false;
      return claim.sensitive !== true && claim.sensitive !== 1 && claim.sensitive !== "true";
    })
    .map((claim) => ({
      claimId: claim.claimId,
      sourceId: claim.sourceId,
      text: claim.text,
      sourceLocation: claim.sourceLocation,
    }));
}

function sourceClaimIds(sourceMap) {
  return new Set(
    safeClaims(sourceMap)
      .map((claim) => claim.claimId)
      .filter((claimId) => typeof claimId === "string"),
  );
}

export function applySlideSpecPatch(spec, patch) {
  if (!spec || !Array.isArray(spec.slides) || !Array.isArray(patch.slides)) return null;
  const patches = new Map();
  for (const slide of patch.slides) {
    if (isObject(slide) && typeof slide.id === "string") patches.set(slide.id, slide);
  }
  const slides = spec.slides.map((slide) => {
    if (!isObject(slide) || typeof slide.id !== "string") return slide;
    const update = patches.get(slide.id);
    return update ? { ...slide, ...update } : slide;
  });
  return { ...spec, slides };
}

export function normalizeRevisionPatch(value, input) {
  if (!value || !Array.isArray(value.slides) || value.slides.length === 0 || value.slides.length > 100) {
    return null;
  }
  if (!input.spec || !Array.isArray(input.spec.slides)) return null;
  const knownSlideIds = new Set(
    input.spec.slides
      .filter((slide) => isObject(slide) && typeof slide.id === "string")
      .map((slide) => String(slide.id)),
  );
  const requestedSlideIds = new Set(Array.isArray(input.changedSlides) ? input.changedSlides : []);
  const allowedClaimIds = sourceClaimIds(input.sourceMap);
  const seen = new Set();
  const slides = [];
  for (const slide of value.slides) {
    if (!isObject(slide) || typeof slide.id !== "string") return null;
    if (!knownSlideIds.has(slide.id) || seen.has(slide.id)) return null;
    if (requestedSlideIds.size > 0 && !requestedSlideIds.has(slide.id)) return null;
    if ([...Object.keys(slide)].some((key) => !ALLOWED_SLIDE_KEYS.has(key))) return null;
    for (const key of ["claims", "sourceClaimIds"]) {
      const refs = slide[key];
      if (
        refs !== undefined &&
        (!Array.isArray(refs) ||
          refs.some((claimId) => typeof claimId !== "string" || !allowedClaimIds.has(claimId)))
      ) {
        return null;
      }
    }
    seen.add(slide.id);
    slides.push(slide);
  }
  const patch = { slides };
  if (new TextEncoder().encode(JSON.stringify(patch)).byteLength > MAX_PATCH_BYTES) return null;
  return patch;
}

export function applyRevisionPatch(input, specPatch) {
  const patch = normalizeRevisionPatch(specPatch, input);
  if (!patch) return null;
  const patchedSpec = applySlideSpecPatch(input.spec, patch);
  if (!patchedSpec) return null;
  const appliedIds = new Set(patch.slides.map((slide) => slide.id));
  const changedSlides = input.spec.slides
    .filter((slide) => isObject(slide) && typeof slide.id === "string" && appliedIds.has(slide.id))
    .map((slide) => slide.id);
  return {
    ...input,
    spec: patchedSpec,
    changedSlides,
    payload: { ...input.payload, specPatch: null },
  };
}
