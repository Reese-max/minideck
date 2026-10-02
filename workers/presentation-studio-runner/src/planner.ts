import { isUuid } from "./crypto";
import { checkClaimBoundary, runWithClaimBoundary } from "../runner/claim-boundary.mjs";
import type { ClaimedJob, DashiJobResult, JsonObject, RunnerEnv } from "./types";

const MAX_SOURCE_TEXT_BYTES = 160_000;
const MAX_TOTAL_CONTEXT_BYTES = 600_000;

interface ProjectRow {
  title: string;
  brief: string;
  profile_id: string;
}

interface SourceRow {
  id: string;
  file_name: string;
  mime_type: string;
  parsed_text_r2_key: string | null;
}

interface ClaimRow {
  id: string;
  source_id: string;
  claim_text: string;
  source_location: string;
  sensitive: number;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit) + "\n[truncated]";
}

function responseContent(value: unknown): string {
  if (!isObject(value)) return "";
  const choices = value.choices;
  if (!Array.isArray(choices) || !isObject(choices[0])) return "";
  const message = choices[0].message;
  if (!isObject(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is JsonObject => isObject(part) && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  }
  return "";
}

function parseJsonObject(content: string): JsonObject | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isObject(value) ? value : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function normalizeSpec(
  value: JsonObject,
  profileId: string,
  allowedClaimIds: Set<string>,
): JsonObject | null {
  const slides = value.slides;
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > 100) return null;
  const ids = new Set<string>();
  for (const slide of slides) {
    if (!isObject(slide) || typeof slide.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(slide.id)) {
      return null;
    }
    if (ids.has(slide.id)) return null;
    ids.add(slide.id);
    if (
      slide.claims !== undefined &&
      (!Array.isArray(slide.claims) ||
        slide.claims.some((claimId) => typeof claimId !== "string" || !allowedClaimIds.has(claimId)))
    ) {
      return null;
    }
  }
  return {
    ...value,
    schemaVersion: "2.0.0",
    profileId: typeof value.profileId === "string" ? value.profileId : profileId,
  };
}

async function loadContext(env: RunnerEnv, job: ClaimedJob): Promise<{ context: JsonObject; sourceMap: JsonObject }> {
  const project = await env.DB.prepare(
    "SELECT title, brief, profile_id FROM presentation_projects WHERE id = ?",
  ).bind(job.projectId).first<ProjectRow>();
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const [sourceRows, claimRows] = await Promise.all([
    env.DB.prepare(
      "SELECT id, file_name, mime_type, parsed_text_r2_key " +
        "FROM presentation_sources WHERE project_id = ? ORDER BY created_at, id",
    ).bind(job.projectId).all<SourceRow>(),
    env.DB.prepare(
      "SELECT id, source_id, claim_text, source_location, sensitive " +
        "FROM presentation_claims WHERE project_id = ? ORDER BY created_at, id",
    ).bind(job.projectId).all<ClaimRow>(),
  ]);

  const sensitiveSources = new Set(
    claimRows.results
      .filter((claim) => claim.sensitive === 1)
      .map((claim) => claim.source_id),
  );
  const sources: Array<JsonObject> = [];
  let totalBytes = 0;
  for (const source of sourceRows.results) {
    if (!source.parsed_text_r2_key || sensitiveSources.has(source.id)) continue;
    const object = await env.BUCKET.get(source.parsed_text_r2_key);
    if (!object) continue;
    const text = clip(await object.text(), MAX_SOURCE_TEXT_BYTES);
    totalBytes += new TextEncoder().encode(text).byteLength;
    if (totalBytes > MAX_TOTAL_CONTEXT_BYTES) break;
    sources.push({ sourceId: source.id, fileName: source.file_name, mimeType: source.mime_type, text });
  }
  const context: JsonObject = {
    project: { title: project.title, brief: project.brief, profileId: project.profile_id },
    sources,
    claims: claimRows.results
      .filter((claim) => claim.sensitive !== 1)
      .map((claim) => ({
        claimId: claim.id.split(":").slice(1).join(":") || claim.id,
        sourceId: claim.source_id,
        text: claim.claim_text,
        sourceLocation: claim.source_location,
      })),
  };
  const sourceMap = {
    claims: claimRows.results.map((claim) => ({
      claimId: claim.id.split(":").slice(1).join(":") || claim.id,
      text: claim.claim_text,
      sensitive: claim.sensitive,
    })),
  };
  return { context, sourceMap };
}

export async function runPlanner(
  env: RunnerEnv,
  job: ClaimedJob,
): Promise<DashiJobResult> {
  if (!isUuid(job.id) || !isUuid(job.projectId)) {
    return { status: "blocked", jobId: job.id, error: "INVALID_JOB_ID" };
  }
  const endpoint = env.CF_AI_ROUTER_URL?.trim();
  const apiKey = env.CF_AI_ROUTER_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    return {
      status: "blocked",
      jobId: job.id,
      error: "PLANNER_FALLBACK_NOT_CONFIGURED_PROVIDE_CHATGPT_SLIDE_SPEC",
    };
  }
  const loaded = await loadContext(env, job);
  const context = loaded.context;
  const prompt = {
    task: "Create a presentation-spec JSON for Dashi Presentation Studio v2.0.",
    constraints: [
      "Return only one JSON object with a slides array.",
      "Every slide must have a stable id, role, purpose, keyMessage, and claims array.",
      "Use only the supplied source context and claims; do not invent numbers, laws, people, or outcomes.",
      "Keep claim IDs unchanged so a later factual judge can verify them.",
      "If the sources are insufficient, keep the claim set narrow instead of guessing.",
    ],
    context,
  };
  const request = await runWithClaimBoundary({
    spec: { slides: [] },
    sourceMap: loaded.sourceMap,
    sources: context,
  }, () => fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.CF_AI_ROUTER_MODEL?.trim() || "free-general",
      temperature: 0.1,
      max_tokens: 5_000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a conservative presentation planner. Never fabricate evidence. Output valid JSON only.",
        },
        { role: "user", content: JSON.stringify(prompt) },
      ],
    }),
  }));
  if (!request.allowed) {
    return { status: "blocked", jobId: job.id, error: request.reason || "CLAIM_BOUNDARY_BLOCKED" };
  }
  const response = request.value;
  const responseText = await response.text();
  if (!response.ok) {
    return { status: "blocked", jobId: job.id, error: `PLANNER_ROUTER_ERROR_${response.status}` };
  }
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    return { status: "blocked", jobId: job.id, error: "PLANNER_ROUTER_INVALID_JSON" };
  }
  const parsed = parseJsonObject(responseContent(responseJson));
  const allowedClaimIds = new Set(
    Array.isArray(context.claims)
      ? context.claims
          .filter((claim): claim is JsonObject => isObject(claim))
          .map((claim) => claim.claimId)
          .filter((claimId): claimId is string => typeof claimId === "string")
      : [],
  );
  const spec = parsed ? normalizeSpec(parsed, job.profileId, allowedClaimIds) : null;
  if (!spec) {
    return { status: "blocked", jobId: job.id, error: "PLANNER_OUTPUT_INVALID_SLIDE_SPEC" };
  }
  if (!checkClaimBoundary(spec, loaded.sourceMap).pass) {
    return { status: "blocked", jobId: job.id, error: "CLAIM_BOUNDARY_BLOCKED" };
  }
  return { status: "succeeded", jobId: job.id, slideSpec: spec };
}
