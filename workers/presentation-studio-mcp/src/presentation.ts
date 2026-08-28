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
  beginIdempotency,
  finishIdempotency,
  getLatestVersion,
  getProfile,
  getProjectForOwner,
  getQualityPolicy,
  getVersionForOwner,
  parseJson,
  releaseIdempotency,
  stableStringify,
} from "./db";
import { randomId, randomSeed, randomWorkflowRunId } from "./ids";
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

async function runIdempotent<T>(
  env: Env,
  toolName: string,
  key: string | undefined,
  input: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const reservationState = await beginIdempotency(env.DB, toolName, key, input);
  if (reservationState && "existing" in reservationState) {
    return reservationState.existing as T;
  }
  if (!reservationState || !("reservation" in reservationState)) {
    return action();
  }
  try {
    const output = await action();
    await finishIdempotency(env.DB, reservationState.reservation, output);
    return output;
  } catch (error) {
    await releaseIdempotency(env.DB, reservationState.reservation);
    throw error;
  }
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
          requestedFormats,
        }),
      ),
    );
    await env.DB.batch(statements);
  } catch (error) {
    await deleteKeys(env, uploadedKeys).catch(() => undefined);
    t