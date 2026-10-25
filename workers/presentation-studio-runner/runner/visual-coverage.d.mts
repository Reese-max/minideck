export const PREVIEW_TILES_PER_SHEET: number;
export const MAX_PREVIEW_SHEETS: number;

export interface VisualCoverageSheet {
  kind: string | null;
  fileNames: string[];
  slideIds: string[];
}

export interface VisualCoverageReceipt {
  complete: boolean;
  slideCount: number;
  screenshotCount: number;
  sheetCount: number;
  expectedSlideIds: string[];
  evaluatedSlideIds: string[];
  sheets: VisualCoverageSheet[];
}

export interface VisualJudgeIssue {
  severity: string;
  message: string;
}

export interface VisualJudgeReport {
  score: number;
  everySlideScoreMin: number;
  pass: boolean;
  issues: VisualJudgeIssue[];
}

export function specSlideIds(spec: unknown): string[];
export function previewSheetKind(index: number): string | null;
export function previewSheetRank(kind: unknown): number;
export function sortScreenshotNames(names: unknown): string[];
export function expectedPreviewSheets(
  slideIds: unknown,
): Array<{ kind: string | null; slideIds: string[] }>;
export function previewArtifactsCoverSpec(
  artifactKinds: unknown,
  slideIds: unknown,
): boolean;
export function planVisualCoverage(
  slideIds: unknown,
  screenshotNames: unknown,
): VisualCoverageReceipt;
export function visualCoverageSatisfied(
  coverage: unknown,
  expectedSlideIds: unknown,
  expectedSlideCount: number,
): boolean;
export function aggregateVisualReports(reports: unknown): VisualJudgeReport;
