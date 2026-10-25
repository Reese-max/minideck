// Visual-judge coverage planning and aggregation.
//
// The deck contract allows up to 100 slides while a single contact sheet holds
// at most PREVIEW_TILES_PER_SHEET tiles. This module turns the rendered
// screenshot list plus the goal's slide ids into a batch plan and a coverage
// receipt so the Judges and the approval gate can prove that every slide was
// actually seen. Anything short of a complete 1:1 mapping fails closed.

export const PREVIEW_TILES_PER_SHEET = 20;
export const MAX_PREVIEW_SHEETS = 5; // ceil(100-slide contract / 20 tiles)

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
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

/** Ordered unique string slide ids extracted from a slide spec or goal. */
export function specSlideIds(spec) {
  const slides = isObject(spec) && Array.isArray(spec.slides) ? spec.slides : [];
  return uniqueStrings(
    slides.map((slide) => (isObject(slide) ? slide.id : undefined)),
  );
}

/**
 * Artifact kind for a contact-sheet batch: the first sheet keeps the existing
 * "preview" kind, later sheets use "preview-2".."preview-5" so the upload
 * endpoint can keep a bounded allowlist.
 */
export function previewSheetKind(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PREVIEW_SHEETS) {
    return null;
  }
  return index === 0 ? "preview" : `preview-${index + 1}`;
}

/** Inverse of previewSheetKind: -1 for non-preview kinds, else 0-based rank. */
export function previewSheetRank(kind) {
  if (kind === "preview") return 0;
  if (typeof kind !== "string") return -1;
  const match = /^preview-([2-9]\d*)$/.exec(kind);
  if (!match) return -1;
  const index = Number(match[1]) - 1;
  return index >= 1 && index < MAX_PREVIEW_SHEETS ? index : -1;
}

function screenshotSortKey(name) {
  // The pinned renderer suffix is a variant ID (v4), not the slide index.
  const match = /^slide-(\d+)(?:-v\d+)?\.png$/i.exec(name)
    || /(\d+)(?=\.png$)/i.exec(name) || /(\d+)/.exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** Deterministic slide-order sort: numeric suffix first, then name. */
export function sortScreenshotNames(names) {
  return (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === "string" && name.endsWith(".png"))
    .slice()
    .sort((a, b) => {
      const diff = screenshotSortKey(a) - screenshotSortKey(b);
      return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * The expected contact-sheet plan for a slide set, derived locally — never
 * taken from renderer-supplied receipts. Sheet i covers slide ids
 * [i*PREVIEW_TILES_PER_SHEET, (i+1)*PREVIEW_TILES_PER_SHEET).
 */
export function expectedPreviewSheets(slideIds) {
  const ids = uniqueStrings(slideIds);
  return chunk(ids, PREVIEW_TILES_PER_SHEET).map((batch, index) => ({
    kind: previewSheetKind(index),
    slideIds: batch,
  }));
}

/**
 * The uploaded preview artifact kinds must be exactly the sheets the spec
 * requires: "preview" plus "preview-2".."preview-N" with no gaps or extras.
 */
export function previewArtifactsCoverSpec(artifactKinds, slideIds) {
  const expected = expectedPreviewSheets(slideIds);
  if (expected.length === 0 || !Array.isArray(artifactKinds)) return false;
  const ranks = artifactKinds
    .map((kind) => previewSheetRank(kind))
    .sort((a, b) => a - b);
  if (ranks.length !== expected.length || ranks.some((rank) => rank < 0)) {
    return false;
  }
  return ranks.every((rank, index) => rank === index);
}

/**
 * Plans preview contact sheets and the coverage receipt.
 *
 * Screenshots map to slides by sorted position: the i-th screenshot covers
 * slideIds[i]. Coverage is complete only when every expected slide has exactly
 * one screenshot; any surplus, shortage, or missing slide id fails closed.
 */
export function planVisualCoverage(slideIds, screenshotNames) {
  const expectedSlideIds = uniqueStrings(slideIds);
  const uniqueExpected = new Set(expectedSlideIds);
  const slideCount = Array.isArray(slideIds) ? slideIds.length : 0;
  const names = sortScreenshotNames(screenshotNames);
  const dashiIndexes = names.map(name => /^slide-(\d+)-v(\d+)\.png$/i.exec(name));
  // The pinned producer emits exactly v4 for logical indices 1..N. Counts
  // alone must not allow another variant, a gap or an unrelated file to claim
  // coverage of the absent slide. Preserve the legacy generic-name fallback.
  const exactDashiIndexes = !dashiIndexes.some(Boolean) || dashiIndexes.every(
    (match, index) => match !== null && Number(match[1]) === index + 1 && Number(match[2]) === 4,
  );
  const expectedSheets = expectedPreviewSheets(expectedSlideIds);
  const sheets = chunk(names, PREVIEW_TILES_PER_SHEET).map(
    (fileNames, index) => ({
      kind: previewSheetKind(index),
      fileNames,
      slideIds: expectedSheets[index]?.slideIds ?? [],
    }),
  );
  const evaluatedSlideIds = expectedSlideIds.slice(0, names.length);
  const complete =
    slideCount > 0 &&
    slideCount === expectedSlideIds.length &&
    slideCount === uniqueExpected.size &&
    names.length === slideCount &&
    exactDashiIndexes &&
    sheets.every((sheet) => sheet.kind !== null);
  return {
    complete,
    slideCount,
    screenshotCount: names.length,
    sheetCount: sheets.length,
    expectedSlideIds,
    evaluatedSlideIds,
    sheets,
  };
}

/**
 * Approval-side check: the recorded coverage receipt must prove that the
 * evaluated slide ids are exactly the version's slide set. Used by both the
 * runner Judges gate and the MCP approval decision.
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

/**
 * Aggregates per-sheet visual judge reports into one deck-wide report: the
 * worst sheet decides score/everySlideScoreMin, any sheet failure fails the
 * deck, and issues stay attributed to their sheet.
 */
export function aggregateVisualReports(reports) {
  const list = Array.isArray(reports) ? reports : [];
  const multi = list.length > 1;
  const issues = list.flatMap((report, index) =>
    (Array.isArray(report?.issues) ? report.issues : []).map((issue) => ({
      severity: issue?.severity === "blocker" ? "blocker" : issue?.severity || "major",
      message: (multi ? `[sheet ${index + 1}/${list.length}] ` : "") +
        String(issue?.message ?? "invalid_issue").slice(0, 500),
    })),
  );
  return {
    score: list.length
      ? Math.min(...list.map((report) => Number(report?.score) || 0))
      : 0,
    everySlideScoreMin: list.length
      ? Math.min(...list.map((report) => Number(report?.everySlideScoreMin) || 0))
      : 0,
    pass: list.length > 0 && list.every((report) => report?.pass === true),
    issues,
  };
}
