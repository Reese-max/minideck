import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MAX_PREVIEW_SHEETS,
  PREVIEW_TILES_PER_SHEET,
  aggregateVisualReports,
  expectedPreviewSheets,
  planVisualCoverage,
  previewArtifactsCoverSpec,
  previewSheetKind,
  previewSheetRank,
  specSlideIds,
  visualCoverageSatisfied,
} from "../workers/presentation-studio-runner/runner/visual-coverage.mjs";
import {
  specSlideIds as mcpSpecSlideIds,
  visualCoverageSatisfied as mcpVisualCoverageSatisfied,
} from "../workers/presentation-studio-mcp/src/visual-coverage.mjs";

function slideIds(count, prefix = "s") {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`,
  );
}

function screenshotNames(count, { padded = true } = {}) {
  return Array.from({ length: count }, (_, index) =>
    padded
      ? `slide-${String(index + 1).padStart(2, "0")}.png`
      : `slide-${index + 1}.png`,
  );
}

// A legal 21-slide deck must produce full coverage across two sheets.
const plan21 = planVisualCoverage(slideIds(21), screenshotNames(21));
assert.equal(plan21.complete, true);
assert.equal(plan21.slideCount, 21);
assert.equal(plan21.screenshotCount, 21);
assert.equal(plan21.sheetCount, 2);
assert.deepEqual(
  plan21.sheets.map((sheet) => sheet.kind),
  ["preview", "preview-2"],
);
assert.deepEqual(plan21.sheets[1].slideIds, ["s21"]);
assert.deepEqual(plan21.evaluatedSlideIds, slideIds(21));
assert.equal(
  visualCoverageSatisfied(plan21, slideIds(21), 21),
  true,
  "21-slide deck with complete visual evidence must satisfy coverage",
);
console.log("PASS visual coverage：21 張投影片分兩批且覆蓋完整");

// A 21-slide deck with only 20 screenshots must fail closed.
const partial = planVisualCoverage(slideIds(21), screenshotNames(20));
assert.equal(partial.complete, false);
assert.equal(partial.screenshotCount, 20);
assert.equal(partial.evaluatedSlideIds.length, 20);
assert.equal(
  visualCoverageSatisfied(partial, slideIds(21), 21),
  false,
  "uncovered slide must fail closed",
);
assert.equal(mcpVisualCoverageSatisfied(partial, slideIds(21), 21), false);
console.log("PASS visual coverage：缺少第 21 張截圖時 fail closed");

// Extra screenshots beyond the slide set also break coverage.
const extra = planVisualCoverage(slideIds(21), screenshotNames(22));
assert.equal(extra.complete, false);
assert.equal(visualCoverageSatisfied(extra, slideIds(21), 21), false);
console.log("PASS visual coverage：截圖數多於投影片數時 fail closed");

// Unpadded Dashi names still map in slide order (slide-2 before slide-10).
const natural = planVisualCoverage(
  slideIds(12),
  screenshotNames(12, { padded: false }),
);
assert.equal(natural.complete, true);
assert.deepEqual(natural.sheets[0].slideIds, slideIds(12));
assert.deepEqual(
  natural.sheets[0].fileNames[1],
  "slide-2.png",
  "numeric suffix ordering must place slide-2 before slide-10",
);
console.log("PASS visual coverage：未補零的截圖檔名仍按投影片順序對應");

// The 100-slide contract ceiling yields exactly five sheets.
const plan100 = planVisualCoverage(slideIds(100), screenshotNames(100));
assert.equal(plan100.complete, true);
assert.equal(plan100.sheetCount, MAX_PREVIEW_SHEETS);
assert.equal(plan100.sheets.length, 5);
assert.deepEqual(plan100.sheets[4].slideIds, slideIds(100).slice(80));
assert.deepEqual(plan100.sheets[4].kind, "preview-5");
console.log("PASS visual coverage：100 張投影片上限產生五批且全部涵蓋");

// The pinned renderer emits slide-01-v4.png, not slide-01.png. Bind each
// actual screenshot to its logical slide even when variant digits are present.
const dashiNames = screenshotNames(100).map(name => name.replace(".png", "-v4.png"));
const permutations = [
  dashiNames.slice().reverse(),
  [...dashiNames.filter((_, index) => index % 2), ...dashiNames.filter((_, index) => index % 2 === 0)],
];
for (const names of permutations) {
  const actualPlan = planVisualCoverage(slideIds(100), names);
  assert.equal(actualPlan.complete, true);
  assert.deepEqual(actualPlan.sheets.flatMap(sheet => sheet.fileNames), dashiNames,
    "actual Dashi variant suffix must not move slide 100 before slide 11");
  assert.deepEqual(actualPlan.sheets.flatMap(sheet => sheet.slideIds), slideIds(100));
}
const unpaddedDashi = screenshotNames(21, { padded: false }).map(name => name.replace(".png", "-v4.png"));
assert.deepEqual(planVisualCoverage(slideIds(21), unpaddedDashi.slice().reverse()).sheets.flatMap(sheet => sheet.fileNames), unpaddedDashi);
console.log("PASS visual coverage：真實 Dashi v4 檔名以 logical index 對應 21/100 張投影片");

// Two variant files of slide 1 cannot substitute for the absent slide 2.
for (const names of [
  ["slide-01-v1.png", "slide-01-v4.png"],
  ["slide-01-v4.png", "slide-03-v4.png"],
  ["slide-01-v4.png", "unmapped.png"],
]) {
  const invalid = planVisualCoverage(slideIds(2), names);
  assert.equal(invalid.complete, false, "actual Dashi names must prove one v4 image for every logical index");
  assert.equal(visualCoverageSatisfied(invalid, slideIds(2), 2), false);
}
console.log("PASS visual coverage：重複、跳號或混入未知 Dashi 截圖一律 fail closed");

// Coverage receipts must fail closed on any tampering or absence.
const tampered = { ...plan21, evaluatedSlideIds: slideIds(21).slice(0, 20).concat(["s21"]) };
tampered.evaluatedSlideIds[20] = "different-id";
assert.equal(visualCoverageSatisfied(tampered, slideIds(21), 21), false);
assert.equal(visualCoverageSatisfied(null, slideIds(21), 21), false);
assert.equal(visualCoverageSatisfied({}, slideIds(21), 21), false);
assert.equal(
  visualCoverageSatisfied({ ...plan21, slideCount: 20 }, slideIds(21), 21),
  false,
);
assert.equal(
  visualCoverageSatisfied(
    { ...plan21, evaluatedSlideIds: slideIds(20).concat(["s20"]) },
    slideIds(21),
    21,
  ),
  false,
  "duplicate evaluated ids cannot satisfy the slide set",
);
console.log("PASS visual coverage：收據缺漏、竄改或重複一律 fail closed");

// specSlideIds drops non-string ids so uncovered slides stay uncovered.
const specWithMissingId = {
  slides: slideIds(21).map((id, index) =>
    index === 20 ? { title: "no id" } : { id },
  ),
};
assert.equal(specSlideIds(specWithMissingId).length, 20);
assert.equal(mcpSpecSlideIds(specWithMissingId).length, 20);
assert.equal(
  visualCoverageSatisfied(plan21, specSlideIds(specWithMissingId), 21),
  false,
  "slide set mismatch must fail closed",
);
assert.equal(
  mcpVisualCoverageSatisfied(plan21, mcpSpecSlideIds(specWithMissingId), 21),
  false,
);
console.log("PASS visual coverage：spec 缺 id 的投影片仍視為未涵蓋");

// Batch aggregation takes the worst sheet result and keeps blocker issues.
const aggregated = aggregateVisualReports([
  { score: 92, everySlideScoreMin: 90, pass: true, issues: [] },
  {
    score: 88,
    everySlideScoreMin: 55,
    pass: false,
    issues: [{ severity: "blocker", message: "slide 21 unreadable" }],
  },
]);
assert.equal(aggregated.score, 88);
assert.equal(aggregated.everySlideScoreMin, 55);
assert.equal(aggregated.pass, false);
assert.equal(aggregated.issues.length, 1);
assert.equal(aggregated.issues[0].severity, "blocker");
assert.match(aggregated.issues[0].message, /sheet 2/);
assert.match(aggregated.issues[0].message, /slide 21 unreadable/);
console.log("PASS visual coverage：第 21 張 blocker 彙總後仍為 blocker 且不通過");

// A single-sheet deck keeps issue messages unprefixed (existing ≤20 flow).
const single = aggregateVisualReports([
  {
    score: 90,
    everySlideScoreMin: 90,
    pass: false,
    issues: [{ severity: "major", message: "density" }],
  },
]);
assert.equal(single.pass, false);
assert.equal(single.issues[0].message, "density");
console.log("PASS visual coverage：單批 deck 的 issue 訊息維持原樣");

// Sheet kind naming round-trips and stays bounded to MAX_PREVIEW_SHEETS.
assert.equal(previewSheetKind(0), "preview");
assert.equal(previewSheetKind(1), "preview-2");
assert.equal(previewSheetKind(4), "preview-5");
assert.equal(previewSheetKind(5), null);
assert.equal(previewSheetRank("preview"), 0);
assert.equal(previewSheetRank("preview-2"), 1);
assert.equal(previewSheetRank("preview-5"), MAX_PREVIEW_SHEETS - 1);
assert.equal(previewSheetRank("preview-1"), -1);
assert.equal(previewSheetRank("preview-6"), -1);
assert.equal(previewSheetRank("preview-x"), -1);
assert.equal(previewSheetRank("html"), -1);
console.log("PASS visual coverage：preview-N artifact kind 映射有界且可逆");

// The expected sheet plan is derived from the spec's slide ids, not the
// renderer's receipt: one preview artifact cannot claim deck-wide coverage.
const expected21 = expectedPreviewSheets(slideIds(21));
assert.equal(expected21.length, 2);
assert.deepEqual(expected21[0], {
  kind: "preview",
  slideIds: slideIds(20),
});
assert.deepEqual(expected21[1], { kind: "preview-2", slideIds: ["s21"] });
assert.equal(
  previewArtifactsCoverSpec(["preview", "preview-2"], slideIds(21)),
  true,
);
assert.equal(
  previewArtifactsCoverSpec(["preview"], slideIds(21)),
  false,
  "a single 20-tile sheet must not satisfy a 21-slide deck",
);
assert.equal(
  previewArtifactsCoverSpec(["preview"], slideIds(20)),
  true,
);
assert.equal(
  previewArtifactsCoverSpec(["preview", "preview-2"], slideIds(20)),
  false,
  "a 20-slide deck must not claim a second sheet",
);
assert.equal(
  previewArtifactsCoverSpec(["preview", "preview-2", "preview-3"], slideIds(21)),
  false,
  "extra sheets are rejected",
);
assert.equal(
  previewArtifactsCoverSpec(["preview-2", "preview"], slideIds(21)),
  true,
  "artifact order does not matter",
);
assert.equal(
  previewArtifactsCoverSpec(["preview", "preview-9"], slideIds(21)),
  false,
);
assert.equal(previewArtifactsCoverSpec([], slideIds(21)), false);
assert.equal(previewArtifactsCoverSpec(["preview"], []), false);
console.log("PASS visual coverage：preview artifacts 必須精確符合 spec 推導的批次計畫");

// Structural regression anchors: the sampling bug and both fail-closed gates.
const runnerJob = await readFile(
  new URL(
    "../workers/presentation-studio-runner/runner/execute-job.mjs",
    import.meta.url,
  ),
  "utf8",
);
assert.doesNotMatch(
  runnerJob,
  /\.slice\(0,\s*20\)/,
  "preview construction must not sample only the first 20 slides",
);
const judgesSource = await readFile(
  new URL(
    "../workers/presentation-studio-runner/src/judges.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(judgesSource, /VISUAL_COVERAGE_INCOMPLETE/);
assert.match(judgesSource, /VISUAL_PREVIEW_SHEETS_MISSING/);
assert.match(judgesSource, /expectedPreviewSheets/);
assert.match(judgesSource, /previewArtifactsCoverSpec/);
const approvalSource = await readFile(
  new URL(
    "../workers/presentation-studio-mcp/src/presentation.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(approvalSource, /visual_coverage_incomplete/);
console.log("PASS visual coverage：judge 與 approval 兩端皆設 fail-closed 閘門");

console.log("ALL VISUAL COVERAGE ACCEPTANCE CRITERIA PASSED");
