import { isSafeKind, isUuid, jsonResponse, sha256Hex } from "./crypto";
import type { RunnerEnv } from "./types";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const ARTIFACTS: Record<
  string,
  { fileName: string; mimeType: string }
> = {
  goal: { fileName: "goal.json", mimeType: "application/json" },
  html: { fileName: "index.html", mimeType: "text/html" },
  audit: { fileName: "audit.json", mimeType: "application/json" },
  quality: { fileName: "quality.json", mimeType: "application/json" },
  preview: { fileName: "preview.png", mimeType: "image/png" },
  pptx: {
    fileName: "deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  pdf: { fileName: "deck.pdf", mimeType: "application/pdf" },
};

function projectPrefix(env: Env, projectId: string): string {
  const configured = env.R2_PREFIX?.trim() || "presentation-studio/";
  const prefix = configured.endsWith("/") ? configured : configured + "/";
  return `${prefix}projects/${projectId}/`;
}

function isRunningJobId(env: RunnerEnv, jobId: string): Promise<{ project_id: string } | null> {
  return env.DB.prepare(
    "SELECT project_id FROM presentation_jobs " +
      "WHERE id = ? AND status = 'running' AND leased_until > datetime('now')",
  ).bind(jobId).first<{ project_id: string }>();
}

/**
 * Handles only requests emitted by the Dashi container's fixed outbound host.
 * The host is not routed from the public Worker fetch handler.
 */
export async function handleContainerStorage(request: Request, env: RunnerEnv): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "storage") {
    return jsonResponse({ error: "storage_route_not_found" }, 404);
  }
  if (request.method !== "PUT") return jsonResponse({ error: "storage_method_not_allowed" }, 405);
  const [, jobId, kind] = segments;
  if (!isUuid(jobId) || !isSafeKind(kind) || !ARTIFACTS[kind]) {
    return jsonResponse({ error: "storage_artifact_not_allowed" }, 400);
  }
  const job = await isRunningJobId(env, jobId);
  if (!job) return jsonResponse({ error: "storage_job_not_running" }, 409);

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number.parseInt(lengthHeader, 10);
    if (!Number.isInteger(length) || length < 0 || length > MAX_ARTIFACT_BYTES) {
      return jsonResponse({ error: "storage_artifact_too_large" }, 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return jsonResponse({ error: "storage_artifact_too_large" }, 413);
  }

  const descriptor = ARTIFACTS[kind];
  const r2Key = `${projectPrefix(env, job.project_id)}jobs/${jobId}/${descriptor.fileName}`;
  const digest = await sha256Hex(bytes);
  await env.BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: descriptor.mimeType },
    customMetadata: { jobId, kind, sha256: digest },
  });
  return jsonResponse({
    kind,
    r2Key,
    mimeType: descriptor.mimeType,
    byteSize: bytes.byteLength,
    sha256: digest,
  });
}
