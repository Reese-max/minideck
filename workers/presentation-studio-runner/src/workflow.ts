import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { completeFailure, completeJob } from "./mcp-service";
import { loadJobInput } from "./input";
import { DashiContainer } from "./container";
import { runJudges } from "./judges";
import { runPlanner } from "./planner";
import { applyRevisionPatch, runRevisionPlanner } from "./reviser";
import { claimIntegrityCheck, runJudgeIfIntegrityPasses } from "../runner/claim-integrity.mjs";
import type { DashiJobInput, DashiJobResult, JsonObject, RunnerEnv, WorkflowParams } from "./types";

const RETRIES = {
  limit: 2,
  delay: "30 seconds" as const,
  backoff: "exponential" as const,
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class PresentationWorkflow extends WorkflowEntrypoint<RunnerEnv, WorkflowParams> {
  async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<unknown> {
    const job = event.payload.job;
    let result: DashiJobResult | null = null;
    try {
      if (job.type === "plan") {
        result = (await step.do(
          `plan presentation job ${job.id}`,
          { retries: RETRIES, timeout: "10 minutes" },
          async () => runPlanner(this.env, job) as any,
        )) as DashiJobResult;
        return step.do(`complete planned job ${job.id}`, async () => {
          return completeJob(this.env, job, result!) as any;
        });
      }
      let input = (await step.do(
        `load dashi job ${job.id}`,
        { retries: RETRIES, timeout: "5 minutes" },
        async () => loadJobInput(this.env, job) as any,
      )) as DashiJobInput;
      if (claimIntegrityCheck(input).exitCode !== 0) {
        result = { status: "blocked", jobId: job.id, error: "CLAIM_INTEGRITY_FAILED" };
      }
      if (!result && job.type === "revision") {
        const suppliedPatch = isObject(input.payload.specPatch) ? input.payload.specPatch : null;
        if (suppliedPatch) {
          const patchedInput = applyRevisionPatch(input, suppliedPatch);
          if (!patchedInput) {
            result = {
              status: "blocked",
              jobId: job.id,
              error: "REVISION_SPEC_PATCH_INVALID_OR_SOURCE_SLIDE_IDS_MISSING",
            };
          } else {
            input = patchedInput;
          }
        } else {
          const revisionPlan = await step.do(
            `plan revision for job ${job.id}`,
            { retries: RETRIES, timeout: "10 minutes" },
            async () => runRevisionPlanner(this.env, input) as any,
          ) as Awaited<ReturnType<typeof runRevisionPlanner>>;
          if (revisionPlan.status !== "succeeded" || !revisionPlan.specPatch) {
            result = {
              status: "blocked",
              jobId: job.id,
              error: revisionPlan.error || "REVISION_PLANNER_BLOCKED",
            };
          } else {
            const patchedInput = applyRevisionPatch(input, revisionPlan.specPatch);
            if (!patchedInput) {
              result = {
                status: "blocked",
                jobId: job.id,
                error: "REVISION_OUTPUT_INVALID_SPEC_PATCH",
              };
            } else {
              input = patchedInput;
            }
          }
        }
      }
      const executionInput = input;
      if (!result) {
        result = (await step.do(
          `execute dashi job ${job.id}`,
          { retries: RETRIES, timeout: "35 minutes" },
          async () => {
            const container = getContainer<DashiContainer>(
              this.env.DASHI_CONTAINER,
              `presentation-job-${job.id}`,
            );
            return container.runJob(executionInput) as any;
          },
        )) as DashiJobResult;
      }
      if (result.status === "succeeded" && result.version) {
        const rendererResult = result;
        const judged = await runJudgeIfIntegrityPasses(
          rendererResult,
          async () =>
            (await step.do(
              `judge dashi job ${job.id}`,
              { retries: RETRIES, timeout: "10 minutes" },
              async () => runJudges(this.env, executionInput, rendererResult) as any,
            )) as DashiJobResult,
        );
        result = judged ?? {
          status: "blocked",
          jobId: job.id,
          error: "CLAIM_INTEGRITY_FAILED",
        };
      }
    } catch (error) {
      return step.do(`record failed job ${job.id}`, async () => {
        return completeFailure(this.env, job, error) as any;
      });
    }

    return step.do(`complete dashi job ${job.id}`, async () => {
      return completeJob(this.env, job, result!) as any;
    });
  }
}
