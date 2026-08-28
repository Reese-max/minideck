import {
  constantTimeEqual,
  sha256Bytes,
} from "./crypto";
import { parseJson } from "./db";
import { randomId } from "./ids";
import type { Env, JobRow, JsonObject } from "./types";

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
    const update = await env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'running', attempt_count = attempt_count + 1, " +
        "leased_until = datetime('now', '+10 minutes'), started_at = COALESCE(started_at, datetime('now')), " +
        "updated_at = datetime('now') " +
        "WHERE id = ? AND status = 'queued' " +
        "AND (leased_until IS NULL OR leased_until <= datetime('now'))",
    )
      .bind(job.id)
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
    leaseSeconds: 600,
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
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO presentation_versions " +
        "(id, project_id, version_number, spec_json, audit_json, score, hard_gates_pass, origin) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      versionId,
      job.project_id,
      versionNumber,
      JSON.stringify(versionInput.spec),
      JSON.stringify(versionInput.audit),
      versionInput.score,
      versionInput.hardGatesPass ? 1 : 0,
      versionInput.origin,
    ),
    env.DB.prepare(
      "INSERT INTO presentation_version_runtime " +
        "(version_id, parent_version_id, changed_slides_json, renderer_report_json, r2_prefix) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).bind(
      versionId,
      versionInput.parentVersionId,
      changedSlidesJson,
      runtimeReport ? JSON.stringify(runtimeReport) : null,
      r2Prefix,
    ),
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'running'",
    ).bind(job.id),
    env.DB.prepare(
      "UPDATE presentation_projects SET status = 'review', current_round = current_round + ?, " +
        "current_score = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(job.job_type === "revision" ? 1 : 0, versionInput.score, job.project_id),
    env.DB.prepare(
      "INSERT INTO presentation_events " +
        "(id, project_id, event_type, payload_json) VALUES (?, ?, 'job.completed', ?)",
    ).bind(
      randomId(),
      job.project_id,
      JSON.stringify({
        jobId: job.id,
        jobType: job.job_type,
        versionId,
        versionNumber,
        hardGatesPass: versionInput.hardGatesPass,
        score: versionInput.score,
      }),
    ),
  ]);
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
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO presentation_versions " +
        "(id, project_id, version_number, spec_json, origin) " +
        "VALUES (?, ?, ?, ?, 'planner-fallback')",
    ).bind(versionId, job.project_id, versionNumber, JSON.stringify(spec)),
    env.DB.prepare(
      "INSERT INTO presentation_version_runtime " +
        "(version_id, parent_version_id, changed_slides_json, r2_prefix) " +
        "VALUES (?, NULL, '[]', ?)",
    ).bind(versionId, projectPrefix(env, job.project_id)),
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'running'",
    ).bind(job.id),
    env.DB.prepare(
      "INSERT INTO presentation_jobs " +
        "(id, project_id, job_type, status, payload_json, max_attempts) " +
        "VALUES (?, ?, 'render', 'queued', ?, 3)",
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
    ),
    env.DB.prepare(
      "UPDATE presentation_projects SET status = 'queued', updated_at = datetime('now') " +
        "WHERE id = ?",
    ).bind(job.project_id),
    env.DB.prepare(
      "INSERT INTO presentation_events " +
        "(id, project_id, event_type, payload_json) VALUES (?, ?, 'plan.completed', ?)",
    ).bind(
      randomId(),
      job.project_id,
      JSON.stringify({ jobId: job.id, versionId, renderJobId }),
    ),
  ]);
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
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    ),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE presentation_version_runtime SET export_report_json = ? WHERE version_id = ?",
    ).bind(exportReport ? JSON.stringify(exportReport) : null, versionId),
    env.DB.prepare(
      "UPDATE presentation_jobs SET status = 'succeeded', leased_until = NULL, " +
        "finished_at = datetime('now'), updated_at = datetime('now'), last_error = NULL " +
        "WHERE id = ? AND status = 'ru