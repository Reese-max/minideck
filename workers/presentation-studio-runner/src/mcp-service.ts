import { jsonResponse } from "./crypto";
import type { ClaimedJob, DashiJobResult, JobType, JsonObject, RunnerEnv } from "./types";

const SERVICE_ORIGIN = "https://presentation-studio-mcp.internal";

// A completion rejected because the lease moved on is terminal: the fenced
// state must not burn Workflow step retries or fail the instance.
const TERMINAL_JOB_ERRORS = new Set([
  "job_lease_not_current",
  "job_lease_expired",
  "job_not_running",
]);

async function callMcpService(
  env: RunnerEnv,
  path: string,
  body: JsonObject,
): Promise<JsonObject> {
  const token = env.PRESENTATION_RUNNER_TOKEN?.trim();
  if (!token) throw new Error("PRESENTATION_RUNNER_TOKEN_MISSING");
  const response = await env.MCP_SERVICE.fetch(
    new Request(SERVICE_ORIGIN + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`MCP_SERVICE_INVALID_JSON:${response.status}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP_SERVICE_ERROR:${response.status}`);
  }
  if (!response.ok) {
    const error = (value as JsonObject).error;
    if (response.status === 409 && TERMINAL_JOB_ERRORS.has(String(error))) {
      return value as JsonObject;
    }
    throw new Error(`MCP_SERVICE_ERROR:${response.status}`);
  }
  return value as JsonObject;
}

export async function claimJobs(
  env: RunnerEnv,
  limit: number,
): Promise<ClaimedJob[]> {
  const body = await callMcpService(env, "/internal/jobs/claim", {
    limit: Math.max(1, Math.min(10, Math.floor(limit))),
    jobTypes: ["plan", "render", "revision", "export"] satisfies JobType[],
  });
  if (!Array.isArray(body.jobs)) return [];
  return body.jobs.filter((job): job is ClaimedJob => {
    if (!job || typeof job !== "object" || Array.isArray(job)) return false;
    const value = job as Record<string, unknown>;
    return (
      typeof value.id === "string" &&
      typeof value.attemptCount === "number" &&
      Number.isInteger(value.attemptCount) &&
      typeof value.projectId === "string" &&
      typeof value.type === "string" &&
      ["plan", "render", "revision", "export"].includes(value.type) &&
      Boolean(value.payload) &&
      typeof value.payload === "object" &&
      !Array.isArray(value.payload)
    );
  });
}

export async function renewJob(
  env: RunnerEnv,
  job: ClaimedJob,
  minimumSeconds: number,
): Promise<void> {
  if (!Number.isInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 3600) {
    throw new Error("MCP_SERVICE_INVALID_RENEWAL_WINDOW");
  }
  const requestedAt = performance.now();
  const body = await callMcpService(env, "/internal/jobs/renew", {
    jobId: job.id,
    attemptCount: job.attemptCount,
  });
  if (typeof body.error === "string" && TERMINAL_JOB_ERRORS.has(body.error)) {
    throw new Error("job_lease_not_current");
  }
  if (body.status !== "renewed" || body.jobId !== job.id ||
    body.attemptCount !== job.attemptCount || typeof body.leaseSeconds !== "number" ||
    !Number.isInteger(body.leaseSeconds) || body.leaseSeconds <= 0 || body.leaseSeconds > 3600) {
    throw new Error("MCP_SERVICE_INVALID_RENEWAL");
  }
  // A final bounded horizon cannot admit a callback longer than its remaining lease.
  const requestSeconds = Math.ceil((performance.now() - requestedAt) / 1000);
  if (body.leaseSeconds - requestSeconds < minimumSeconds) throw new Error("job_lease_not_current");
}

export async function completeJob(
  env: RunnerEnv,
  job: ClaimedJob,
  result: DashiJobResult,
): Promise<JsonObject> {
  const body: JsonObject = {
    jobId: job.id,
    attemptCount: job.attemptCount,
    status: result.status,
  };
  if (result.status === "succeeded") {
    if (job.type === "plan") {
      body.slideSpec = result.slideSpec;
    } else if (job.type === "render" || job.type === "revision") {
      body.version = result.version;
      body.rendererReport = result.rendererReport;
      if (result.artifacts) body.artifacts = result.artifacts;
    } else if (job.type === "export") {
      body.artifacts = result.artifacts;
      body.exportReport = result.exportReport;
    }
  } else {
    body.error = result.error || "runner_blocked";
  }
  return callMcpService(env, "/internal/jobs/complete", body);
}

export async function completeFailure(
  env: RunnerEnv,
  job: ClaimedJob,
  error: unknown,
): Promise<JsonObject> {
  const message = error instanceof Error ? error.message : "runner_failed";
  return callMcpService(env, "/internal/jobs/complete", {
    jobId: job.id,
    attemptCount: job.attemptCount,
    status: "failed",
    error: message.slice(0, 3_500),
  });
}

export function unavailableResponse(): Response {
  return jsonResponse({ error: "runner_internal_only" }, 404);
}
