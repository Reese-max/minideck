import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  decodeBase64,
  randomToken,
  safePathSegment,
  sha256Hex,
} from "./crypto";
import {
  assertV2Configuration,
  getLatestVersion,
  getProfile,
  getProjectForOwner,
  getQualityPolicy,
  getVersionForOwner,
  parseJson,
} from "./db";
import { runIdempotent, stableStringify } from "./idempotency.mjs";
import { randomId, randomSeed, randomWorkflowRunId } from "./ids";
import { specSlideIds, visualCoverageSatisfied } from "./visual-coverage.mjs";
import type {
  ArtifactRow,
  AuditSummary,
  ClaimRow,
  Env,
  IssueRow,
  JsonObject,
  ProjectRow,
  SourceRow,
  VersionRow,
  VersionRuntimeRow,
} from "./types";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SLIDES = 100;
const MAX_CLAIMS = 500;
const SOURCE_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

const sourceSchema = z
  .object({
    sourceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    fileName: z.string().min(1).max(240),
    mimeType: z.string().min(1).max(160),
    contentText: z.string().max(4_000_000).optional(),
    contentBase64: z.string().max(12_000_000).optional(),
  })
  .strict();

const claimSchema = z
  .object({
    claimId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    text: z.string().min(1).max(4_000),
    sourceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    sourceLocation: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

const createInputSchema = {
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(20_000),
  profileId: z.string().min(1).max(120).optional(),
  slideSpec: jsonObjectSchema.optional(),
  sources: z.array(sourceSchema).max(20).optional(),
  claims: z.array(claimSchema).max(MAX_CLAIMS).optional(),
  sourceSummary: z.string().max(2_000).optional(),
  requestedFormats: z
    .array(z.enum(["html", "pptx", "pdf"]))
    .min(1)
    .max(3)
    .optional(),
  targetScore: z.number().int().min(0).max(100).optional(),
  maxRounds: z.number().int().min(1).max(10).optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
};

const getInputSchema = {
  projectId: z.string().uuid(),
  include: z.enum(["summary", "full"]).optional(),
};

const revisionInputSchema = {
  projectId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  slideIds: z.array(z.string().min(1).max(128)).max(MAX_SLIDES).optional(),
  instruction: z.string().min(1).max(4_000),
  specPatch: jsonObjectSchema.optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
};

const compareInputSchema = {
  projectId: z.string().uuid(),
  fromVersionId: z.string().uuid(),
  toVersionId: z.string().uuid(),
};

const approveInputSchema = {
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  note: z.string().max(2_000).optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
};

const exportInputSchema = {
  projectId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  formats: z.array(z.enum(["html", "pptx", "pdf"])).min(1).max(3).optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
};

const deleteInputSchema = {
  projectId: z.string().uuid(),
  confirmationCode: z.string().min(8).max(64).optional(),
};

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function withoutKey<T extends { idempotencyKey?: string }>(value: T): Omit<T, "idempotencyKey"> {
  const copy = { ...value };
  delete copy.idempotencyKey;
  return copy;
}

function projectPrefix(env: Env, projectId: string): string {
  const configured = env.R2_PREFIX?.trim() || "presentation-studio/";
  const prefix = configured.endsWith("/") ? configured : configured + "/";
  return prefix + "projects/" + projectId + "/";
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function assertJsonSize(value: unknown, maxBytes: number, label: string): void {
  if (jsonBytes(value).byteLength > maxBytes) {
    throw new Error(label + "_TOO_LARGE");
  }
}

function sourceBytes(
  source: z.infer<typeof sourceSchema>,
): { bytes: Uint8Array; contentType: string } {
  if (source.contentText !== undefined && source.contentBase64 !== undefined) {
    throw new Error("SOURCE_CONTENT_AMBIGUOUS: provide contentText or contentBase64, not both");
  }
  if (source.contentText !== undefined) {
    return {
      bytes: new TextEncoder().encode(source.contentText),
      contentType: source.mimeType,
    };
  }
  if (source.contentBase64 !== undefined) {
    try {
      return {
        bytes: decodeBase64(source.contentBase64),
        contentType: source.mimeType,
      };
    } catch {
      throw new Error("SOURCE_BASE64_INVALID: " + source.sourceId);
    }
  }
  throw new Error(
    "SOURCE_CONTENT_REQUIRED: Phase A requires contentText or contentBase64 for " +
      source.sourceId,
  );
}

function assertSourceType(mimeType: string): void {
  if (!SOURCE_MIME_TYPES.has(mimeType.toLowerCase())) {
    throw new Error("SOURCE_MIME_UNSUPPORTED: " + mimeType);
  }
}

function normalizeSpec(
  slideSpec: JsonObject | undefined,
  profileId: string,
): JsonObject | null {
  if (!slideSpec) return null;
  const slides = slideSpec.slides;
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > MAX_SLIDES) {
    throw new Error("INVALID_PRESENTATION_SPEC: slides must be a non-empty array of at most 100 items");
  }
  const seen = new Set<string>();
  for (const slide of slides) {
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) {
      throw new Error("INVALID_PRESENTATION_SPEC: every slide must be an object");
    }
    const id = (slide as Record<string, unknown>).id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
      throw new Error("INVALID_PRESENTATION_SPEC: each slide needs a stable id");
    }
    if (seen.has(id)) throw new Error("INVALID_PRESENTATION_SPEC: duplicate slide id " + id);
    seen.add(id);
  }
  return {
    ...slideSpec,
    schemaVersion: "2.0.0",
    profileId,
  };
}

function validateClaims(
  sources: Array<z.infer<typeof sourceSchema>>,
  claims: Array<z.infer<typeof claimSchema>>,
): void {
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (claimIds.has(claim.claimId)) {
      throw new Error("DUPLICATE_CLAIM_ID: " + claim.claimId);
    }
    claimIds.add(claim.claimId);
    if (!sourceIds.has(claim.sourceId)) {
      throw new Error(
        "CLAIM_SOURCE_NOT_FOUND: " + claim.claimId + " -> " + claim.sourceId,
      );
    }
  }
}

async function putSourceObjects(
  env: Env,
  projectId: string,
  sources: Array<z.infer<typeof sourceSchema>>,
): Promise<{
  rows: Array<{
    id: string;
    externalId: string;
    fileName: string;
    mimeType: string;
    r2Key: string;
    parsedTextR2Key: string | null;
    sha256: string;
    byteSize: number;
  }>;
  keys: string[];
  totalBytes: number;
}> {
  const prefix = projectPrefix(env, projectId);
  const rows: Array<{
    id: string;
    externalId: string;
    fileName: string;
    mimeType: string;
    r2Key: string;
    parsedTextR2Key: string | null;
    sha256: string;
    byteSize: number;
  }> = [];
  const keys: string[] = [];
  let totalBytes = 0;

  for (const source of sources) {
    assertSourceType(source.mimeType);
    const content = sourceBytes(source);
    if (content.bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error("SOURCE_TOO_LARGE: " + source.sourceId);
    }
    totalBytes += content.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error("TOTAL_SOURCE_BYTES_EXCEEDED");
    }

    const safeName = safePathSegment(source.fileName, source.sourceId);
    const key = prefix + "sources/" + safePathSegment(source.sourceId) + "/" + safeName;
    await env.BUCKET.put(key, content.bytes, {
      httpMetadata: { contentType: content.contentType },
    });
    keys.push(key);
    rows.push({
      id: projectId + ":" + source.sourceId,
      externalId: source.sourceId,
      fileName: source.fileName,
      mimeType: source.mimeType,
      r2Key: key,
      parsedTextR2Key:
        source.contentText !== undefined ? key : null,
      sha256: await sha256Hex(content.bytes),
      byteSize: content.bytes.byteLength,
    });
  }
  return { rows, keys, totalBytes };
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await env.BUCKET.delete(keys);
}

function sourceMapPayload(
  projectId: string,
  sources: Array<{
    id: string;
    externalId: string;
    fileName: string;
    mimeType: string;
    r2Key: string;
    parsedTextR2Key: string | null;
    sha256: string;
    byteSize: number;
  }>,
  claims: Array<z.infer<typeof claimSchema>>,
): JsonObject {
  return {
    schemaVersion: "1.0.0",
    projectId,
    sources: sources.map((source) => ({
      sourceId: source.externalId,
      fileName: source.fileName,
      mimeType: source.mimeType,
      r2Key: source.r2Key,
      parsedTextR2Key: source.parsedTextR2Key,
      sha256: source.sha256,
      byteSize: source.byteSize,
    })),
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      text: claim.text,
      sourceId: claim.sourceId,
      sourceLocation: claim.sourceLocation,
      confidence: claim.confidence ?? 1,
      sensitive: claim.sensitive ?? false,
    })),
  };
}

async function createPresentation(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof createInputSchema>>,
): Promise<unknown> {
  await assertV2Configuration(env);
  const profileId = input.profileId || env.DEFAULT_PROFILE_ID || "cpu-police-academic-v1";
  await getProfile(env.DB, profileId);
  const sources = input.sources || [];
  const claims = input.claims || [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) {
      throw new Error("DUPLICATE_SOURCE_ID: " + source.sourceId);
    }
    sourceIds.add(source.sourceId);
  }
  validateClaims(sources, claims);
  assertJsonSize(input.slideSpec || null, 1_000_000, "SLIDE_SPEC");
  const spec = normalizeSpec(input.slideSpec, profileId);
  const projectId = randomId();
  const workflowRunId = randomWorkflowRunId();
  const seed = randomSeed();
  const requestedFormats = input.requestedFormats || ["pptx"];
  const targetScore = input.targetScore ?? 90;
  const maxRounds = input.maxRounds ?? 4;
  const projectStatus = spec ? "queued" : "awaiting_spec";
  const projectJobType = spec ? "render" : "plan";
  const jobId = randomId();
  const sourceMapKey = projectPrefix(env, projectId) + "source-map.json";
  const sourceMapArtifactId = randomId();
  const versionId = spec ? randomId() : null;
  const versionRuntimeId = versionId;
  const uploadedKeys: string[] = [];

  try {
    const uploaded = await putSourceObjects(env, projectId, sources);
    uploadedKeys.push(...uploaded.keys);
    const sourceMap = sourceMapPayload(projectId, uploaded.rows, claims);
    const sourceMapBytes = jsonBytes(sourceMap);
    await env.BUCKET.put(sourceMapKey, sourceMapBytes, {
      httpMetadata: { contentType: "application/json" },
    });
    uploadedKeys.push(sourceMapKey);

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        "INSERT INTO presentation_projects " +
          "(id, title, brief, profile_id, renderer, status, target_score, max_rounds, source_summary) " +
          "VALUES (?, ?, ?, ?, 'dashi', ?, ?, ?, ?)",
      ).bind(
        projectId,
        input.title,
        input.brief,
        profileId,
        projectStatus,
        targetScore,
        maxRounds,
        input.sourceSummary || null,
      ),
      env.DB.prepare(
        "INSERT INTO presentation_project_runtime " +
          "(project_id, owner_id, workflow_run_id, random_seed, requested_formats_json) " +
          "VALUES (?, ?, ?, ?, ?)",
      ).bind(
        projectId,
        ownerId,
        workflowRunId,
        seed,
        JSON.stringify(requestedFormats),
      ),
    ];

    if (versionId && spec) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO presentation_versions " +
            "(id, project_id, version_number, spec_json, origin) " +
            "VALUES (?, ?, 1, ?, 'initial')",
        ).bind(versionId, projectId, JSON.stringify(spec)),
        env.DB.prepare(
          "INSERT INTO presentation_version_runtime " +
            "(version_id, parent_version_id, changed_slides_json, r2_prefix) " +
            "VALUES (?, NULL, '[]', ?)",
        ).bind(versionRuntimeId, projectPrefix(env, projectId)),
      );
    }

    for (const source of uploaded.rows) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO presentation_sources " +
            "(id, project_id, file_name, mime_type, r2_key, parsed_text_r2_key, sha256, byte_size) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          source.id,
          projectId,
          source.fileName,
          source.mimeType,
          source.r2Key,
          source.parsedTextR2Key,
          source.sha256,
          source.byteSize,
        ),
      );
    }

    for (const claim of claims) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO presentation_claims " +
            "(id, project_id, source_id, claim_text, source_location, confidence, sensitive) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          projectId + ":" + claim.claimId,
          projectId,
          projectId + ":" + claim.sourceId,
          claim.text,
          claim.sourceLocation,
          claim.confidence ?? 1,
          claim.sensitive ? 1 : 0,
        ),
      );
    }

    statements.push(
      env.DB.prepare(
        "INSERT INTO presentation_artifacts " +
          "(id, project_id, version_id, kind, r2_key, mime_type, byte_size, sha256) " +
          "VALUES (?, ?, NULL, 'source-map', ?, 'application/json', ?, ?)",
      ).bind(
        sourceMapArtifactId,
        projectId,
        sourceMapKey,
        sourceMapBytes.byteLength,
        await sha256Hex(sourceMapBytes),
      ),
      env.DB.prepare(
        "INSERT INTO presentation_events " +
          "(id, project_id, event_type, payload_json) VALUES (?, ?, 'project.created', ?)",
      ).bind(
        randomId(),
        projectId,
        JSON.stringify({
          ownerId,
          profileId,
          sourceCount: sources.length,
          claimCount: claims.length,
          specProvided: Boolean(spec),
          openDesignEnabled: false,
          renderer: "dashi",
        }),
      ),
      env.DB.prepare(
        "INSERT INTO presentation_jobs " +
          "(id, project_id, job_type, status, payload_json, max_attempts) " +
          "VALUES (?, ?, ?, 'queued', ?, 3)",
      ).bind(
        jobId,
        projectId,
        projectJobType,
        JSON.stringify({
          mode: spec ? "validate-and-render" : "backend-planner-fallback",
          profileId,
          workflowRunId,
          randomSeed: seed,
          specVersion: spec ? "2.0.0" : null,
          parentVersionId: versionId,
          requestedFormats,
        }),
      ),
    );
    await env.DB.batch(statements);
  } catch (error) {
    await deleteKeys(env, uploadedKeys).catch(() => undefined);
    throw error;
  }

  return {
    projectId,
    workflowRunId,
    status: projectStatus,
    jobId,
    jobType: projectJobType,
    versionId,
    profileId,
    renderer: "dashi",
    openDesignEnabled: false,
    requestedFormats,
    sourceCount: sources.length,
    claimCount: claims.length,
    sourceMapKey,
    next: spec
      ? "get_presentation"
      : "get_presentation; optional planner fallback requires CF_AI_ROUTER_API_KEY",
  };
}

async function listProfiles(env: Env): Promise<unknown> {
  const rows = await env.DB.prepare(
    "SELECT id, name, description, design_markdown, quality_json, " +
      "renderer_binding_json, updated_at FROM presentation_profiles ORDER BY id",
  ).all<{
    id: string;
    name: string;
    description: string;
    design_markdown: string;
    quality_json: string;
    renderer_binding_json: string;
    updated_at: string;
  }>();
  return {
    version: "2.0.0",
    renderer: "dashi",
    openDesignEnabled: false,
    profiles: rows.results.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      quality: parseJson(profile.quality_json, {}),
      dashiBinding: parseJson(profile.renderer_binding_json, {}),
      designGuidelines: profile.design_markdown,
      updatedAt: profile.updated_at,
    })),
  };
}

async function getSourcesAndClaims(
  env: Env,
  projectId: string,
): Promise<{ sources: SourceRow[]; claims: ClaimRow[] }> {
  const [sources, claims] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM presentation_sources WHERE project_id = ? ORDER BY created_at, id",
    ).bind(projectId).all<SourceRow>(),
    env.DB.prepare(
      "SELECT * FROM presentation_claims WHERE project_id = ? ORDER BY created_at, id",
    ).bind(projectId).all<ClaimRow>(),
  ]);
  return { sources: sources.results, claims: claims.results };
}

function versionSummary(
  version: VersionRow | null,
  runtime: VersionRuntimeRow | null,
  full: boolean,
): unknown {
  if (!version) return null;
  return {
    id: version.id,
    versionNumber: version.version_number,
    origin: version.origin,
    score: version.score,
    hardGatesPass: version.hard_gates_pass === 1,
    createdAt: version.created_at,
    audit: parseJson(version.audit_json, null),
    runtime: runtime
      ? {
          parentVersionId: runtime.parent_version_id,
          changedSlides: parseJson(runtime.changed_slides_json, []),
          rendererReport: parseJson(runtime.renderer_report_json, null),
          exportReport: parseJson(runtime.export_report_json, null),
          r2Prefix: runtime.r2_prefix,
          isApproved: runtime.is_approved === 1,
        }
      : null,
    spec: full ? parseJson(version.spec_json, {}) : undefined,
  };
}

async function getPresentation(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof getInputSchema>>,
): Promise<unknown> {
  const { project, runtime } = await getProjectForOwner(
    env.DB,
    input.projectId,
    ownerId,
  );
  const full = input.include === "full";
  const latest = await getLatestVersion(env.DB, project.id);
  const jobs = await env.DB.prepare(
    "SELECT * FROM presentation_jobs WHERE project_id = ? " +
      "ORDER BY created_at DESC LIMIT 20",
  ).bind(project.id).all<{
    id: string;
    job_type: string;
    status: string;
    payload_json: string;
    attempt_count: number;
    max_attempts: number;
    available_at: string;
    started_at: string | null;
    finished_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>();
  const issues = await env.DB.prepare(
    "SELECT * FROM presentation_issues WHERE project_id = ? " +
      "AND status != 'resolved' ORDER BY updated_at DESC LIMIT 100",
  ).bind(project.id).all<IssueRow>();
  const artifacts = await env.DB.prepare(
    "SELECT * FROM presentation_artifacts WHERE project_id = ? " +
      "ORDER BY created_at DESC LIMIT 100",
  ).bind(project.id).all<ArtifactRow>();
  const sourcesAndClaims = full
    ? await getSourcesAndClaims(env, project.id)
    : { sources: [], claims: [] };

  return {
    architecture: {
      version: "2.0.0",
      renderer: "dashi",
      openDesignEnabled: false,
      plannerMode: "hybrid-chatgpt-spec-first",
      orchestrator: "cloudflare-workflow",
    },
    project: {
      id: project.id,
      title: project.title,
      brief: project.brief,
      profileId: project.profile_id,
      renderer: project.renderer,
      status: project.status,
      targetScore: project.target_score,
      maxRounds: project.max_rounds,
      currentRound: project.current_round,
      currentScore: project.current_score,
      approvedVersionId: project.approved_version_id,
      sourceSummary: project.source_summary,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    },
    runtime: {
      ownerId: runtime.owner_id,
      workflowRunId: runtime.workflow_run_id,
      randomSeed: runtime.random_seed,
      designDirection: runtime.design_direction,
      requestedFormats: parseJson(runtime.requested_formats_json, ["pptx"]),
      lastError: runtime.last_error,
      blockedReason: runtime.blocked_reason,
    },
    latestVersion: versionSummary(
      latest?.version || null,
      latest?.runtime || null,
      full,
    ),
    jobs: jobs.results.map((job) => ({
      id: job.id,
      type: job.job_type,
      status: job.status,
      payload: parseJson(job.payload_json, {}),
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      availableAt: job.available_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      lastError: job.last_error,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
    issues: issues.results.map((issue) => ({
      id: issue.id,
      versionId: issue.version_id,
      slideId: issue.slide_id,
      severity: issue.severity,
      category: issue.category,
      hardGate: issue.hard_gate === 1,
      message: issue.message,
      recommendation: issue.recommendation,
      status: issue.status,
      firstSeenRound: issue.first_seen_round,
      lastSeenRound: issue.last_seen_round,
    })),
    artifacts: artifacts.results.map((artifact) => ({
      id: artifact.id,
      versionId: artifact.version_id,
      kind: artifact.kind,
      r2Key: artifact.r2_key,
      mimeType: artifact.mime_type,
      byteSize: artifact.byte_size,
      sha256: artifact.sha256,
      expiresAt: artifact.expires_at,
      createdAt: artifact.created_at,
    })),
    sources: sourcesAndClaims.sources,
    claims: sourcesAndClaims.claims,
  };
}

async function requestRevision(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof revisionInputSchema>>,
): Promise<unknown> {
  await assertV2Configuration(env);
  return runIdempotent(
    env.DB,
    ownerId,
    "request_presentation_revision",
    input.idempotencyKey,
    withoutKey(input),
    async () => {
      const { project } = await getProjectForOwner(env.DB, input.projectId, ownerId);
      if (input.versionId) {
        await getVersionForOwner(env.DB, project.id, input.versionId, ownerId);
      }
      return project;
    },
    async (project) => {
      if (project.current_round >= project.max_rounds) {
        throw new Error("MAX_ROUNDS_REACHED: request manual review or change the project plan");
      }
      assertJsonSize(input.specPatch || null, 200_000, "SPEC_PATCH");
      const latest = await getLatestVersion(env.DB, project.id);
      const parentVersionId = input.versionId || latest?.version.id || null;
      const jobId = randomId();
      const payload = {
        parentVersionId,
        slideIds: input.slideIds || [],
        instruction: input.instruction,
        specPatch: input.specPatch || null,
        strategy: "targeted-repair",
        requestedBy: ownerId,
      };
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO presentation_jobs " +
            "(id, project_id, job_type, status, payload_json, max_attempts) " +
            "VALUES (?, ?, 'revision', 'queued', ?, 3)",
        ).bind(jobId, project.id, JSON.stringify(payload)),
        env.DB.prepare(
          "UPDATE presentation_projects SET status = 'revision_queued', updated_at = datetime('now') " +
            "WHERE id = ?",
        ).bind(project.id),
        env.DB.prepare(
          "INSERT INTO presentation_events " +
            "(id, project_id, event_type, payload_json) VALUES (?, ?, 'revision.requested', ?)",
        ).bind(
          randomId(),
          project.id,
          JSON.stringify({
            jobId,
            parentVersionId,
            slideIds: input.slideIds || [],
          }),
        ),
      ]);
      return {
        projectId: project.id,
        jobId,
        status: "queued",
        parentVersionId,
        changedSlides: input.slideIds || [],
        renderer: "dashi",
        next: "get_presentation",
      };
    },
  );
}

function slideArray(spec: JsonObject): Array<Record<string, unknown>> {
  if (!Array.isArray(spec.slides)) return [];
  return spec.slides.filter(
    (slide): slide is Record<string, unknown> =>
      Boolean(slide) && typeof slide === "object" && !Array.isArray(slide),
  );
}

function slideDiff(
  fromSpec: JsonObject,
  toSpec: JsonObject,
): {
  added: string[];
  removed: string[];
  changed: Array<{ slideId: string; fields: string[] }>;
} {
  const from = new Map<string, Record<string, unknown>>();
  const to = new Map<string, Record<string, unknown>>();
  for (const slide of slideArray(fromSpec)) {
    if (typeof slide.id === "string") from.set(slide.id, slide);
  }
  for (const slide of slideArray(toSpec)) {
    if (typeof slide.id === "string") to.set(slide.id, slide);
  }
  const added = [...to.keys()].filter((id) => !from.has(id));
  const removed = [...from.keys()].filter((id) => !to.has(id));
  const changed: Array<{ slideId: string; fields: string[] }> = [];
  for (const [id, next] of to) {
    const previous = from.get(id);
    if (!previous) continue;
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
      .filter((field) => stableStringify(previous[field]) !== stableStringify(next[field]))
      .sort();
    if (fields.length > 0) changed.push({ slideId: id, fields });
  }
  return { added, removed, changed };
}

async function compareVersions(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof compareInputSchema>>,
): Promise<unknown> {
  const from = await getVersionForOwner(
    env.DB,
    input.projectId,
    input.fromVersionId,
    ownerId,
  );
  const to = await getVersionForOwner(
    env.DB,
    input.projectId,
    input.toVersionId,
    ownerId,
  );
  const fromSpec = parseJson<JsonObject>(from.version.spec_json, {});
  const toSpec = parseJson<JsonObject>(to.version.spec_json, {});
  return {
    projectId: input.projectId,
    from: {
      id: from.version.id,
      versionNumber: from.version.version_number,
      score: from.version.score,
      hardGatesPass: from.version.hard_gates_pass === 1,
    },
    to: {
      id: to.version.id,
      versionNumber: to.version.version_number,
      score: to.version.score,
      hardGatesPass: to.version.hard_gates_pass === 1,
    },
    scoreDelta:
      from.version.score !== null && to.version.score !== null
        ? to.version.score - from.version.score
        : null,
    slideDiff: slideDiff(fromSpec, toSpec),
    specChanged: stableStringify(fromSpec) !== stableStringify(toSpec),
  };
}

function approvalDecision(
  project: ProjectRow,
  version: VersionRow,
  policy: Awaited<ReturnType<typeof getQualityPolicy>>,
): { pass: boolean; reasons: string[]; audit: AuditSummary } {
  const audit = parseJson<AuditSummary>(version.audit_json, {});
  const score = version.score ?? audit.totalScore;
  const reasons: string[] = [];
  if (version.hard_gates_pass !== 1 || audit.allHardGatesPass !== true) {
    reasons.push("hard_gates_not_passed");
  }
  if (
    audit.judgesComplete !== true ||
    audit.visualJudgePass !== true ||
    audit.factualJudgePass !== true
  ) {
    reasons.push("visual_and_factual_judges_incomplete");
  }
  if (score === undefined || score < Math.max(project.target_score, policy.targetScore)) {
    reasons.push("total_score_below_target");
  }
  if (
    audit.everySlideScoreMin === undefined ||
    audit.everySlideScoreMin < policy.minimumSlideScore
  ) {
    reasons.push("slide_score_below_target_or_missing");
  }
  const versionSpec = parseJson<{ slides?: unknown }>(version.spec_json, {});
  const expectedSlideIds = specSlideIds(versionSpec);
  const expectedSlideCount = Array.isArray(versionSpec.slides)
    ? versionSpec.slides.length
    : 0;
  if (
    !visualCoverageSatisfied(
      audit.visualCoverage,
      expectedSlideIds,
      expectedSlideCount,
    )
  ) {
    reasons.push("visual_coverage_incomplete");
  }
  if ((audit.blockerCount ?? 0) > 0) reasons.push("blockers_present");
  if ((audit.majorIssueCount ?? 0) > 0) reasons.push("major_issues_present");
  return { pass: reasons.length === 0, reasons, audit };
}

async function approvePresentation(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof approveInputSchema>>,
): Promise<unknown> {
  await assertV2Configuration(env);
  return runIdempotent(
    env.DB,
    ownerId,
    "approve_presentation",
    input.idempotencyKey,
    withoutKey(input),
    async () => {
      const { project } = await getProjectForOwner(env.DB, input.projectId, ownerId);
      return {
        project,
        ...(await getVersionForOwner(
        env.DB,
        project.id,
        input.versionId,
        ownerId,
        )),
      };
    },
    async ({ project, version, runtime }) => {
      const decision = approvalDecision(project, version, await getQualityPolicy(env.DB));
      if (!decision.pass) {
        throw new Error(
          "APPROVAL_BLOCKED: " + JSON.stringify({ reasons: decision.reasons }),
        );
      }
      const approvedScore = version.score ?? decision.audit.totalScore ?? null;
      const approvalId = randomId();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO presentation_approvals " +
            "(id, project_id, version_id, decision, note) VALUES (?, ?, ?, 'approved', ?)",
        ).bind(approvalId, project.id, version.id, input.note || null),
        env.DB.prepare(
          "UPDATE presentation_projects SET status = 'approved', approved_version_id = ?, " +
            "current_score = ?, updated_at = datetime('now') WHERE id = ?",
        ).bind(version.id, approvedScore, project.id),
        env.DB.prepare(
          "UPDATE presentation_version_runtime SET is_approved = 1 WHERE version_id = ?",
        ).bind(version.id),
        env.DB.prepare(
          "INSERT INTO presentation_events " +
            "(id, project_id, event_type, payload_json) VALUES (?, ?, 'version.approved', ?)",
        ).bind(
          randomId(),
          project.id,
          JSON.stringify({
            versionId: version.id,
            ownerId,
            score: version.score,
            hardGatesPass: true,
          }),
        ),
      ]);
      return {
        projectId: project.id,
        versionId: version.id,
        approvalId,
        status: "approved",
        score: approvedScore,
        hardGatesPass: true,
        renderer: "dashi",
        runtimeWasPresent: Boolean(runtime),
        next: "export_presentation",
      };
    },
  );
}

async function exportPresentation(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof exportInputSchema>>,
): Promise<unknown> {
  await assertV2Configuration(env);
  return runIdempotent(
    env.DB,
    ownerId,
    "export_presentation",
    input.idempotencyKey,
    withoutKey(input),
    async () => {
      const { project } = await getProjectForOwner(env.DB, input.projectId, ownerId);
      const approvedVersionId = project.approved_version_id;
      const versionId = input.versionId || approvedVersionId;
      if (!approvedVersionId || !versionId || approvedVersionId !== versionId) {
        throw new Error(
          "EXPORT_REQUIRES_APPROVED_VERSION: approve the exact version before export",
        );
      }
      await getVersionForOwner(env.DB, project.id, versionId, ownerId);
      return { project, versionId };
    },
    async ({ project, versionId }) => {
      const jobId = randomId();
      const payload = {
        versionId,
        formats: input.formats || ["pptx"],
        renderer: "dashi",
        requestedBy: ownerId,
      };
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO presentation_jobs " +
            "(id, project_id, job_type, status, payload_json, max_attempts) " +
            "VALUES (?, ?, 'export', 'queued', ?, 3)",
        ).bind(jobId, project.id, JSON.stringify(payload)),
        env.DB.prepare(
          "UPDATE presentation_projects SET status = 'export_queued', updated_at = datetime('now') " +
            "WHERE id = ?",
        ).bind(project.id),
        env.DB.prepare(
          "INSERT INTO presentation_events " +
            "(id, project_id, event_type, payload_json) VALUES (?, ?, 'export.requested', ?)",
        ).bind(randomId(), project.id, JSON.stringify(payload)),
      ]);
      return {
        projectId: project.id,
        versionId,
        jobId,
        status: "queued",
        renderer: "dashi",
        containerRunner: env.PRESENTATION_RUNNER_STATUS || "pending",
        formats: input.formats || ["pptx"],
        next: "get_presentation",
      };
    },
  );
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < 100; page += 1) {
    const listing = await env.BUCKET.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await env.BUCKET.delete(keys);
      deleted += keys.length;
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return deleted;
}

async function deletePresentation(
  env: Env,
  ownerId: string,
  input: z.infer<z.ZodObject<typeof deleteInputSchema>>,
): Promise<unknown> {
  await assertV2Configuration(env);
  const { project } = await getProjectForOwner(env.DB, input.projectId, ownerId);
  if (!input.confirmationCode) {
    const code = randomToken(9).slice(0, 12);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO presentation_pending_actions " +
        "(code, project_id, action, params_json, expires_at) VALUES (?, ?, 'delete_presentation', ?, ?)",
    )
      .bind(code, project.id, JSON.stringify({ ownerId }), expiresAt)
      .run();
    return {
      projectId: project.id,
      requiresConfirmation: true,
      confirmationCode: code,
      expiresAt,
      warning: "This deletes project metadata, versions, source records, and project R2 objects.",
    };
  }

  const pending = await env.DB.prepare(
    "SELECT code, project_id, action, params_json, expires_at, used_at " +
      "FROM presentation_pending_actions WHERE code = ? AND project_id = ?",
  )
    .bind(input.confirmationCode, project.id)
    .first<{
      code: string;
      project_id: string;
      action: string;
      params_json: string;
      expires_at: string;
      used_at: string | null;
    }>();
  if (
    !pending ||
    pending.action !== "delete_presentation" ||
    pending.used_at ||
    new Date(pending.expires_at).getTime() <= Date.now()
  ) {
    throw new Error("DELETE_CONFIRMATION_INVALID_OR_EXPIRED");
  }
  const params = parseJson<{ ownerId?: string }>(pending.params_json, {});
  if (params.ownerId !== ownerId) throw new Error("DELETE_CONFIRMATION_OWNER_MISMATCH");

  const claimed = await env.DB.prepare(
    "UPDATE presentation_pending_actions SET used_at = datetime('now') " +
      "WHERE code = ? AND used_at IS NULL",
  )
    .bind(pending.code)
    .run();
  if (claimed.meta.changes !== 1) throw new Error("DELETE_CONFIRMATION_ALREADY_USED");

  const prefix = projectPrefix(env, project.id);
  try {
    const deletedObjects = await deleteR2Prefix(env, prefix);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM presentation_profile_memory WHERE source_project_id = ?",
      ).bind(project.id),
      env.DB.prepare("DELETE FROM presentation_approvals WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_artifacts WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_issues WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_jobs WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_events WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_claims WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_sources WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_version_runtime WHERE version_id IN " +
        "(SELECT id FROM presentation_versions WHERE project_id = ?)").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_versions WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_project_runtime WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_pending_actions WHERE project_id = ?").bind(project.id),
      env.DB.prepare("DELETE FROM presentation_projects WHERE id = ?").bind(project.id),
    ]);
    return {
      projectId: project.id,
      deleted: true,
      deletedR2Objects: deletedObjects,
    };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE presentation_pending_actions SET used_at = NULL WHERE code = ?",
    )
      .bind(pending.code)
      .run()
      .catch(() => undefined);
    throw new Error(
      "DELETE_PARTIAL_FAILURE: retry with the same confirmation flow; " +
        (error instanceof Error ? error.message : "unknown error"),
    );
  }
}

export function registerPresentationTools(
  server: McpServer,
  env: Env,
  ownerId: string,
  scopes: string[],
): void {
  const requireWriteScope = (): void => {
    if (!scopes.includes("presentation:write")) {
      throw new Error("INSUFFICIENT_SCOPE: presentation:write is required");
    }
  };

  server.registerTool(
    "list_presentation_profiles",
    {
      description: "List the static v2 Presentation Profiles and their Dashi bindings.",
      inputSchema: {},
    },
    async () => result(await listProfiles(env)),
  );

  server.registerTool(
    "create_presentation",
    {
      description:
        "Create a v2 presentation project, persist source files/claims or a ChatGPT-first slide spec, and queue a controlled Dashi job.",
      inputSchema: createInputSchema,
    },
    async (rawInput) => {
      requireWriteScope();
      const input = rawInput as z.infer<z.ZodObject<typeof createInputSchema>>;
      const output = await runIdempotent(
        env.DB,
        ownerId,
        "create_presentation",
        input.idempotencyKey,
        withoutKey(input),
        async () => undefined,
        () => createPresentation(env, ownerId, input),
      );
      return result(output);
    },
  );

  server.registerTool(
    "get_presentation",
    {
      description:
        "Read project progress, jobs, issues, artifacts, latest version, and optionally the full source/claim map.",
      inputSchema: getInputSchema,
    },
    async (rawInput) => {
      const input = rawInput as z.infer<z.ZodObject<typeof getInputSchema>>;
      return result(await getPresentation(env, ownerId, input));
    },
  );

  server.registerTool(
    "request_presentation_revision",
    {
      description:
        "Queue a targeted revision for the whole deck or selected slide IDs; the Workflow/runner applies the change later.",
      inputSchema: revisionInputSchema,
    },
    async (rawInput) => {
      requireWriteScope();
      const input = rawInput as z.infer<z.ZodObject<typeof revisionInputSchema>>;
      return result(await requestRevision(env, ownerId, input));
    },
  );

  server.registerTool(
    "compare_presentation_versions",
    {
      description:
        "Compare two owned presentation versions by score, hard-gate state, and slide-level spec changes.",
      inputSchema: compareInputSchema,
    },
    async (rawInput) => {
      const input = rawInput as z.infer<z.ZodObject<typeof compareInputSchema>>;
      return result(await compareVersions(env, ownerId, input));
    },
  );

  server.registerTool(
    "approve_presentation",
    {
      description:
        "Approve an owned version only when the recorded audit satisfies the v2 quality contract.",
      inputSchema: approveInputSchema,
    },
    async (rawInput) => {
      requireWriteScope();
      const input = rawInput as z.infer<z.ZodObject<typeof approveInputSchema>>;
      return result(await approvePresentation(env, ownerId, input));
    },
  );

  server.registerTool(
    "export_presentation",
    {
      description:
        "Queue Dashi HTML/PPTX/PDF export for an already approved version; the MCP Worker does not render inline.",
      inputSchema: exportInputSchema,
    },
    async (rawInput) => {
      requireWriteScope();
      const input = rawInput as z.infer<z.ZodObject<typeof exportInputSchema>>;
      return result(await exportPresentation(env, ownerId, input));
    },
  );

  server.registerTool(
    "delete_presentation",
    {
      description:
        "Request or confirm deletion of one owned project. Deletion always requires a short-lived confirmation code.",
      inputSchema: deleteInputSchema,
    },
    async (rawInput) => {
      requireWriteScope();
      const input = rawInput as z.infer<z.ZodObject<typeof deleteInputSchema>>;
      return result(await deletePresentation(env, ownerId, input));
    },
  );
}
