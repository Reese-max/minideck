import { isUuid } from "./crypto";
import type {
  ClaimedJob,
  DashiJobInput,
  JsonObject,
  ProfileInput,
  RunnerEnv,
  SourceInput,
} from "./types";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SPEC_BYTES = 1_000_000;

interface ProjectRow {
  id: string;
  title: string;
  brief: string;
  profile_id: string;
}

interface RuntimeRow {
  workflow_run_id: string | null;
  random_seed: string | null;
  requested_formats_json: string;
}

interface VersionRow {
  id: string;
  spec_json: string;
}

interface ProfileRow {
  id: string;
  design_markdown: string;
  quality_json: string;
  renderer_binding_json: string;
}

interface SourceRow {
  id: string;
  file_name: string;
  mime_type: string;
  r2_key: string;
  sha256: string | null;
  byte_size: number | null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function projectPrefix(configuredValue: string, projectId: string): string {
  const configured = configuredValue || "presentation-studio/";
  const prefix = configured.endsWith("/") ? configured : configured + "/";
  return `${prefix}projects/${projectId}/`;
}

function assertObjectSize(value: unknown, maxBytes: number, label: string): void {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > maxBytes) throw new Error(`${label}_TOO_LARGE`);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRequestedFormats(value: unknown): string[] {
  if (!Array.isArray(value)) return ["pptx"];
  return value.filter((item): item is string =>
    item === "html" || item === "pptx" || item === "pdf",
  );
}

async function readSource(
  env: RunnerEnv,
  source: SourceRow,
  prefix: string,
): Promise<SourceInput> {
  if (!source.r2_key.startsWith(prefix)) {
    throw new Error("SOURCE_KEY_PROJECT_MISMATCH");
  }
  const object = await env.BUCKET.head(source.r2_key);
  if (!object) throw new Error(`SOURCE_OBJECT_NOT_FOUND:${source.id}`);
  if (object.size > MAX_SOURCE_BYTES) throw new Error(`SOURCE_TOO_LARGE:${source.id}`);
  return {
    sourceId: source.id.split(":").slice(1).join(":") || source.id,
    fileName: source.file_name,
    mimeType: source.mime_type,
    r2Key: source.r2_key,
    byteSize: object.size,
    sha256: source.sha256,
  };
}

export async function loadJobInput(
  env: RunnerEnv,
  job: ClaimedJob,
): Promise<DashiJobInput> {
  if (!isUuid(job.id) || !isUuid(job.projectId)) throw new Error("INVALID_JOB_ID");
  const prefix = projectPrefix(env.R2_PREFIX?.trim() || "presentation-studio/", job.projectId);
  const project = await env.DB.prepare(
    "SELECT id, title, brief, profile_id FROM presentation_projects WHERE id = ?",
  ).bind(job.projectId).first<ProjectRow>();
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (project.profile_id !== job.profileId) throw new Error("JOB_PROFILE_MISMATCH");
  if (job.renderer !== "dashi") throw new Error("UNSUPPORTED_RENDERER");

  const [runtime, profile, sourceRows] = await Promise.all([
    env.DB.prepare(
      "SELECT workflow_run_id, random_seed, requested_formats_json " +
        "FROM presentation_project_runtime WHERE project_id = ?",
    ).bind(job.projectId).first<RuntimeRow>(),
    env.DB.prepare(
      "SELECT id, design_markdown, quality_json, renderer_binding_json " +
        "FROM presentation_profiles WHERE id = ?",
    ).bind(job.profileId).first<ProfileRow>(),
    env.DB.prepare(
      "SELECT id, file_name, mime_type, r2_key, sha256, byte_size " +
        "FROM presentation_sources WHERE project_id = ? ORDER BY created_at, id",
    ).bind(job.projectId).all<SourceRow>(),
  ]);
  if (!runtime) throw new Error("PROJECT_RUNTIME_NOT_FOUND");
  if (!profile) throw new Error("PROFILE_NOT_FOUND");

  const payload = isObject(job.payload) ? job.payload : {};
  const requestedVersionId =
    typeof payload.versionId === "string" ? payload.versionId :
    typeof payload.parentVersionId === "string" ? payload.parentVersionId : null;
  const version = requestedVersionId
    ? await env.DB.prepare(
        "SELECT id, spec_json FROM presentation_versions " +
          "WHERE id = ? AND project_id = ?",
      ).bind(requestedVersionId, job.projectId).first<VersionRow>()
    : await env.DB.prepare(
        "SELECT id, spec_json FROM presentation_versions " +
          "WHERE project_id = ? ORDER BY version_number DESC LIMIT 1",
      ).bind(job.projectId).first<VersionRow>();
  if (requestedVersionId && !version) throw new Error("VERSION_NOT_FOUND");

  const sources: SourceInput[] = [];
  let sourceBytes = 0;
  for (const source of sourceRows.results) {
    sourceBytes += source.byte_size || 0;
    if (sourceBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error("TOTAL_SOURCE_BYTES_EXCEEDED");
    sources.push(await readSource(env, source, prefix));
  }

  const sourceMapObject = await env.BUCKET.get(prefix + "source-map.json");
  const sourceMap = sourceMapObject
    ? parseJson<JsonObject>(await sourceMapObject.text(), {})
    : {};
  const spec = version ? parseJson<JsonObject>(version.spec_json, {}) : null;
  if (spec) assertObjectSize(spec, MAX_SPEC_BYTES, "SLIDE_SPEC");

  const profileInput: ProfileInput = {
    id: profile.id,
    designGuidelines: profile.design_markdown,
    qualityPolicy: parseJson<JsonObject>(profile.quality_json, {}),
    rendererBinding: parseJson<JsonObject>(profile.renderer_binding_json, {}),
  };

  return {
    jobId: job.id,
    projectId: job.projectId,
    type: job.type,
    title: project.title,
    brief: project.brief,
    workflowRunId: runtime.workflow_run_id,
    randomSeed: runtime.random_seed,
    profile: profileInput,
    spec,
    sourceMap,
    sources,
    payload,
    parentVersionId:
      typeof payload.parentVersionId === "string"
        ? payload.parentVersionId
        : version?.id || null,
    changedSlides: Array.isArray(payload.slideIds)
      ? payload.slideIds.filter((item): item is string => typeof item === "string")
      : [],
    requestedFormats: asRequestedFormats(payload.formats || parseJson(runtime.requested_formats_json, ["pptx"])),
  };
}
