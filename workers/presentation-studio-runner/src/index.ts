import { claimJobs } from "./mcp-service";
import { DashiContainer } from "./container";
import { PresentationWorkflow } from "./workflow";
import type { RunnerEnv } from "./types";

export { DashiContainer, PresentationWorkflow };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function dispatchJobs(env: RunnerEnv): Promise<{ claimed: number; started: number }> {
  const requested = Number.parseInt(env.MAX_CLAIM_BATCH || "5", 10);
  const jobs = await claimJobs(env, Number.isFinite(requested) ? requested : 5);
  let started = 0;
  for (const job of jobs) {
    try {
      await env.PRESENTATION_WORKFLOW.create({
        id: `presentation-job-${job.id}-attempt-${job.attemptCount}`,
        params: { job },
      });
      started += 1;
    } catch (error) {
      // Leave the lease to expire so the MCP job queue can safely retry it.
      console.error("workflow_start_failed", job.id, error);
    }
  }
  return { claimed: jobs.length, started };
}

const handler: ExportedHandler<RunnerEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "presentation-studio-runner",
        architecture: "2.0.0",
        renderer: "dashi",
        openDesignEnabled: false,
        pollingEnabled: env.POLLING_ENABLED === "true",
        workflow: "presentation-workflow",
        container: "DashiContainer",
      });
    }
    return jsonResponse({ error: "runner_internal_only" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    if (env.POLLING_ENABLED !== "true") return;
    ctx.waitUntil(
      dispatchJobs(env).catch((error) => {
        console.error("job_dispatch_failed", error);
      }),
    );
  },
};

export default handler;
