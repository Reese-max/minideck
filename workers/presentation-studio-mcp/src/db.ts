import { randomId } from "./ids";
import type {
  Env,
  JobRow,
  ProfileRow,
  ProjectRow,
  ProjectRuntimeRow,
  QualityPolicy,
  VersionRow,
  VersionRuntimeRow,
} from "./types";

const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  targetScore: 90,
  minimumSlideScore: 80,
  maxRounds: 4,
  plateauRounds: 2,
  minimumImprovement: 2,
  allHardGatesRequired: true,
  userApprovalRequiredBeforeExport: true,
};

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function getSystemConfig<T>(
  db: D1Database,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await db
    .prepare("SELECT value_json FROM presentation_system_config WHERE config_key = ?")
    .bind(key)
    .first<{ value_json: string }>();
  return parseJson(row?.value_json, fallback);
}

export async function assertV2Configuration(env: Env): Promise<void> {
  const architecture = await getSystemConfig<Record<string, unknown>>(
    env.DB,
    "architecture",
    {},
  );
  const expectedVersion = env.ARCHITECTURE_VERSION ?? "2.0.0";
  if (
    architecture.version !== expectedVersion ||
    architecture.openDesignEnabled !== false ||
    architecture.renderer !== "dashi" ||
    architecture.orchestrator !== "cloudflare-workflow"
  ) {
    throw new Error(
      "SERVER_CONFIGURATION_INVALID: presentation-studio must use v2 Dashi-only configuration",
    );
  }
}

export async function getQualityPolicy(db: D1Database): Promise<QualityPolicy> {
  const value = await getSystemConfig<Partial<QualityPolicy>>(
    db,
    "quality_policy",
    {},
  );
  return {
    ...DEFAULT_QUALITY_POLICY,
    ...value,
  };
}

export async function getProfile(
  db: D1Database,
  profileId: string,
): Promise<ProfileRow> {
  const row = await db
    .prepare("SELECT * FROM presentation_profiles WHERE id = ?")
    .bind(profileId)
    .first<ProfileRow>();
  if (!row) throw new Error("PROFILE_NOT_FOUND: " + profileId);
  return row;
}

export async function getProjectForOwner(
  db: D1Database,
  projectId: string,
  ownerId: string,
): Promise<{ project: ProjectRow; runtime: ProjectRuntimeRow }> {
  const project = await db
    .prepare(
      "SELECT p.* FROM presentation_projects p " +
        "JOIN presentation_project_runtime r ON r.project_id = p.id " +
        "WHERE p.id = ? AND r.owner_id = ?",
    )
    .bind(projectId, ownerId)
    .first<ProjectRow>();
  if (!project) throw new Error("PROJECT_NOT_FOUND: " + projectId);

  const runtime = await db
    .prepare("SELECT * FROM presentation_project_runtime WHERE project_id = ?")
    .bind(projectId)
    .first<ProjectRuntimeRow>();
  if (!runtime) throw new Error("PROJECT_RUNTIME_NOT_FOUND: " + projectId);
  return { project, runtime };
}

export async function getVersionForOwner(
  db: D1Database,
  projectId: string,
  versionId: string,
  ownerId: string,
): Promise<{ version: VersionRow; runtime: VersionRuntimeRow | null }> {
  await getProjectForOwner(db, projectId, ownerId);
  const version = await db
    .prepare(
      "SELECT v.* FROM presentation_versions v " +
        "WHERE v.id = ? AND v.project_id = ?",
    )
    .bind(versionId, projectId)
    .first<VersionRow>();
  if (!version) throw new Error("VERSION_NOT_FOUND: " + versionId);

  const runtime = await db
    .prepare(
      "SELECT * FROM presentation_version_runtime WHERE version_id = ?",
    )
    .bind(versionId)
    .first<VersionRuntimeRow>();
  return { version, runtime: runtime ?? null };
}

export async function getLatestVersion(
  db: D1Database,
  projectId: string,
): Promise<{ version: VersionRow; runtime: VersionRuntimeRow | null } | null> {
  const version = await db
    .prepare(
      "SELECT * FROM presentation_versions " +
        "WHERE project_id = ? ORDER BY version_number DESC LIMIT 1",
    )
    .bind(projectId)
    .first<VersionRow>();
  if (!version) return null;
  const runtime = await db
    .prepare(
      "SELECT * FROM presentation_version_runtime WHERE version_id = ?",
    )
    .bind(version.id)
    .first<VersionRuntimeRow>();
  return { version, runtime: runtime ?? null };
}

export async function createJob(
  db: D1Database,
  projectId: string,
  jobType: string,
  payload: unknown,
  maxAttempts = 3,
): Promise<JobRow> {
  const id = randomId();
  await db
    .prepare(
      "INSERT INTO presentation_jobs " +
        "(id, project_id, job_type, status, payload_json, max_attempts) " +
        "VALUES (?, ?, ?, 'queued', ?, ?)",
    )
    .bind(id, projectId, jobType, JSON.stringify(payload), maxAttempts)
    .run();
  const job = await db
    .prepare("SELECT * FROM presentation_jobs WHERE id = ?")
    .bind(id)
    .first<JobRow>();
  if (!job) throw new Error("JOB_CREATE_FAILED");
  return job;
}

export async function appendEvent(
  db: D1Database,
  projectId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO presentation_events (id, project_id, event_type, payload_json) " +
        "VALUES (?, ?, ?, ?)",
    )
    .bind(randomId(), projectId, eventType, JSON.stringify(payload))
    .run();
}
