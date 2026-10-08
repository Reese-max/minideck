export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ARCHITECTURE_VERSION?: string;
  DEFAULT_PROFILE_ID?: string;
  R2_PREFIX?: string;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_ALLOWED_HOSTNAMES?: string;
  MCP_ALLOWED_ORIGINS?: string;
  PRESENTATION_RUNNER_TOKEN?: string;
  PRESENTATION_RUNNER_STATUS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export type JsonObject = Record<string, unknown>;

export interface AuthPrincipal {
  ownerId: string;
  scopes: string[];
}

export interface ProjectRow {
  id: string;
  title: string;
  brief: string;
  profile_id: string;
  renderer: string;
  status: string;
  target_score: number;
  max_rounds: number;
  current_round: number;
  current_score: number | null;
  approved_version_id: string | null;
  source_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRuntimeRow {
  project_id: string;
  owner_id: string;
  workflow_run_id: string | null;
  random_seed: string | null;
  design_direction: string | null;
  requested_formats_json: string;
  last_error: string | null;
  blocked_reason: string | null;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  project_id: string;
  version_number: number;
  spec_json: string;
  audit_json: string | null;
  score: number | null;
  hard_gates_pass: number;
  origin: string;
  created_at: string;
}

export interface VersionRuntimeRow {
  version_id: string;
  parent_version_id: string | null;
  changed_slides_json: string;
  renderer_report_json: string | null;
  export_report_json: string | null;
  r2_prefix: string | null;
  is_approved: number;
}

export interface ProfileRow {
  id: string;
  name: string;
  description: string;
  design_markdown: string;
  quality_json: string;
  renderer_binding_json: string;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  project_id: string;
  file_name: string;
  mime_type: string;
  r2_key: string;
  parsed_text_r2_key: string | null;
  sha256: string | null;
  byte_size: number | null;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  project_id: string;
  source_id: string;
  claim_text: string;
  source_location: string;
  confidence: number;
  sensitive: number;
  status: string;
  created_at: string;
}

export interface JobRow {
  id: string;
  project_id: string;
  job_type: string;
  status: string;
  payload_json: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  leased_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueRow {
  id: string;
  project_id: string;
  version_id: string;
  slide_id: string | null;
  severity: string;
  category: string;
  hard_gate: number;
  message: string;
  recommendation: string | null;
  fingerprint: string;
  status: string;
  first_seen_round: number;
  last_seen_round: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  version_id: string | null;
  kind: string;
  r2_key: string;
  mime_type: string;
  byte_size: number | null;
  sha256: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface QualityPolicy {
  targetScore: number;
  minimumSlideScore: number;
  maxRounds: number;
  plateauRounds: number;
  minimumImprovement: number;
  allHardGatesRequired: boolean;
  userApprovalRequiredBeforeExport: boolean;
}

export interface AuditSummary {
  allHardGatesPass?: boolean;
  judgesComplete?: boolean;
  visualJudgePass?: boolean;
  factualJudgePass?: boolean;
  totalScore?: number;
  everySlideScoreMin?: number;
  blockerCount?: number;
  majorIssueCount?: number;
  slideScores?: Array<{ slideId?: string; score?: number }>;
  visualCoverage?: {
    complete?: boolean;
    slideCount?: number;
    screenshotCount?: number;
    sheetCount?: number;
    expectedSlideIds?: string[];
    evaluatedSlideIds?: string[];
  };
}
