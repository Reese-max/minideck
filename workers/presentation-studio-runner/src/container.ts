import { Container } from "@cloudflare/containers";
import type { DashiJobInput, DashiJobResult, RunnerEnv } from "./types";
import { handleContainerStorage } from "./storage";

const EXEC_TIMEOUT_MS = 30 * 60 * 1000;

export class DashiContainer extends Container<RunnerEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    NODE_ENV: "production",
    CHROME_PATH: "/usr/bin/chromium",
    DASHI_STORAGE_HOST: "presentation-studio.internal",
  };

  async runJob(input: DashiJobInput): Promise<DashiJobResult> {
    if (!this.ctx.container?.running) await this.start();
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    });
    const command = await this.ctx.container!.exec(
      ["node", "/app/runner/execute-job.mjs"],
      {
        stdin,
        stdout: "pipe",
        stderr: "combined",
      },
    );
    const timeout = setTimeout(() => {
      void command.kill();
    }, EXEC_TIMEOUT_MS);
    try {
      const output = await command.output();
      const exitCode = await command.exitCode;
      const text = await new Response(output.stdout).text();
      const lastLine = text.trim().split("\n").filter(Boolean).at(-1);
      if (exitCode !== 0) {
        throw new Error(`DASHI_COMMAND_FAILED:${exitCode}:${text.slice(-2_000)}`);
      }
      if (!lastLine) throw new Error("DASHI_RESULT_EMPTY");
      const result = JSON.parse(lastLine) as DashiJobResult;
      if (!result || result.jobId !== input.jobId) throw new Error("DASHI_RESULT_INVALID");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

DashiContainer.outboundByHost = {
  "presentation-studio.internal": handleContainerStorage,
};
