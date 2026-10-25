-- Baseline schema for the presentation-studio D1 database.
--
-- The production database predates migration tracking; this file is the
-- canonical baseline derived from the tested schema contract. Apply with
-- `wrangler d1 migrations apply presentation-studio` from this directory.
-- CREATE TABLE IF NOT EXISTS keeps application idempotent on a database that
-- was provisioned before this file existed.

CREATE TABLE IF NOT EXISTS presentation_system_config (
  config_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presentation_profiles (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  design_markdown TEXT,
  quality_json TEXT,
  renderer_binding_json TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  tool_name TEXT,
  request_hash TEXT,
  result_json TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_projects (
  id TEXT PRIMARY KEY,
  title TEXT,
  brief TEXT,
  profile_id TEXT,
  renderer TEXT,
  status TEXT,
  target_score INTEGER,
  max_rounds INTEGER,
  current_round INTEGER DEFAULT 0,
  current_score INTEGER,
  approved_version_id TEXT,
  source_summary TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_project_runtime (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT,
  workflow_run_id TEXT,
  random_seed TEXT,
  design_direction TEXT,
  requested_formats_json TEXT,
  last_error TEXT,
  blocked_reason TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  version_number INTEGER,
  spec_json TEXT,
  audit_json TEXT,
  score INTEGER,
  hard_gates_pass INTEGER DEFAULT 0,
  origin TEXT,
  created_at TEXT,
  UNIQUE (project_id, version_number)
);

CREATE TABLE IF NOT EXISTS presentation_version_runtime (
  version_id TEXT PRIMARY KEY,
  parent_version_id TEXT,
  changed_slides_json TEXT,
  renderer_report_json TEXT,
  export_report_json TEXT,
  r2_prefix TEXT,
  is_approved INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presentation_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  r2_key TEXT,
  parsed_text_r2_key TEXT,
  sha256 TEXT,
  byte_size INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  source_id TEXT,
  claim_text TEXT,
  source_location TEXT,
  confidence REAL,
  sensitive INTEGER,
  status TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  version_id TEXT,
  slide_id TEXT,
  severity TEXT,
  category TEXT,
  hard_gate INTEGER,
  message TEXT,
  recommendation TEXT,
  fingerprint TEXT,
  status TEXT,
  first_seen_round INTEGER,
  last_seen_round INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  version_id TEXT,
  kind TEXT,
  r2_key TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  expires_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  event_type TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS presentation_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  version_id TEXT,
  decision TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS presentation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  leased_until TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS presentation_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT
);

CREATE TABLE IF NOT EXISTS presentation_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT,
  redirect_uri TEXT,
  code_challenge TEXT,
  owner_login TEXT,
  expires_at TEXT,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  redirect_uri TEXT,
  downstream_state TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  github_state_hash TEXT,
  expires_at TEXT,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_oauth_tokens (
  access_token_hash TEXT PRIMARY KEY,
  refresh_token_hash TEXT UNIQUE,
  owner_login TEXT,
  scopes_json TEXT,
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_pending_actions (
  code TEXT PRIMARY KEY,
  project_id TEXT,
  action TEXT,
  params_json TEXT,
  expires_at TEXT,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS presentation_profile_memory (
  source_project_id TEXT PRIMARY KEY,
  memory_json TEXT,
  updated_at TEXT
);
