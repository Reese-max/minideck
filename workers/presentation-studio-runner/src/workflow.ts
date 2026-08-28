import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { completeFailure, completeJob } from "./mcp-service";
import { loadJobInput } from "./input";
import { DashiContainer } from "./container";
import { runJudges } from "./judges";
import { runPlanner } from "./planner";
import type { DashiJobResult, RunnerEnv, WorkflowParams } from "./types";

const RETRIES = {
  limit: 2,
  delay: "30 seconds" as const,
  backoff: "exponential" as const,
};

export class PresentationWorkflow extends WorkflowEntrypoint<RunnerEnv, WorkflowParams> {
  async run(event: Readonly<WorkflowEvent<WorkflowParams>>, step: WorkflowStep): Promise<unknown> {
    const job = event.payload.job;
    let result: DashiJobResult;
    try {
      if (job.type === "plan") {
        result = (await step.do(
          `plan presentation job ${job.id}`,
          { retries: RETRIES, timeout: "10 minutes" },
          async () => runPlanner(this.env, job) as any,
        )) as DashiJobResult;
        return step.do(`complete planned job ${job.id}`, async () => {
          return completeJob(this.env, job, result) as any;
        });
      }
      result = (await step.do(
        `execute dashi job ${job.id}`,
        { retries: RETRIES, timeout: "35 minutes" },
        async () => {
          const input = await loadJobInput(this.env, job);
          const container = getContainer<DashiContainer>(
            this.env.DASHI_CONTAINER,
            `presentation-job-${job.id}`,
          );
          return container.runJob(input) as any;
        },
      )) as DashiJobResult;
      if (result.status === "succeeded" && result.version) {
        const rendererResult = result;
        result = (await step.do(
          `judge dashi job ${job.id}`,
          { retries: RETRIES, timeout: "10 minutes" },
          async () => {
            const input = await loadJobInput(this.env, job);
            return runJudges(this.env, input, rendererResult) as any;
          },
        )) as DashiJobResult;
      }
    } catch (error) {
      return step.do(`record failed job ${job.id}`, async () => {
        return completeFailure(this.env, job, error) as any;
      });
    }

    return step.do(`complete dashi job ${job.id}`, async () => {
      return completeJob(this.env, job, result) as any;
    });
  }
}
