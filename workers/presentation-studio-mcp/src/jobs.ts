import {
  constantTimeEqual,
  sha256Bytes,
} from "./crypto";
import { parseJson } from "./db";
import { randomId } from "./ids";
import type { Env, JobRow, JsonObject } from "./types";
import {
  CLAIM_QUEUED_JOB_SQL,
  JOB_COMPLETION_GUARD_SQL,
  JOB_LEASE_NOT_CURRENT,
  recoverExpiredJobLeases,
  runJobCompletion,
} from "./job-lease.mjs";

const JOB_TYPES = ["plan", "render", "revision", "export"] as const;
const MAX_RESULT_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const MAX_ERROR_LENGTH = 4_000;
const MAX_JSON_BYTES = 1_000_000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(request: Request): Promise<JsonObject | null> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!Number.isFinite(Number.parseInt(contentLength, 10)) ||
      Number.parseInt(contentLength, 10) > MAX_RESULT_BYTES)
  ) {
    return null;
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) return null;
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function projectPrefix(env: Env, projectId: string): string {
  const configured = env.R2_PREFIX?.trim() || "presentation-studio/";
  const prefix = configured.endsWith("/") ? configured : configured + "/";
  return prefix + "projects/" + projectId + "/";
}

function jobTypes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > JOB_TYPES.length) return null;
  const values = value.filter((item): item is string => typeof item === "string");
  if (values.length !== value.length) return null;
  return [...new Set(values)].filter((item) =>
    (JOB_TYPES as readonly string[]).includes(item),
  ).length === values.length
    ? values
    : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export function parseUtcDate(value: unknown): number {
  // Lease writers and the SQL fence use SQLite's canonical UTC second precision.
  // Reject other spellings and calendar rollover instead of normalizing invalid lease data.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return NaN;
  }
  const utc = value.replace(" ", "T") + "Z";
  const timestamp = Date.parse(utc);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === utc.replace("Z", ".000Z")
    ? timestamp
    : NaN;
}

function jobPayload(job: JobRow): JsonObject {
  return parseJson<JsonObject>(job.payload_json, {});
}

function runnerUnauthorized(): Response {
  return jsonResponse({ error: "runner_unauthorized" }, 401);
}

export async function authenticateRunner(
  request: Request,
  env: Env,
): Promise<boolean> {
  const expected = env.PRESENTATION_RUNNER_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !match[1] || match[1].length > 512) return false;
  try {
    const expectedHash = await sha256Bytes(expected);
    const actualHash = await sha256Bytes(match[1].trim());
    return constantTimeEqual(expectedHash, actualHash);
  } catch {
    return false;
  }
}

async function claimJobs(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const requestedTypes = jobTypes(body?.jobTypes);
  const limitValue = body?.limit === undefined ? 5 : body.limit;
  if (
    !requestedTypes ||
    typeof limitValue !== "number" ||
    !Number.isInteger(limitValue) ||
    limitValue < 1 ||
    limitValue > 10
  ) {
    return jsonResponse({ error: "invalid_claim_request" }, 400);
  }

  await recoverExpiredJobLeases(env.DB, randomId);

  const typeClause =
    requestedTypes.length > 0
      ? " AND job_type IN (" + requestedTypes.map(() => "?").join(",") + ")"
      : "";
  const query = await env.DB.prepare(
    "SELECT * FROM presentation_jobs " +
      "WHERE status = 'queued' " +
      "AND available_at <= datetime('now') " +
      "AND (leased_until IS NULL OR leased_until <= datetime('now')) " +
      "AND attempt_count < max_attempts" +
      typeClause +
      " ORDER BY created_at ASC LIMIT ?",
  )
    .bind(...requestedTypes, limitValue)
    .all<JobRow>();

  const claimedIds: string[] = [];
  for (const job of query.results) {
    const update = await env.DB.prepare(CLAIM_QUEUED_JOB_SQL)
      .bind(job.id, job.attempt_count)
      .run();
    if (update.meta.changes === 1) claimedIds.push(job.id);
  }

  if (claimedIds.length === 0) {
    return jsonResponse({ status: "ok", jobs: [] });
  }
  const placeholders = claimedIds.map(() => "?").join(",");
  const claimed = await env.DB.prepare(
    "SELECT j.*, p.profile_id, p.renderer, p.status AS project_status " +
      "FROM presentation_jobs j JOIN presentation_projects p ON p.id = j.project_id " +
      "WHERE j.id IN (" + placeholders + ") ORDER BY j.created_at ASC",
  )
    .bind(...claimedIds)
    .all<JobRow & {
      profile_id: string;
      renderer: string;
      project_status: string;
    }>();

  return jsonResponse({
    status: "ok",
    leaseSeconds: 3600,
    jobs: claimed.results.map((job) => ({
      id: job.id,
      projectId: job.project_id,
      type: job.job_type,
      payload: jobPayload(job),
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      leasedUntil: job.leased_until,
      profileId: job.profile_id,
      renderer: job.renderer,
      projectStatus: job.project_status,
    })),
  });
}

function validateVersionInput(
  value: unknown,
): { spec: JsonObject; audit: JsonObject; score: number | null; hardGatesPass: boolean; changedSlides: string[]; parentVersionId: string | null; origin: string } | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.spec) || !isRecord(value.audit)) return null;
  if (jsonSize(value.spec) > MAX_JSON_BYTES || jsonSize(value.audit) > MAX_JSON_BYTES) {
    return null;
  }
  const score = value.score === null ? null : value.score;
  if (
    score !== null &&
    (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100)
  ) {
    return null;
  }
  if (typeof value.hardGatesPass !== "boolean") return null;
  const changedSlides = value.changedSlides === undefined ? [] : value.changedSlides;
  if (
    !Array.isArray(changedSlides) ||
    changedSlides.length > 100 ||
    changedSlides.some((slide) => typeof slide !== "string" || slide.length > 128)
  ) {
    return null;
  }
  const parentVersionId =
    value.parentVersionId === null || value.parentVersionId === undefined
      ? null
      : value.parentVersionId;
  if (parentVersionId !== null && !isUuid(parentVersionId)) return null;
  const origin = value.origin === undefined ? "runner" : value.origin;
  if (typeof origin !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(origin)) return null;
  return {
    spec: value.spec,
    audit: value.audit,
    score,
    hardGatesPass: value.hardGatesPass,
    changedSlides,
    parentVersionId,
    origin,
  };
}

async function completeRenderJob(
  env: Env,
  job: JobRow,
  body: JsonObject,
): Promise<{ versionId: string; versionNumber: number }> {
  const versionInput = validateVersionInput(body.version);
  if (!versionInput) throw new Error("invalid_version_result");
  if (versionInput.parentVersionId) {
    const parent = await env.DB.prepare(
      "SELECT id FROM presentation_versions WHERE id = ? AND project_id = ?",
    )
      .bind(versionInput.parentVersionId, job.project_id)
      .first<{ id: string }>();
    if (!parent) throw new Error("parent_version_not_found");
  }
  const maxVersion = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) AS version_number " +
      "FROM presentation_versions WHERE project_id = ?",
  )
    .bind(job.project_id)
    .first<{ version_number: number }>();
  const versionNumber = (maxVersion?.version_number || 0) + 1;
  const versionId = randomId();
  const runtimeReport = isRecord(body.rendererReport) ? body.rendererReport : null;
  const changedSlidesJson = JSON.stringify(versionInput.changedSlides);
  const r2Prefix = projectPrefix(env, job.project_id);
  const artifactRows: Array<{
    id: string;
    key: string;
    kind: string;
    mimeType: string;
    size: number;
    sha256: string | null;
  }> = [];
  if (body.artifacts !== undefined) {
    if (!Array.isArray(body.artifacts) || body.artifacts.length > MAX_ARTIFACTS) {
      throw new Error("invalid_render_artifacts");
    }
    const allowedMimeTypes = new Set([
      "text/html",
      "application/json",
      "image/png",
    ]);
    for (const artifact of body.artifacts) {
      if (!isRecord(artifact)) throw new Error("invalid_render_artifact");
      const key = artifact.r2Key;
      const kind = artifact.kind;
      const mimeType = artifact.mimeType;
      if (
        typeof key !== "string" ||
        !key.startsWith(r2Prefix + "jobs/" + job.id + "/") ||
        typeof kind !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,64}$/.test(kind) ||
        typeof mimeType !== "string" ||
        !allowedMimeTypes.has(mimeType)
      ) {
        throw new Error("invalid_render_artifact_metadata");
      }
      const object = await env.BUCKET.head(key);
      if (!object) throw new Error("render_artifact_not_found: " + kind);
      artifactRows.push({
        id: randomId(),
        key,
        kind,
        mimeType,
        size: object.size,
        sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
      });
    }
  }
  await runJobCompletion(
    env.DB,
    job,
    [
      env.DB.prepare(
        "INSERT INTO presentation_versions " +
          "(id, project_id, version_number, spec_json, audit_json, score, hard_gates_pass, origin) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        versionId,
        job.project_id,
        versionNumber,
        JSON.stringify(versionInput.spec),
        JSON.stringify(versionInput.audit),
        versionInput.score,
        versionInput.hardGatesPass ? 1 : 0,
        versionInput.origin,
        job.id,
        job.attempt_count,
      ),
      env.DB.prepare(
        "INSERT INTO presentation_version_runtime " +
          "(version_id, parent_version_id, changed_slides_json, renderer_report_json, r2_prefix) " +
          "SELECT ?, ?, ?, ?, ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        versionId,
        versionInput.parentVersionId,
        changedSlidesJson,
        runtimeReport ? JSON.stringify(runtimeReport) : null,
        r2Prefix,
        job.id,
        job.attempt_count,
      ),
      ...artifactRows.map((artifact) =>
        env.DB.prepare(
          "INSERT INTO presentation_artifacts " +
            "(id, project_id, version_id, kind, r2_key, mime_type, byte_size, sha256) " +
            "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE " + JOB_COMPLETION_GUARD_SQL,
        ).bind(
          artifact.id,
          job.project_id,
          versionId,
          artifact.kind,
          artifact.key,
          artifact.mimeType,
          artifact.size,
          artifact.sha256,
          job.id,
          job.attempt_count,
        ),
      ),
      env.DB.prepare(
        "UPDATE presentation_projects SET status = 'review', current_round = current_round + ?, " +
          "current_score = ?, updated_at = datetime('now') WHERE id = ? AND " +
          JOB_COMPLETION_GUARD_SQL,
      ).bind(
        job.job_type === "revision" ? 1 : 0,
        versionInput.score,
        job.project_id,
        job.id,
        job.attempt_count,
      ),
      env.DB.prepare(
        "INSERT INTO presentation_events " +
          "(id, project_id, event_type, payload_json) " +
          "SELECT ?, ?, 'job.completed', ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        randomId(),
        job.project_id,
        JSON.stringify({
          jobId: job.id,
          jobType: job.job_type,
          versionId,
          versionNumber,
          artifactCount: artifactRows.length,
          hardGatesPass: versionInput.hardGatesPass,
          score: versionInput.score,
        }),
        job.id,
        job.attempt_count,
      ),
    ],
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(job.id, job.attempt_count),
  );
  return { versionId, versionNumber };
}

async function completePlanJob(
  env: Env,
  job: JobRow,
  body: JsonObject,
): Promise<{ versionId: string; versionNumber: number; renderJobId: string }> {
  if (!isRecord(body.slideSpec) || jsonSize(body.slideSpec) > MAX_JSON_BYTES) {
    throw new Error("invalid_slide_spec_result");
  }
  const slides = body.slideSpec.slides;
  if (
    !Array.isArray(slides) ||
    slides.length === 0 ||
    slides.length > 100 ||
    slides.some(
      (slide) =>
        !isRecord(slide) ||
        typeof slide.id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(slide.id),
    )
  ) {
    throw new Error("invalid_slide_spec_result");
  }
  const payload = jobPayload(job);
  const profileId = typeof payload.profileId === "string" ? payload.profileId : null;
  const spec = {
    ...body.slideSpec,
    schemaVersion: "2.0.0",
    ...(profileId && typeof body.slideSpec.profileId !== "string"
      ? { profileId }
      : {}),
  };
  const maxVersion = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) AS version_number " +
      "FROM presentation_versions WHERE project_id = ?",
  )
    .bind(job.project_id)
    .first<{ version_number: number }>();
  const versionNumber = (maxVersion?.version_number || 0) + 1;
  const versionId = randomId();
  const renderJobId = randomId();
  await runJobCompletion(
    env.DB,
    job,
    [
      env.DB.prepare(
        "INSERT INTO presentation_versions " +
          "(id, project_id, version_number, spec_json, origin) " +
          "SELECT ?, ?, ?, ?, 'planner-fallback' WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(versionId, job.project_id, versionNumber, JSON.stringify(spec), job.id, job.attempt_count),
      env.DB.prepare(
        "INSERT INTO presentation_version_runtime " +
          "(version_id, parent_version_id, changed_slides_json, r2_prefix) " +
          "SELECT ?, NULL, '[]', ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(versionId, projectPrefix(env, job.project_id), job.id, job.attempt_count),
      env.DB.prepare(
        "INSERT INTO presentation_jobs " +
          "(id, project_id, job_type, status, payload_json, max_attempts) " +
          "SELECT ?, ?, 'render', 'queued', ?, 3 WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        renderJobId,
        job.project_id,
        JSON.stringify({
          mode: "validate-and-render",
          profileId,
          parentVersionId: versionId,
          requestedFormats: payload.requestedFormats || ["pptx"],
          plannedFromJobId: job.id,
        }),
        job.id,
        job.attempt_count,
      ),
      env.DB.prepare(
        "UPDATE presentation_projects SET status = 'queued', updated_at = datetime('now') " +
          "WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
      ).bind(job.project_id, job.id, job.attempt_count),
      env.DB.prepare(
        "INSERT INTO presentation_events " +
          "(id, project_id, event_type, payload_json) " +
          "SELECT ?, ?, 'plan.completed', ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        randomId(),
        job.project_id,
        JSON.stringify({ jobId: job.id, versionId, renderJobId }),
        job.id,
        job.attempt_count,
      ),
    ],
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(job.id, job.attempt_count),
  );
  return { versionId, versionNumber, renderJobId };
}

async function completeExportJob(
  env: Env,
  job: JobRow,
  body: JsonObject,
): Promise<{ artifactIds: string[] }> {
  const payload = jobPayload(job);
  const versionId = payload.versionId;
  if (!isUuid(versionId)) throw new Error("export_version_missing");
  const version = await env.DB.prepare(
    "SELECT id FROM presentation_versions WHERE id = ? AND project_id = ?",
  )
    .bind(versionId, job.project_id)
    .first<{ id: string }>();
  if (!version) throw new Error("export_version_not_found");

  const artifacts = body.artifacts;
  if (
    !Array.isArray(artifacts) ||
    artifacts.length === 0 ||
    artifacts.length > MAX_ARTIFACTS
  ) {
    throw new Error("invalid_export_artifacts");
  }
  const artifactRows: Array<{
    id: string;
    key: string;
    kind: string;
    mimeType: string;
    size: number;
    sha256: string | null;
    expiresAt: string | null;
  }> = [];
  const prefix = projectPrefix(env, job.project_id);
  const allowedMimeTypes = new Set([
    "text/html",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/json",
    "image/png",
  ]);
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) throw new Error("invalid_export_artifact");
    const key = artifact.r2Key;
    const kind = artifact.kind;
    const mimeType = artifact.mimeType;
    if (
      typeof key !== "string" ||
      !key.startsWith(prefix) ||
      typeof kind !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,64}$/.test(kind) ||
      typeof mimeType !== "string" ||
      !allowedMimeTypes.has(mimeType)
    ) {
      throw new Error("invalid_export_artifact_metadata");
    }
    const object = await env.BUCKET.head(key);
    if (!object) throw new Error("export_artifact_not_found: " + kind);
    artifactRows.push({
      id: randomId(),
      key,
      kind,
      mimeType,
      size: object.size,
      sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
      expiresAt: typeof artifact.expiresAt === "string" ? artifact.expiresAt : null,
    });
  }
  const exportReport = isRecord(body.exportReport) ? body.exportReport : null;
  const statements: D1PreparedStatement[] = artifactRows.map((artifact) =>
    env.DB.prepare(
      "INSERT INTO presentation_artifacts " +
        "(id, project_id, version_id, kind, r2_key, mime_type, byte_size, sha256, expires_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + JOB_COMPLETION_GUARD_SQL,
    ).bind(
      artifact.id,
      job.project_id,
      versionId,
      artifact.kind,
      artifact.key,
      artifact.mimeType,
      artifact.size,
      artifact.sha256,
      artifact.expiresAt,
      job.id,
      job.attempt_count,
    ),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE presentation_version_runtime SET export_report_json = ? WHERE version_id = ? AND " +
        JOB_COMPLETION_GUARD_SQL,
    ).bind(exportReport ? JSON.stringify(exportReport) : null, versionId, job.id, job.attempt_count),
    env.DB.prepare(
      "UPDATE presentation_projects SET status = 'exported', updated_at = datetime('now') " +
        "WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
    ).bind(job.project_id, job.id, job.attempt_count),
    env.DB.prepare(
      "INSERT INTO presentation_events " +
        "(id, project_id, event_type, payload_json) " +
        "SELECT ?, ?, 'job.completed', ? WHERE " + JOB_COMPLETION_GUARD_SQL,
    ).bind(
      randomId(),
      job.project_id,
      JSON.stringify({
        jobId: job.id,
        jobType: job.job_type,
        versionId,
        artifactCount: artifactRows.length,
      }),
      job.id,
      job.attempt_count,
    ),
  );
  await runJobCompletion(
    env.DB,
    job,
    statements,
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(job.id, job.attempt_count),
  );
  return { artifactIds: artifactRows.map((artifact) => artifact.id) };
}

async function completeTerminalJob(
  env: Env,
  job: JobRow,
  status: "failed" | "blocked",
  errorMessage: string,
): Promise<void> {
  const message = errorMessage.slice(0, MAX_ERROR_LENGTH);
  await runJobCompletion(
    env.DB,
    job,
    [
      env.DB.prepare(
        "UPDATE presentation_projects SET status = ?, updated_at = datetime('now') " +
          "WHERE id = ? AND " + JOB_COMPLETION_GUARD_SQL,
      ).bind(status === "blocked" ? "blocked" : "failed", job.project_id, job.id, job.attempt_count),
      env.DB.prepare(
        "UPDATE presentation_project_runtime SET last_error = ?, blocked_reason = ?, " +
          "updated_at = datetime('now') WHERE project_id = ? AND " + JOB_COMPLETION_GUARD_SQL,
      ).bind(message, status === "blocked" ? message : null, job.project_id, job.id, job.attempt_count),
      env.DB.prepare(
        "INSERT INTO presentation_events " +
          "(id, project_id, event_type, payload_json) " +
          "SELECT ?, ?, 'job.failed', ? WHERE " + JOB_COMPLETION_GUARD_SQL,
      ).bind(
        randomId(),
        job.project_id,
        JSON.stringify({ jobId: job.id, jobType: job.job_type, status, message }),
        job.id,
        job.attempt_count,
      ),
    ],
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = ?, leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = ? " +
        "WHERE id = ? AND status = 'running' AND attempt_count = ?",
    ).bind(status, message, job.id, job.attempt_count),
  );
}

async function completeJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_complete_request" }, 400);
  const jobId = body?.jobId;
  const status = body?.status;
  const attemptCount = body?.attemptCount;
  if (
    !isUuid(jobId) ||
    typeof attemptCount !== "number" ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 1 ||
    typeof status !== "string" ||
    (status !== "succeeded" && status !== "failed" && status !== "blocked")
  ) {
    return jsonResponse({ error: "invalid_complete_request" }, 400);
  }
  const job = await env.DB.prepare(
    "SELECT * FROM presentation_jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<JobRow>();
  if (!job) return jsonResponse({ error: "job_not_found" }, 404);
  if (job.attempt_count !== attemptCount) {
    return jsonResponse({ error: JOB_LEASE_NOT_CURRENT }, 409);
  }
  if (job.status !== "running") {
    return jsonResponse({ error: "job_not_running", status: job.status }, 409);
  }
  const leaseExpiresAt = job.leased_until ? parseUtcDate(job.leased_until) : NaN;
  if (
    !job.leased_until ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= Date.now()
  ) {
    return jsonResponse({ error: "job_lease_expired" }, 409);
  }

  try {
    if (status === "succeeded") {
      if (job.job_type === "plan") {
        const plan = await completePlanJob(env, job, body);
        return jsonResponse({ status, jobId, ...plan });
      }
      if (job.job_type === "render" || job.job_type === "revision") {
        const version = await completeRenderJob(env, job, body);
        return jsonResponse({ status, jobId, ...version });
      }
      if (job.job_type === "export") {
        const exportResult = await completeExportJob(env, job, body);
        return jsonResponse({ status, jobId, ...exportResult });
      }
      return jsonResponse({ error: "job_type_not_supported" }, 409);
    }

    const errorMessage =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : "runner_reported_" + status;
    await completeTerminalJob(env, job, status, errorMessage);
    return jsonResponse({ status, jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (message === JOB_LEASE_NOT_CURRENT) {
      return jsonResponse({ error: JOB_LEASE_NOT_CURRENT }, 409);
    }
    return jsonResponse(
      {
        error: "job_completion_rejected",
        message,
      },
      400,
    );
  }
}

export async function handleJobApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/jobs/")) return null;
  if (!(await authenticateRunner(request, env))) return runnerUnauthorized();
  if (url.pathname === "/internal/jobs/claim" && request.method === "POST") {
    return claimJobs(request, env);
  }
  if (url.pathname === "/internal/jobs/complete" && request.method === "POST") {
    return completeJob(request, env);
  }
  return jsonResponse({ error: "not_found" }, 404);
}
