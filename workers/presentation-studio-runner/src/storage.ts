import { isSafeKind, isUuid, jsonResponse, sha256Hex } from "./crypto";
import {
  CURRENT_STORAGE_ATTEMPT_SQL,
  buildAttemptScopedArtifactKey,
} from "./storage-lease.mjs";
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

// Additional visual-judge contact sheets upload as preview-2..preview-5 so
// decks beyond one 20-tile sheet keep fixed, derived artifact kinds; the bound
// matches MAX_PREVIEW_SHEETS for the 100-slide contract (5 x 20 tiles).
const PREVIEW_SHEET_KIND = /^preview-[2-5]$/;

function artifactDescriptor(kind: string): { fileName: string; mimeType: string } | null {
  const fixed = ARTIFACTS[kind];
  if (fixed) return fixed;
  if (PREVIEW_SHEET_KIND.test(kind)) {
    return { fileName: `${kind}.png`, mimeType: "image/png" };
  }
  return null;
}

function projectPrefix(env: Env, projectId: string): string {
  const configured = env.R2_PREFIX?.trim() || "presentation-studio/";
  const prefix = configured.endsWith("/") ? configured : configured + "/";
  return `${prefix}projects/${projectId}/`;
}

function isRunningJobId(
  env: RunnerEnv,
  jobId: string,
  attemptCount: number,
): Promise<{ project_id: string } | null> {
  return env.DB.prepare(CURRENT_STORAGE_ATTEMPT_SQL)
    .bind(jobId, attemptCount)
    .first<{ project_id: string }>();
}

/**
 * Handles only requests emitted by the Dashi container's fixed outbound host.
 * The host is not routed from the public Worker fetch handler.
 */
export async function handleContainerStorage(request: Request, env: RunnerEnv): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "storage") {
    return jsonResponse({ error: "storage_route_not_found" }, 404);
  }
  if (request.method !== "PUT") return jsonResponse({ error: "storage_method_not_allowed" }, 405);
  const [, jobId, rawAttemptCount, kind] = segments;
  const attemptCount = Number(rawAttemptCount);
  const descriptor = isSafeKind(kind) ? artifactDescriptor(kind) : null;
  if (
    !isUuid(jobId) ||
    !/^[1-9]\d*$/.test(rawAttemptCount) ||
    !Number.isSafeInteger(attemptCount) ||
    !descriptor
  ) {
    return jsonResponse({ error: "storage_artifact_not_allowed" }, 400);
  }
  const job = await isRunningJobId(env, jobId, attemptCount);
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

  const r2Key = buildAttemptScopedArtifactKey(
    projectPrefix(env, job.project_id),
    jobId,
    attemptCount,
    descriptor.fileName,
  );
  const digest = await sha256Hex(bytes);
  await env.BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: descriptor.mimeType },
    customMetadata: { jobId, attemptCount: String(attemptCount), kind, sha256: digest },
  });
  return jsonResponse({
    kind,
    r2Key,
    mimeType: descriptor.mimeType,
    byteSize: bytes.byteLength,
    sha256: digest,
  });
}
