export type JobType = "plan" | "render" | "revision" | "export";

export interface JsonObject {
  [key: string]: unknown;
}

export interface ClaimedJob {
  id: string;
  projectId: string;
  type: JobType;
  payload: JsonObject;
  attemptCount: number;
  maxAttempts: number;
  leasedUntil: string | null;
  profileId: string;
  renderer: string;
  projectStatus: string;
}

export interface SourceInput {
  sourceId: string;
  fileName: string;
  mimeType: string;
  r2Key: string;
  byteSize: number;
  sha256: string | null;
}

export interface ProfileInput {
  id: string;
  designGuidelines: string;
  qualityPolicy: JsonObject;
  rendererBinding: JsonObject;
}

export interface DashiJobInput {
  jobId: string;
  projectId: string;
  type: JobType;
  title: string;
  brief: string;
  workflowRunId: string | null;
  randomSeed: string | null;
  profile: ProfileInput;
  spec: JsonObject | null;
  sourceMap: JsonObject;
  sources: SourceInput[];
  payload: JsonObject;
  parentVersionId: string | null;
  changedSlides: string[];
  requestedFormats: string[];
}

export interface UploadedArtifact {
  kind: string;
  r2Key: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface DashiAudit {
  schemaVersion: "2.0.0";
  allHardGatesPass: boolean;
  totalScore: number;
  everySlideScoreMin: number;
  blockerCount: number;
  majorIssueCount: number;
  judgesComplete: boolean;
  visualJudgePass: boolean;
  factualJudgePass: boolean;
  deterministic: {
    scaffoldOrSpec: boolean;
    claimIntegrity: boolean;
    render: boolean;
    swiss: boolean;
    copy: boolean;
    variantQuality: boolean;
    export?: boolean;
  };
  visualJudge: { status: "not_configured" | "passed" | "failed"; issues: string[] };
  factualJudge: { status: "not_configured" | "passed" | "failed"; issues: string[] };
  visualCoverage?: {
    complete: boolean;
    slideCount: number;
    screenshotCount: number;
    sheetCount: number;
    expectedSlideIds: string[];
    evaluatedSlideIds: string[];
    sheets?: Array<{ kind: string | null; slideIds: string[] }>;
  };
  evidence: Array<{ check: string; passed: boolean; detail: string }>;
  blockedReason?: string;
}

export interface DashiJobResult {
  status: "succeeded" | "blocked";
  jobId: string;
  slideSpec?: JsonObject;
  version?: {
    spec: JsonObject;
    audit: DashiAudit;
    score: number;
    hardGatesPass: boolean;
    changedSlides: string[];
    parentVersionId: string | null;
    origin: string;
  };
  artifacts?: UploadedArtifact[];
  rendererReport?: JsonObject;
  exportReport?: JsonObject;
  error?: string;
}

export interface WorkflowParams {
  job: ClaimedJob;
}

export type RunnerEnv = Env &
  Required<Pick<Env, "DB" | "BUCKET" | "DASHI_CONTAINER" | "MCP_SERVICE" | "PRESENTATION_WORKFLOW">> & {
    PRESENTATION_RUNNER_TOKEN?: string;
    R2_PREFIX?: string;
    MAX_CLAIM_BATCH?: string;
    CF_AI_ROUTER_URL?: string;
    CF_AI_ROUTER_MODEL?: string;
    CF_AI_ROUTER_API_KEY?: string;
  };
